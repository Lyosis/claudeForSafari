#!/usr/bin/env node
/**
 * Claude for Safari — MCP Bridge
 *
 * Architecture:
 *   Claude (MCP stdio) ←→ bridge.js ←→ WebSocket ←→ Safari Extension(s)
 *
 * Supports multiple bridge instances (Claude Desktop often starts several):
 * - The first instance to bind port 45678 becomes the PRIMARY (WebSocket server).
 * - Subsequent instances become RELAY clients: they forward MCP tool calls
 *   to the primary via a relay WebSocket connection on the same port.
 */

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const readline = require('readline');

const WS_PORT = 45678;
// Loopback only — never reachable from the network. Both families are needed:
// Safari resolves "localhost" to ::1 first, other clients may use 127.0.0.1.
const LOOPBACK_HOSTS = ['::1', '127.0.0.1'];
// Browsers always send Origin on a WebSocket handshake and pages cannot forge it,
// so any Origin other than a Safari extension's is a web page and is refused.
// Clients without Origin are local processes (relay bridges) — trusted, see README.
// The extension UUID is random per install: match the scheme, case-insensitively.
const EXTENSION_ORIGIN = /^safari-web-extension:\/\//i;
const MCP_VERSION = '2024-11-05';

// ── Shared state ───────────────────────────────────────────────────────────
// profileName → sockets registered under that name, most recent last (primary only).
// Commands go to the most recent open one; when it closes, the previous one takes over.
const profiles = new Map();
const pending = new Map();     // id → { ws, resolve, reject } — ws: socket the command was sent to

// ── Relay state (used when this instance is NOT the primary) ───────────────
let relayWs = null;            // WebSocket connection to the primary bridge
let isRelay = false;           // true when running as a relay instance

// ── PRIMARY mode: WebSocket server ────────────────────────────────────────

function startPrimary() {
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', onConnection);

  const listening = [];
  let remaining = LOOPBACK_HOSTS.length;
  let portTaken = false;

  // Called once per host, after it either listens or fails to.
  // The primary role needs the port on every available loopback address:
  // if any of them is taken, release the others and become a relay.
  const settle = () => {
    if (--remaining > 0) return;
    if (portTaken || listening.length === 0) {
      for (const server of listening) server.close();
      if (portTaken) {
        log(`Port ${WS_PORT} taken — starting as relay in 1 s...`);
        setTimeout(startRelay, 1000);
      } else {
        log(`WebSocket server error: no loopback address available on port ${WS_PORT}`);
      }
      return;
    }
    const addresses = listening.map(s => {
      const { address, family } = s.address();
      return family === 'IPv6' ? `[${address}]:${WS_PORT}` : `${address}:${WS_PORT}`;
    });
    log(`PRIMARY — WebSocket server on ${addresses.join(' and ')} (loopback only)`);
  };

  for (const host of LOOPBACK_HOSTS) {
    const server = http.createServer((req, res) => res.writeHead(426).end());
    let started = false;

    server.on('upgrade', (req, socket, head) => {
      const { origin } = req.headers;
      if (origin !== undefined && !EXTENSION_ORIGIN.test(origin)) {
        log(`Refused connection from origin "${clean(origin, 100)}"`);
        socket.on('error', () => {});
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });

    server.on('error', (err) => {
      if (started) { log('WebSocket server error: ' + err.message); return; }
      started = true;
      if (err.code === 'EADDRINUSE') portTaken = true;
      else log(`Cannot listen on ${host}: ${err.message}`); // e.g. IPv6 disabled
      settle();
    });

    server.listen(WS_PORT, host, () => {
      started = true;
      listening.push(server);
      settle();
    });
  }
}

function onConnection(ws, req) {
  const origin = req.headers.origin;
  let profileName = null;
  let isRelayClient = false;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // ── Relay client handshake ──────────────────────────────────────────
    if (msg.type === 'bridge_relay') {
      isRelayClient = true;
      log('Relay bridge connected');
      return;
    }

    // ── Relay command forwarded from a secondary bridge ─────────────────
    if (isRelayClient && msg.type === 'relay_cmd') {
      const { id, command, params, profile } = msg;

      if (command === 'list_profiles') {
        ws.send(JSON.stringify({ type: 'relay_result', id, success: true, result: listProfiles() }));
        return;
      }

      callExtension(command, params, profile || null)
        .then(result => ws.send(JSON.stringify({ type: 'relay_result', id, success: true, result })))
        .catch(err  => ws.send(JSON.stringify({ type: 'relay_result', id, success: false, error: err.message })));
      return;
    }

    // ── Keepalive ping from extension ───────────────────────────────────
    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    // ── Safari extension registration ───────────────────────────────────
    if (msg.type === 'connected') {
      if (profileName) unregister(profileName, ws);
      profileName = clean(msg.profile || 'default', 50) || 'default';
      const via = origin === undefined ? 'no origin' : `origin ${clean(origin, 100)}`;
      profiles.has(profileName)
        ? log(`Profile "${profileName}" reconnected (${via})`)
        : log(`Profile "${profileName}" connected (${via})`);
      profiles.set(profileName, [...(profiles.get(profileName) ?? []), ws]);
      return;
    }

    // ── Response to a pending command ───────────────────────────────────
    // Only the socket the command was sent to may answer it.
    const entry = pending.get(msg.id);
    if (!entry || entry.ws !== ws) return;
    pending.delete(msg.id);
    if (msg.success) entry.resolve(msg.result);
    else entry.reject(new Error(msg.error || 'Extension error'));
  });

  ws.on('close', () => {
    if (isRelayClient) { log('Relay bridge disconnected'); return; }
    if (profileName) {
      unregister(profileName, ws);
      const left = profiles.get(profileName)?.length ?? 0;
      log(left
        ? `Profile "${profileName}" socket closed — ${left} other socket(s) still registered`
        : `Profile "${profileName}" disconnected`);
    }
    for (const [id, entry] of pending) {
      if (entry.ws === ws) {
        pending.delete(id);
        entry.reject(new Error(`Safari profile "${profileName}" disconnected`));
      }
    }
  });

  ws.on('error', (err) => log('Client WebSocket error: ' + err.message));
}

