// background.js run in a sandbox against a fake bridge: profile name read
// before connecting, one socket per connection, URL schemes filtered.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sleep, waitFor, runExtension, fakeBridge } = require('./helpers');

const PORT = 45694;
const later = (ms, value) => () => new Promise(resolve => setTimeout(() => resolve(value), ms));

test('profile name is read before the first connection', async (t) => {
  const cases = [
    { name: 'stored name, fast storage', storage: () => Promise.resolve({ profileName: 'Dev' }), expected: ['Dev'] },
    // Seen in Safari: storage answers after the socket opens but before the timeout.
    { name: 'stored name, storage at 200 ms', storage: later(200, { profileName: 'Dev' }), expected: ['Dev'] },
    { name: 'storage slower than the 1 s timeout', storage: later(1500, { profileName: 'Dev' }), expected: ['default', 'Dev'] },
    { name: 'storage failing', storage: () => Promise.reject(new Error('unavailable')), expected: ['default'] },
    { name: 'no stored name', storage: () => Promise.resolve({}), expected: ['default'] },
  ];
  let port = PORT;
  for (const c of cases) {
    await t.test(c.name, async (t) => {
      const bridge = await fakeBridge(t, ++port);
      runExtension(t, port, { storage: c.storage });
      await waitFor(() => bridge.registrations.length >= c.expected.length, 6000);
      await sleep(300);
      assert.deepEqual(bridge.registrations, c.expected);
    });
  }
});

test('a rename during a command does not throw on a closed socket', async (t) => {
  const port = PORT + 100;
  const unhandled = [];
  const onUnhandled = err => unhandled.push(String(err));
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));

  const bridge = await fakeBridge(t, port);
  const slowQuery = () => new Promise(resolve => setTimeout(() => resolve([]), 2000));
  const ext = runExtension(t, port, { storage: () => Promise.resolve({ profileName: 'Dev' }), tabsQuery: slowQuery });
  await waitFor(() => bridge.registrations.length === 1);

  bridge.command('tabs_list');                                       // takes 2 s
  await sleep(300);
  ext.listeners.storage.forEach(f => f({ profileName: { newValue: 'Dev-renamed' } }, 'local'));
  await waitFor(() => bridge.registrations.length === 2, 6000);
  await sleep(2500);                                                 // the slow command ends

  assert.deepEqual(unhandled, []);
  assert.deepEqual(bridge.registrations, ['Dev', 'Dev-renamed']);
});

test('a rename followed by tab activity leaves a single socket', async (t) => {
  const port = PORT + 200;
  const bridge = await fakeBridge(t, port);
  const ext = runExtension(t, port, { storage: () => Promise.resolve({ profileName: 'Dev' }) });
  await waitFor(() => bridge.registrations.length === 1);

  ext.listeners.storage.forEach(f => f({ profileName: { newValue: 'Dev-renamed' } }, 'local'));
  ext.listeners.tabUpdated.forEach(f => f());                        // while the old socket closes
  await sleep(4500);                                                 // past the 3 s reconnect delay

  assert.equal(bridge.openSockets().length, 1);
  assert.deepEqual(bridge.registrations, ['Dev', 'Dev-renamed']);
});

test('only http, https and about: URLs are opened, by navigate and tabs_create', async (t) => {
  const port = PORT + 300;
  const bridge = await fakeBridge(t, port);
  const ext = runExtension(t, port, { storage: () => Promise.resolve({ profileName: 'Dev' }) });
  await waitFor(() => bridge.registrations.length === 1);

  const run = async (command, params) => {
    const id = bridge.command(command, params);
    // tabs_create / navigate wait for the page load: report it as complete.
    await sleep(100);
    ext.listeners.tabUpdated.forEach(f => f(2, { status: 'complete' }));
    await waitFor(() => bridge.replies.has(id), 3000);
    return bridge.replies.get(id);
  };

  for (const url of ['file:///etc/hosts', 'javascript:void 0', 'data:text/html,x']) {
    for (const command of ['tabs_create', 'navigate']) {
      const reply = await run(command, { url });
      assert.equal(reply?.success, false, `${command} ${url}`);
      assert.match(reply.error, /Unsupported URL scheme/);
    }
  }
  assert.deepEqual(ext.calls.tabsCreate, [], 'no tab opened for a refused URL');
  assert.deepEqual(ext.calls.tabsUpdate, []);

  const allowed = await run('tabs_create', { url: 'https://example.com/' });
  assert.equal(allowed?.success, true);
  // Objects created inside the sandbox belong to another realm: compare values.
  assert.deepEqual(ext.calls.tabsCreate.map(c => c.url), ['https://example.com/']);
});
