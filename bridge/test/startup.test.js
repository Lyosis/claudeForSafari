// A bridge that is starting answers once it is ready, instead of
// "Safari extension not connected" (MCP hosts send the call right after
// spawning the server, and respawn it after an error).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { sleep, startBridge, fakeExtension } = require('./helpers');

const PORT = 45693;

test('a relay that is starting waits for its connection to the primary', async (t) => {
  const primary = startBridge(t, PORT);
  assert.ok(await primary.waitForLog('PRIMARY'), primary.log);
  await fakeExtension(t, PORT, 'Dev');

  const relay = startBridge(t, PORT);
  const call = await relay.call('safari_tabs_list');           // sent at once
  assert.match(relay.log, /starting as relay/);
  assert.equal(call.text, 'answer from Dev');
  assert.ok(call.ms < 3000, `${call.ms} ms`);

  const listing = startBridge(t, PORT);
  assert.match((await listing.call('safari_list_profiles')).text, /"Dev"/);
});

test('a new primary waits for the extensions to reconnect', async (t) => {
  const port = PORT + 100;
  const bridge = startBridge(t, port);
  setTimeout(() => fakeExtension(t, port, 'Dev').catch(() => {}), 2000);  // extension back after 2 s
  const call = await bridge.call('safari_tabs_list');
  assert.equal(call.text, 'answer from Dev');
  assert.ok(call.ms >= 1500 && call.ms < 4500, `${call.ms} ms`);

  const port2 = PORT + 200;
  const listing = startBridge(t, port2);
  setTimeout(() => fakeExtension(t, port2, 'Dev').catch(() => {}), 1500);
  assert.match((await listing.call('safari_list_profiles')).text, /"Dev"/);
});

test('the wait is bounded: no extension → error after the grace period, then at once', async (t) => {
  const bridge = startBridge(t, PORT + 300);
  const first = await bridge.call('safari_tabs_list');
  assert.match(first.text, /Safari extension not connected/);
  assert.ok(first.ms >= 4500 && first.ms < 7000, `${first.ms} ms`);

  const second = await bridge.call('safari_tabs_list');
  assert.ok(second.ms < 500, `${second.ms} ms once the grace period is over`);
});

test('the relay takes over when the primary dies, without hanging the call', async (t) => {
  const port = PORT + 400;
  const primary = startBridge(t, port);
  assert.ok(await primary.waitForLog('PRIMARY'), primary.log);
  const ext = await fakeExtension(t, port, 'Dev');
  const relay = startBridge(t, port);
  assert.ok(await relay.waitForLog('RELAY — connected'), relay.log);

  await primary.stop();
  ext.terminate();
  await sleep(100);
  const call = await relay.call('safari_tabs_list');
  assert.doesNotMatch(call.text, /no answer/);
  assert.ok(call.ms >= 2500, `waited for the take-over (${call.ms} ms)`);
  assert.match(relay.log, /PRIMARY/);
});

test('port held by another program: the call fails within the wait, no hang', async (t) => {
  const port = PORT + 500;
  const squatters = await Promise.all(['127.0.0.1', '::1'].map(host => new Promise(resolve => {
    const server = net.createServer(s => s.destroy());
    server.once('error', () => resolve(null));               // e.g. no IPv6
    server.listen(port, host, () => resolve(server));
  })));
  t.after(() => squatters.forEach(s => s?.close()));

  const bridge = startBridge(t, port);
  const call = await bridge.call('safari_tabs_list');
  assert.match(call.text, /^ERROR/);
  assert.ok(call.ms < 7000, `${call.ms} ms`);
});