function unregister(name, ws) {
  const rest = (profiles.get(name) ?? []).filter(s => s !== ws);
  rest.length ? profiles.set(name, rest) : profiles.delete(name);
}

function activeSocket(name) {
  return (profiles.get(name) ?? []).findLast(s => s.readyState === WebSocket.OPEN) ?? null;
}

function listProfiles() {
  return [...profiles.keys()].map(name => ({
    name, status: activeSocket(name) ? 'connected' : 'disconnected'
  }));
}

// ── RELAY mode: connect to the primary bridge ──────────────────────────────

function startRelay() {
  relayWs = new WebSocket(`ws://localhost:${WS_PORT}`);

  relayWs.on('open', () => {
    isRelay = true;
    relayWs.send(JSON.stringify({ type: 'bridge_relay' }));
    log('RELAY — connected to primary bridge');
  });

  relayWs.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type !== 'relay_result') return;

    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.success) entry.resolve(msg.result);
    else entry.reject(new Error(msg.error || 'Relay error'));
  });

  relayWs.on('close', () => {
    log('Relay connection lost — retrying as primary in 3 s...');
    isRelay = false;
    relayWs = null;
    // Reject any commands that were waiting on the primary's response.
    for (const [id, entry] of pending) {
      if (id.startsWith('relay_')) {
        pending.delete(id);
        entry.reject(new Error('Relay disconnected from primary bridge'));
      }
    }
    setTimeout(startPrimary, 3000);
  });

  relayWs.on('error', () => {
    // error is always followed by close; handled above
  });
}

// ── Start ──────────────────────────────────────────────────────────────────
startPrimary();

// ── Extension / relay command dispatch ────────────────────────────────────

function resolveWs(profileParam) {
  if (profiles.size === 0) {
    throw new Error(
      'Safari extension not connected. ' +
      'Open Safari, enable the "Claude for Safari" extension, and try again.'
    );
  }
  if (profileParam) {
    if (!profiles.has(profileParam)) {
      const available = [...profiles.keys()].join(', ');
      throw new Error(`Profile "${profileParam}" not connected. Available: ${available}`);
    }
    return { ws: activeSocket(profileParam), profileName: profileParam };
  }
  const [name] = profiles.keys();
  return { ws: activeSocket(name), profileName: name };
}

