// SAFARI_DEFAULT_PROFILE and profile-name matching. See "Safari profiles" in the README.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sleep, startBridge, fakeExtension } = require('./helpers');

const PORT = 45692;

async function profileDescription(bridge) {
  const { result } = await bridge.request('tools/list');
  return result.tools.find(t => t.name === 'safari_navigate').inputSchema.properties.profile.description;
}

test('without SAFARI_DEFAULT_PROFILE, behaviour is unchanged', async (t) => {
  const bridge = startBridge(t, PORT);
  assert.ok(await bridge.waitForLog('PRIMARY'), bridge.log);
  await fakeExtension(t, PORT, 'default');
  await fakeExtension(t, PORT, 'Dev');

  assert.equal((await bridge.call('safari_tabs_list')).text, 'answer from default', 'first registered profile');
  assert.doesNotMatch((await bridge.call('safari_list_profiles')).text, /"default": true/);
  assert.match(await profileDescription(bridge), /first connected profile/);
});

test('SAFARI_DEFAULT_PROFILE picks the profile, an explicit one still wins', async (t) => {
  const port = PORT + 100;
  const bridge = startBridge(t, port, { SAFARI_DEFAULT_PROFILE: 'Dev' });
  assert.ok(await bridge.waitForLog('PRIMARY'), bridge.log);
  const dev = await fakeExtension(t, port, 'Dev');
  const other = await fakeExtension(t, port, 'default');

  assert.equal((await bridge.call('safari_tabs_list')).text, 'answer from Dev');
  assert.equal((await bridge.call('safari_tabs_list', { profile: 'default' })).text, 'answer from default');
  const list = JSON.parse((await bridge.call('safari_list_profiles')).text);
  assert.deepEqual(list.filter(p => p.default).map(p => p.name), ['Dev']);
  assert.match(await profileDescription(bridge), /"Dev" \(configured default\)/);

  // The default profile leaves: explicit error, and nothing sent to another profile.
  dev.close();
  await sleep(200);
  const before = other.commands;
  const { text } = await bridge.call('safari_tabs_list');
  assert.match(text, /^ERROR: Default profile "Dev" \(SAFARI_DEFAULT_PROFILE\) is not connected/);
  assert.match(text, /Available: default/);
  assert.equal(other.commands, before);
});

test("each client's own configuration applies, not the primary's", async (t) => {
  const port = PORT + 200;
  const primary = startBridge(t, port);
  assert.ok(await primary.waitForLog('PRIMARY'), primary.log);
  await fakeExtension(t, port, 'default');
  await fakeExtension(t, port, 'Dev');

  const configured = startBridge(t, port, { SAFARI_DEFAULT_PROFILE: 'Dev' });
  assert.ok(await configured.waitForLog('RELAY — connected'), configured.log);
  assert.equal((await configured.call('safari_tabs_list')).text, 'answer from Dev');
  await configured.stop();

  const port2 = PORT + 300;
  const configuredPrimary = startBridge(t, port2, { SAFARI_DEFAULT_PROFILE: 'Dev' });
  assert.ok(await configuredPrimary.waitForLog('PRIMARY'), configuredPrimary.log);
  await fakeExtension(t, port2, 'default');
  await fakeExtension(t, port2, 'Dev');
  const plainRelay = startBridge(t, port2);
  assert.ok(await plainRelay.waitForLog('RELAY — connected'), plainRelay.log);
  assert.equal((await plainRelay.call('safari_tabs_list')).text, 'answer from default');
});

test('profile names are case-insensitive, ambiguous variants are refused', async (t) => {
  const port = PORT + 400;
  const bridge = startBridge(t, port, { SAFARI_DEFAULT_PROFILE: 'Dev' });
  assert.ok(await bridge.waitForLog('PRIMARY'), bridge.log);
  const lower = await fakeExtension(t, port, 'dev');
  await fakeExtension(t, port, 'default');

  assert.equal((await bridge.call('safari_tabs_list')).text, 'answer from dev', 'variable "Dev", profile "dev"');
  assert.equal((await bridge.call('safari_tabs_list', { profile: 'DEV' })).text, 'answer from dev');
  const list = JSON.parse((await bridge.call('safari_list_profiles')).text);
  assert.deepEqual(list.filter(p => p.default).map(p => p.name), ['dev']);

  const upper = await fakeExtension(t, port, 'Dev');
  assert.equal((await bridge.call('safari_tabs_list', { profile: 'dev' })).text, 'answer from dev', 'exact name wins');
  const before = lower.commands + upper.commands;
  assert.match((await bridge.call('safari_tabs_list', { profile: 'DEV' })).text, /is ambiguous/);
  assert.equal(lower.commands + upper.commands, before, 'nothing sent when ambiguous');
});
