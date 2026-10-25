// Security of the bridge: loopback only, web pages refused, answers bound to
// the socket that carried the command. See "Security model" in the README.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { EXT_ORIGIN, sleep, startBridge, fakeExtension, handshake, lanAddress, canListenAndReach } = require('./helpers');

const PORT = 45691;

test('listens on loopback only', async (t) => {
  const bridge = startBridge(t, PORT);
  assert.ok(await bridge.waitForLog('PRIMARY'), bridge.log);

  assert.equal(await handshake('127.0.0.1', PORT), 'accepted');

  await t.test('reachable on ::1', async (t) => {
    if (!(await canListenAndReach('::1'))) return t.skip('IPv6 loopback unavailable on this machine');
    assert.equal(await handshake('[::1]', PORT), 'accepted');
  });

  await t.test('not reachable from the network', async (t) => {
    const lan = lanAddress();
    if (!lan) return t.skip('no non-loopback IPv4 address');
    // Control: a server on that address must be reachable, or a refusal proves nothing.
    if (!(await canListenAndReach(lan))) return t.skip(`${lan} not reachable from here (sandbox or firewall)`);
    assert.equal(await handshake(lan, PORT), 'refused TCP');
  });
});

test('refuses web pages, accepts the extension and local clients', async (t) => {
  const bridge = startBridge(t, PORT + 100);
  assert.ok(await bridge.waitForLog('PRIMARY'), bridge.log);
  const port = PORT + 100;

  for (const origin of ['https://evil.example', 'http://192.168.1.10:8765', 'null', 'chrome-extension://abcdef']) {
    assert.equal(await handshake('localhost', port, origin), 'refused 403', origin);
  }
  assert.equal(await handshake('localhost', port, EXT_ORIGIN), 'accepted');
  assert.equal(await handshake('localhost', port, EXT_ORIGIN.toUpperCase()), 'accepted', 'origin compared case-insensitively');
  assert.equal(await handshake('localhost', port), 'accepted', 'no Origin: relay bridge or local process');
  assert.match(bridge.log, /Refused connection from origin "https:\/\/evil\.example"/);
});

test('answers are bound to the socket that carried the command', async (t) => {
  const port = PORT + 200;
  const bridge = startBridge(t, port);
  assert.ok(await bridge.waitForLog('PRIMARY'), bridge.log);

  const genuine = await fakeExtension(t, port, 'default');
  assert.equal((await bridge.call('safari_tabs_list')).text, 'answer from default');

  // An intruder registers under the same name, then a third, unregistered
  // socket answers first with a guessed id: the forged answer must be ignored.
  const intruder = await fakeExtension(t, port, 'default', { answer: false });
  intruder.on('message', raw => {
    const msg = JSON.parse(raw);
    if (!msg.command) return;
    const guesser = new WebSocket(`ws://localhost:${port}`, { origin: EXT_ORIGIN });
    guesser.on('open', () => {
      guesser.send(JSON.stringify({ id: msg.id, success: true, result: 'FORGED answer' }));
      setTimeout(() => intruder.send(JSON.stringify({ id: msg.id, success: true, result: 'answer from intruder' })), 300);
    });
  });
  assert.equal((await bridge.call('safari_tabs_list')).text, 'answer from intruder');

  // When the intruder leaves, the genuine extension (still open) takes over again.
  intruder.close();
  await sleep(300);
  assert.equal(genuine.readyState, WebSocket.OPEN);
  assert.equal((await bridge.call('safari_tabs_list')).text, 'answer from default');
  assert.deepEqual(JSON.parse((await bridge.call('safari_list_profiles')).text), [{ name: 'default', status: 'connected' }]);
});

test('closing another socket of the profile does not fail the running command', async (t) => {
  const port = PORT + 300;
  const bridge = startBridge(t, port);
  assert.ok(await bridge.waitForLog('PRIMARY'), bridge.log);

  const older = await fakeExtension(t, port, 'default');
  const active = await fakeExtension(t, port, 'default', { answer: false });
  active.on('message', raw => {
    const msg = JSON.parse(raw);
    if (!msg.command) return;
    older.close();
    setTimeout(() => active.send(JSON.stringify({ id: msg.id, success: true, result: 'answer from active' })), 400);
  });
  assert.equal((await bridge.call('safari_tabs_list')).text, 'answer from active');

  // Closing the socket that carries the command fails it at once.
  active.removeAllListeners('message');
  active.on('message', raw => { if (JSON.parse(raw).command) active.close(); });
  const result = await bridge.call('safari_tabs_list');
  assert.match(result.text, /disconnected/);
  assert.ok(result.ms < 2000, `rejected after ${result.ms} ms`);
});

test('a second instance becomes a relay, and takes over when the primary dies', async (t) => {
  const port = PORT + 400;
  const primary = startBridge(t, port);
  assert.ok(await primary.waitForLog('PRIMARY'), primary.log);
  await fakeExtension(t, port, 'default');

  const relay = startBridge(t, port);
  assert.ok(await relay.waitForLog('RELAY — connected'), relay.log);
  assert.equal((await relay.call('safari_tabs_list')).text, 'answer from default');

  await primary.stop();
  assert.ok(await relay.waitForLog('PRIMARY', 9000), relay.log);
  assert.equal(await handshake('127.0.0.1', port), 'accepted');
});
