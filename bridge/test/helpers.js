/**
 * Test helpers — run a copy of bridge.js on a test port, fake Safari
 * extensions, raw WebSocket handshakes and MCP calls, and background.js in a
 * sandbox. Tests never touch the real bridge port (45678): they can run while
 * Claude Desktop is using the bridge.
 */

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

const BRIDGE = path.join(__dirname, '..', 'bridge.js');
const BACKGROUND = path.join(__dirname, '..', '..', 'app', 'claudeExtension Extension', 'Resources', 'background.js');
const NODE_MODULES = path.join(__dirname, '..', 'node_modules');
const REAL_PORT = 45678;
const EXT_ORIGIN = 'safari-web-extension://00000000-0000-4000-8000-000000000000';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
    if (predicate()) return true;
  }
  return predicate();
}

// Rewrites the hard-coded port; fails loudly rather than test the real one.
function withPort(source, original, port) {
  if (port === REAL_PORT) throw new Error('Tests must not use the real bridge port');
  const patched = source.replace(original, original.replace(String(REAL_PORT), String(port)));
  if (patched === source) throw new Error(`Port substitution failed for: ${original}`);
  return patched;
}

// ── Bridge ─────────────────────────────────────────────────────────────────

function startBridge(t, port, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-safari-test-'));
  const file = path.join(dir, 'bridge.js');
  fs.writeFileSync(file, withPort(fs.readFileSync(BRIDGE, 'utf8'), `const WS_PORT = ${REAL_PORT};`, port));

  const proc = spawn(process.execPath, [file], {
    env: { ...process.env, NODE_PATH: NODE_MODULES, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const bridge = { proc, log: '' };
  const waiting = new Map();
  let nextId = 0;
  let buffer = '';

  proc.stderr.on('data', d => { bridge.log += d; });
  proc.stdout.on('data', d => {
    buffer += d;
    for (let i; (i = buffer.indexOf('\n')) >= 0;) {
      const msg = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    }
  });

  bridge.request = (method, params = {}) => new Promise(resolve => {
    const id = ++nextId;
    const guard = setTimeout(() => resolve({ id, error: { message: 'no answer within 20 s' } }), 20_000);
    waiting.set(id, msg => { clearTimeout(guard); resolve(msg); });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

  // Tool call → { text, ms }; errors come back as "ERROR: <message>".
  bridge.call = async (name, args = {}) => {
    const start = Date.now();
    const msg = await bridge.request('tools/call', { name, arguments: args });
    const text = msg.result ? msg.result.content[0].text : `ERROR: ${msg.error.message}`;
    return { text, ms: Date.now() - start };
  };

  bridge.waitForLog = (needle, ms) => waitFor(() => bridge.log.includes(needle), ms);

  bridge.stop = () => new Promise(resolve => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once('exit', resolve);
    proc.kill();
  });

  t.after(bridge.stop);
  return bridge;
}

// A fake Safari extension: registers under `name` and answers every command
// with "answer from <name>" (unless `answer` is false).
function fakeExtension(t, port, name, { answer = true, origin = EXT_ORIGIN } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`, { origin });
    ws.commands = 0;
    ws.on('error', reject);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'connected', profile: name }));
      setTimeout(() => resolve(ws), 150);
    });
    ws.on('message', raw => {
      const msg = JSON.parse(raw);
      if (!msg.command) return;
      ws.commands++;
      if (answer) ws.send(JSON.stringify({ id: msg.id, success: true, result: `answer from ${name}` }));
    });
    t.after(() => ws.terminate());
  });
}

// Opens a WebSocket and reports how the handshake ended.
function handshake(host, port, origin) {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://${host}:${port}`, origin === undefined ? {} : { origin });
    const timer = setTimeout(() => { ws.terminate(); resolve('timeout'); }, 3000);
    ws.on('open', () => { clearTimeout(timer); ws.close(); resolve('accepted'); });
    ws.on('unexpected-response', (_req, res) => { clearTimeout(timer); resolve(`refused ${res.statusCode}`); });
    ws.on('error', err => { clearTimeout(timer); resolve(err.code === 'ECONNREFUSED' ? 'refused TCP' : `error ${err.code}`); });
  });
}

// ── Network capabilities of the machine running the tests ─────────────────

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

// Can this machine reach a server on `host`? (A refusal on a closed port only
// proves something if an open one would have answered.)
function canListenAndReach(host) {
  return new Promise(resolve => {
    const server = net.createServer(s => s.destroy());
    server.once('error', () => resolve(false));
    server.listen(0, host, () => {
      const socket = net.connect(server.address().port, host, () => { socket.destroy(); server.close(); resolve(true); });
      socket.once('error', () => { server.close(); resolve(false); });
    });
  });
}

// ── background.js in a sandbox ─────────────────────────────────────────────

// Runs background.js against `port`, with stubbed browser APIs. Returns the
// listeners it registered and the browser calls it made.
function runExtension(t, port, { storage = () => Promise.resolve({}), tabsQuery } = {}) {
  const listeners = { storage: [], tabUpdated: [] };
  const calls = { tabsCreate: [], tabsUpdate: [] };
  const timers = new Set();
  let disposed = false;

  const browser = {
    alarms: { create() {}, onAlarm: { addListener() {} } },
    storage: {
      onChanged: { addListener: f => listeners.storage.push(f) },
      local: { get: () => storage() },
    },
    tabs: {
      onActivated: { addListener() {} },
      onUpdated: { addListener: f => listeners.tabUpdated.push(f), removeListener() {} },
      query: tabsQuery ?? (() => Promise.resolve([{ id: 1, url: 'https://example.com/', title: 'x', active: true }])),
      create: opts => { calls.tabsCreate.push(opts); return Promise.resolve({ id: 2, ...opts }); },
      update: (id, opts) => { calls.tabsUpdate.push(opts); return Promise.resolve({ id, ...opts }); },
      get: id => Promise.resolve({ id, url: '', title: '' }),
    },
  };
  class SandboxWebSocket extends WebSocket {
    addEventListener(type, f) { this.on(type, type === 'message' ? data => f({ data: data.toString() }) : f); }
  }
  const sandbox = {
    browser,
    console: { log() {} },
    WebSocket: SandboxWebSocket,
    setTimeout: (f, ms) => {
      if (disposed) return 0;
      const id = setTimeout(() => { timers.delete(id); f(); }, ms);
      timers.add(id);
      return id;
    },
    clearTimeout: id => { clearTimeout(id); timers.delete(id); },
    setInterval: () => 0,
  };

  const source = withPort(fs.readFileSync(BACKGROUND, 'utf8'), `'ws://localhost:${REAL_PORT}'`, port);
  vm.runInNewContext(source, sandbox);

  t.after(() => { disposed = true; for (const id of timers) clearTimeout(id); });
  return { listeners, calls };
}

// A fake bridge for background.js: records registrations and answers.
function fakeBridge(t, port) {
  return new Promise(resolve => {
    const wss = new WebSocket.WebSocketServer({ port, host: '127.0.0.1' }, () => resolve(wss));
    wss.registrations = [];
    wss.replies = new Map();
    wss.sockets = [];
    wss.on('connection', ws => {
      wss.sockets.push(ws);
      ws.on('message', raw => {
        const msg = JSON.parse(raw);
        if (msg.type === 'connected') wss.registrations.push(msg.profile);
        else if (msg.id) wss.replies.set(msg.id, msg);
      });
    });
    wss.openSockets = () => wss.sockets.filter(s => s.readyState === WebSocket.OPEN);
    wss.command = (command, params = {}) => {
      const id = `test_${command}_${Date.now()}`;
      wss.sockets.at(-1).send(JSON.stringify({ id, command, params }));
      return id;
    };
    t.after(() => new Promise(done => { for (const c of wss.clients) c.terminate(); wss.close(done); }));
  });
}

module.exports = {
  EXT_ORIGIN, sleep, waitFor,
  startBridge, fakeExtension, handshake,
  lanAddress, canListenAndReach,
  runExtension, fakeBridge,
};