function callExtension(command, params = {}, profileParam = null) {
  // ── Relay mode: forward to primary ──────────────────────────────────────
  if (isRelay) {
    return new Promise((resolve, reject) => {
      if (!relayWs || relayWs.readyState !== WebSocket.OPEN) {
        return reject(new Error('Relay not connected to primary bridge'));
      }
      const id = `relay_${crypto.randomUUID()}`;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Relay command "${command}" timed out`));
      }, 30_000);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timeout); resolve(v); },
        reject:  (e) => { clearTimeout(timeout); reject(e); }
      });
      relayWs.send(JSON.stringify({ type: 'relay_cmd', id, command, params, profile: profileParam }));
    });
  }

  // ── Primary mode: send directly to extension ─────────────────────────────
  return new Promise((resolve, reject) => {
    let resolved;
    try { resolved = resolveWs(profileParam); } catch (e) { return reject(e); }
    const { ws, profileName } = resolved;

    if (!ws) {
      return reject(new Error(`Profile "${profileName}" WebSocket is not open`));
    }

    // Unguessable, so another client cannot answer in the extension's place.
    const id = `cmd_${crypto.randomUUID()}`;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Command "${command}" timed out after 30 s`));
    }, 30_000);

    pending.set(id, {
      ws,
      resolve: (v) => { clearTimeout(timeout); resolve(v); },
      reject:  (e) => { clearTimeout(timeout); reject(e); }
    });

    ws.send(JSON.stringify({ id, command, params }));
  });
}

// ── MCP Tool definitions ───────────────────────────────────────────────────

const PROFILE_PROP = {
  profile: {
    type: 'string',
    description: 'Safari profile name (e.g. "Perso", "Pro"). Omit to use the first connected profile.'
  }
};

const TOOLS = [
  {
    name: 'safari_list_profiles',
    description: 'List all Safari profiles currently connected to the bridge, with their connection status.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'safari_navigate',
    description: 'Navigate the active Safari tab to a URL. Waits for the page to finish loading.',
    inputSchema: {
      type: 'object',
      properties: {
        url:   { type: 'string', description: 'Full URL to navigate to (include https://)' },
        tabId: { type: 'number', description: 'Tab ID — omit to use the active tab' },
        ...PROFILE_PROP
      },
      required: ['url']
    }
  },
  {
    name: 'safari_get_page_text',
    description: 'Return the visible text content of the current page (innerText).',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab ID — omit to use the active tab' },
        ...PROFILE_PROP
      }
    }
  },
  {
    name: 'safari_read_page',
    description: 'Return the full HTML source, URL, and title of the current page.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab ID — omit to use the active tab' },
        ...PROFILE_PROP
      }
    }
  },
  {
    name: 'safari_javascript',
    description: 'Execute arbitrary JavaScript in the current page and return the result.',
    inputSchema: {
      type: 'object',
      properties: {
        code:  { type: 'string', description: 'JS expression or statements. Use return for values.' },
        tabId: { type: 'number', description: 'Tab ID — omit to use the active tab' },
        ...PROFILE_PROP
      },
      required: ['code']
    }
  },
  {
    name: 'safari_find',
    description: 'Find elements on the page by CSS selector and/or visible text.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector (optional)' },
        text:     { type: 'string', description: 'Filter elements whose text contains this string (optional)' },
        limit:    { type: 'number', description: 'Max elements to return (default 20)' },
        tabId:    { type: 'number', description: 'Tab ID — omit to use the active tab' },
        ...PROFILE_PROP
      }
    }
  },
  {
    name: 'safari_click',
    description: 'Click an element identified by a CSS selector.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the element to click' },
        tabId:    { type: 'number', description: 'Tab ID — omit to use the active tab' },
        ...PROFILE_PROP
      },
      required: ['selector']
    }
  },
  {
    name: 'safari_form_input',
    description: 'Set the value of an input, textarea, or select element and fire input/change events.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the form field' },
        value:    { type: 'string', description: 'Value to enter' },
        tabId:    { type: 'number', description: 'Tab ID — omit to use the active tab' },
        ...PROFILE_PROP
      },
      required: ['selector', 'value']
    }
  },
  {
    name: 'safari_scroll',
    description: 'Scroll the page by x/y pixels, or to a specific position.',
    inputSchema: {
      type: 'object',
      properties: {
        x:        { type: 'number', description: 'Horizontal scroll delta in px' },
        y:        { type: 'number', description: 'Vertical scroll delta in px' },
        absolute: { type: 'boolean', description: 'If true, scroll to absolute position instead of delta' },
        tabId:    { type: 'number', description: 'Tab ID — omit to use the active tab' },
        ...PROFILE_PROP
      }
    }
  },
  {
    name: 'safari_tabs_list',
    description: 'List all open tabs in the profile with their IDs, URLs, and titles.',
    inputSchema: { type: 'object', properties: { ...PROFILE_PROP } }
  },
  {
    name: 'safari_tabs_create',
    description: 'Open a new tab, optionally with a URL.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open (optional — default is blank tab)' },
        ...PROFILE_PROP
      }
    }
  },
  {
    name: 'safari_tabs_close',
    description: 'Close a tab.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab ID to close — omit to close the active tab' },
        ...PROFILE_PROP
      }
    }
  },
  {
    name: 'safari_tabs_switch',
    description: 'Switch to (activate) a tab by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab ID to activate' },
        ...PROFILE_PROP
      },
      required: ['tabId']
    }
  }
];

