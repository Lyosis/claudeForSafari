/**
 * Claude for Safari — Background Script
 *
 * Maintains a persistent WebSocket connection to the bridge server (bridge.js).
 * Identifies itself with a profile name (configurable via the extension popup).
 * Receives browser commands, executes them, and returns results.
 */

const BRIDGE_WS = 'ws://localhost:45678';
const RECONNECT_DELAY = 3000; // ms

let ws = null;
let reconnectTimer = null;
let currentProfile = 'default';

// ── Keepalive + auto-reconnect ───────────────────────────────────────────────
// Safari suspends the background page when idle, which freezes setInterval and
// any pending timers — so a plain interval can't recover a dropped socket.
// browser.alarms wakes the page back up even after suspension, so we use it to
// both keep the socket warm (ping) and reconnect when it has dropped.
const KEEPALIVE_ALARM = 'claude-keepalive';

if (browser.alarms) {
  browser.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 }); // ~30s (Safari may clamp to 1 min)
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== KEEPALIVE_ALARM) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' })); // keep the socket warm
    } else {
      connect();                                 // woke up with a dead socket → reconnect
    }
  });
} else {
  // Fallback when alarms are unavailable: best-effort while the page is alive.
  setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    else connect();
  }, 25000);
}

// Connect immediately with the default profile name,
// then switch to the stored name if one exists.
// This avoids blocking on storage (which may fail on first run).
connect();

browser.storage.local.get('profileName').then(({ profileName }) => {
  if (profileName && profileName !== currentProfile) {
    currentProfile = profileName;
    if (ws) ws.close(); // reconnect with the correct name
  }
}).catch(() => {
  // storage not available yet — keep default name, no-op
});

// React to profile name changes from the popup (reconnect with new name)
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.profileName) {
    currentProfile = changes.profileName.newValue || 'default';
    console.log('[Claude Safari] Profile name changed to:', currentProfile);
    if (ws) ws.close(); // triggers reconnect with new name via onclose handler
  }
});

// Opportunistic reconnect: whenever Safari wakes the background page for tab
// activity, make sure the socket is alive. connect() is a no-op when already
// open or connecting, so these frequent events are cheap.
browser.tabs.onActivated.addListener(() => connect());
browser.tabs.onUpdated.addListener(() => connect());

// ── WebSocket connection ───────────────────────────────────────────────────

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  ws = new WebSocket(BRIDGE_WS);

  ws.addEventListener('open', () => {
    console.log('[Claude Safari] Connected to bridge as profile:', currentProfile);
    clearTimeout(reconnectTimer);
    ws.send(JSON.stringify({
      type:    'connected',
      agent:   'safari-extension',
      profile: currentProfile
    }));
  });

  ws.addEventListener('message', async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    const { id, command, params } = msg;
    if (!id || !command) return;

    let result;
    try {
      result = await dispatch(command, params || {});
      ws.send(JSON.stringify({ id, success: true, result }));
    } catch (err) {
      ws.send(JSON.stringify({ id, success: false, error: err.message || String(err) }));
    }
  });

  ws.addEventListener('close', () => {
    console.log('[Claude Safari] Bridge disconnected — retrying in 3 s');
    ws = null;
    reconnectTimer = setTimeout(connect, RECONNECT_DELAY);
  });

  ws.addEventListener('error', () => {
    ws.close();
  });
}

// ── Command dispatcher ─────────────────────────────────────────────────────

async function dispatch(command, params) {
  switch (command) {
    case 'navigate':      return cmdNavigate(params);
    case 'get_page_text': return cmdGetPageText(params);
    case 'read_page':     return cmdReadPage(params);
    case 'javascript':    return cmdJavascript(params);
    case 'find':          return cmdFind(params);
    case 'click':         return cmdClick(params);
    case 'form_input':    return cmdFormInput(params);
    case 'scroll':        return cmdScroll(params);
    case 'tabs_list':     return cmdTabsList();
    case 'tabs_create':   return cmdTabsCreate(params);
    case 'tabs_close':    return cmdTabsClose(params);
    case 'tabs_switch':   return cmdTabsSwitch(params);
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function getActiveTabId(params) {
  if (params.tabId) return params.tabId;
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length) throw new Error('No active tab found');
  return tabs[0].id;
}

// MV2: use tabs.executeScript (browser.scripting is MV3-only)
function exec(tabId, func, args = []) {
  const code = `(${func.toString()})(${args.map(a => JSON.stringify(a)).join(', ')})`;
  return browser.tabs.executeScript(tabId, { code })
    .then(results => results[0]);
}

function waitForLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const done = () => { browser.tabs.onUpdated.removeListener(listener); resolve(); };
    const timer = setTimeout(done, timeoutMs);

    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        done();
      }
    }
    browser.tabs.onUpdated.addListener(listener);
  });
}

// ── Commands ───────────────────────────────────────────────────────────────