const TOOL_TO_CMD = {
  safari_navigate:      'navigate',
  safari_get_page_text: 'get_page_text',
  safari_read_page:     'read_page',
  safari_javascript:    'javascript',
  safari_find:          'find',
  safari_click:         'click',
  safari_form_input:    'form_input',
  safari_scroll:        'scroll',
  safari_tabs_list:     'tabs_list',
  safari_tabs_create:   'tabs_create',
  safari_tabs_close:    'tabs_close',
  safari_tabs_switch:   'tabs_switch'
};

// ── MCP stdio handler ─────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; }

  const { id, method, params } = msg;

  try {
    let result;

    switch (method) {
      case 'initialize':
        result = {
          protocolVersion: MCP_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'claude-for-safari', version: '1.3.0' }
        };
        break;

      case 'notifications/initialized':
        return;

      case 'tools/list':
        result = { tools: TOOLS };
        break;

      case 'tools/call': {
        const toolName = params?.name;
        const { profile, ...toolArgs } = params?.arguments ?? {};

        if (toolName === 'safari_list_profiles') {
          let list;
          if (isRelay) {
            // Ask primary for the profile list via relay
            list = await callExtension('list_profiles', {}, null);
          } else {
            list = listProfiles();
          }
          result = {
            content: [{
              type: 'text',
              text: !Array.isArray(list) || list.length === 0
                ? 'No Safari profiles connected.'
                : JSON.stringify(list, null, 2)
            }]
          };
          break;
        }

        const cmd = TOOL_TO_CMD[toolName];
        if (!cmd) throw mcpError(-32602, `Unknown tool: ${toolName}`);

        const data = await callExtension(cmd, toolArgs, profile || null);
        result = {
          content: [{
            type: 'text',
            text: typeof data === 'string' ? data : JSON.stringify(data, null, 2)
          }]
        };
        break;
      }

      default:
        throw mcpError(-32601, `Method not found: ${method}`);
    }

    write({ jsonrpc: '2.0', id, result });
  } catch (err) {
    if (id !== undefined) {
      write({
        jsonrpc: '2.0', id,
        error: { code: err.code ?? -32603, message: err.message ?? String(err) }
      });
    }
  }
});

function mcpError(code, message) {
  const e = new Error(message); e.code = code; return e;
}
function write(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
// Untrusted strings going to the log: strip control characters, cap the length.
function clean(value, max) { return String(value).replace(/[\x00-\x1f\x7f]/g, '').slice(0, max); }
function log(msg)   { process.stderr.write('[claude-safari] ' + msg + '\n'); }