async function cmdNavigate({ url, tabId: tId }) {
  // Block non-http(s) schemes (e.g. javascript:) to prevent unintended execution.
  if (url && !/^https?:\/\//i.test(url) && !/^about:/i.test(url)) {
    throw new Error(`Unsupported URL scheme. Only http://, https://, and about: are allowed.`);
  }
  let tabId;
  if (tId) {
    const tab = await browser.tabs.update(tId, { url });
    tabId = tab.id;
  } else {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs.length > 0) {
      const tab = await browser.tabs.update(tabs[0].id, { url });
      tabId = tab.id;
    } else {
      // No active tab — create one
      const tab = await browser.tabs.create({ url });
      tabId = tab.id;
    }
  }
  await waitForLoad(tabId);
  const updated = await browser.tabs.get(tabId);
  return { tabId: updated.id, url: updated.url, title: updated.title };
}

async function cmdGetPageText(params) {
  const tabId = await getActiveTabId(params);
  const text = await exec(tabId, () => document.body ? document.body.innerText : '');
  const tab = await browser.tabs.get(tabId);
  return { text, url: tab.url, title: tab.title };
}

async function cmdReadPage(params) {
  const tabId = await getActiveTabId(params);
  return exec(tabId, () => ({
    html:  document.documentElement.outerHTML,
    url:   location.href,
    title: document.title
  }));
}

async function cmdJavascript({ code, tabId: tId }) {
  const tabId = await getActiveTabId({ tabId: tId });
  const wrappedCode = `(function() { ${code} })()`;
  const results = await browser.tabs.executeScript(tabId, { code: wrappedCode });
  return { result: results[0] };
}

async function cmdFind({ selector, text, limit = 20, tabId: tId }) {
  const tabId = await getActiveTabId({ tabId: tId });
  return exec(tabId, (sel, txt, lim) => {
    let els = sel
      ? Array.from(document.querySelectorAll(sel))
      : Array.from(document.querySelectorAll('a,button,input,select,textarea,h1,h2,h3,p,[role]'));

    if (txt) {
      const lower = txt.toLowerCase();
      els = els.filter(e => e.textContent.toLowerCase().includes(lower)
                         || (e.value && String(e.value).toLowerCase().includes(lower)));
    }

    return els.slice(0, lim).map(e => {
      const r = e.getBoundingClientRect();
      return {
        tag:     e.tagName.toLowerCase(),
        id:      e.id || null,
        classes: e.className || null,
        text:    e.textContent.trim().slice(0, 120),
        value:   e.value ?? null,
        href:    e.href  ?? null,
        type:    e.type  ?? null,
        rect: { top: Math.round(r.top), left: Math.round(r.left),
                width: Math.round(r.width), height: Math.round(r.height) }
      };
    });
  }, [selector || null, text || null, limit]);
}

async function cmdClick({ selector, tabId: tId }) {
  const tabId = await getActiveTabId({ tabId: tId });
  await exec(tabId, (sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error('Element not found: ' + sel);
    el.focus();
    el.click();
  }, [selector]);
  return { clicked: selector };
}

async function cmdFormInput({ selector, value, tabId: tId }) {
  const tabId = await getActiveTabId({ tabId: tId });
  await exec(tabId, (sel, val) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error('Element not found: ' + sel);
    el.focus();
    if (el.tagName === 'SELECT') {
      el.value = val;
    } else {
      // Use the native value setter matching the element's REAL type.
      // (HTMLInputElement's setter is a silent no-op when called on a <textarea>.)
      const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype
                  : el instanceof HTMLInputElement   ? window.HTMLInputElement.prototype
                  : null;
      const nativeSetter = proto && Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (nativeSetter) nativeSetter.call(el, val);
      else el.value = val;
    }
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, [selector, value]);
  return { selector, value };
}

async function cmdScroll({ x = 0, y = 0, absolute = false, tabId: tId }) {
  const tabId = await getActiveTabId({ tabId: tId });
  await exec(tabId, (dx, dy, abs) => {
    if (abs) window.scrollTo(dx, dy);
    else window.scrollBy(dx, dy);
  }, [x, y, absolute]);
  return { x, y, absolute };
}

async function cmdTabsList() {
  const tabs = await browser.tabs.query({});
  return tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active }));
}

async function cmdTabsCreate({ url }) {
  const target = url || 'about:newtab';
  const tab = await browser.tabs.create({ url: target });
  // tabs.create resolves before the page loads, so tab.url is often empty.
  // When a real URL was requested, wait for the load and report the final state.
  if (url) {
    await waitForLoad(tab.id);
    const updated = await browser.tabs.get(tab.id);
    return { tabId: updated.id, url: updated.url, title: updated.title };
  }
  return { tabId: tab.id, url: target };
}

async function cmdTabsClose({ tabId: tId }) {
  const tabId = tId ?? (await browser.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!tabId) throw new Error('No tab to close');
  await browser.tabs.remove(tabId);
  return { closed: tabId };
}

async function cmdTabsSwitch({ tabId }) {
  await browser.tabs.update(tabId, { active: true });
  return { active: tabId };
}
