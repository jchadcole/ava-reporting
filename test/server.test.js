'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { maskText } = require('../server/detail');
const { displayBotName } = require('../server/ava');

test('maskText hides card numbers and PINs but keeps short numbers', () => {
  assert.equal(maskText('card 4111 1111 1111 1234 please'), 'card ••••••••••••1234 please');
  assert.equal(maskText("it's 246810"), "it's ••••••");
  assert.equal(maskText('about 35 hours'), 'about 35 hours');
});

test('displayBotName tidies third-party bot ids', () => {
  assert.equal(displayBotName('agent_operator?instance_name=x', 'agent_operator?instance_name=x'), 'agent_operator (third-party)');
  assert.equal(displayBotName('b1', 'Billing bot'), 'Billing bot');
});

test('turnResponseMs measures from captured input to bot reply and skips the greeting', () => {
  const { turnResponseMs } = require('../server/detail');
  assert.equal(turnResponseMs({ dateInputStarted: '2026-10-09T14:37:19.669Z', dateCreated: '2026-10-09T14:37:23.515Z', dateCompleted: '2026-10-09T14:37:26.299Z' }), 2784);
  assert.equal(turnResponseMs({ dateCreated: '2026-10-09T14:36:38.837Z', dateCompleted: '2026-10-09T14:36:41.002Z' }), null);
  // Messaging turns have no dateInputStarted, only the customer's text.
  assert.equal(turnResponseMs({ userInput: 'Yes', dateCreated: '2026-10-09T03:28:50.067Z', dateCompleted: '2026-10-09T03:28:50.248Z' }), 181);
});

test('readOrgConfigs reads named orgs from GENESYS_ORGS', () => {
  const { readOrgConfigs } = require('../server/orgs');
  const configs = readOrgConfigs({
    GENESYS_ORGS: 'SC12, Acme Health',
    GENESYS_SC12_CLIENT_ID: 'a', GENESYS_SC12_CLIENT_SECRET: 'b',
    GENESYS_ACME_HEALTH_CLIENT_ID: 'c', GENESYS_ACME_HEALTH_CLIENT_SECRET: 'd', GENESYS_ACME_HEALTH_REGION: 'usw2.pure.cloud',
  });
  assert.deepEqual(configs.map((c) => [c.key, c.label, c.region, c.missing]), [['sc12', 'SC12', 'mypurecloud.com', false], ['acme_health', 'Acme Health', 'usw2.pure.cloud', false]]);
});

test('readOrgConfigs falls back to the single-org variables', () => {
  const { readOrgConfigs } = require('../server/orgs');
  assert.deepEqual(readOrgConfigs({ GENESYS_CLIENT_ID: 'a', GENESYS_CLIENT_SECRET: 'b' }).map((c) => [c.key, c.region]), [['default', 'mypurecloud.com']]);
  assert.equal(readOrgConfigs({}).length, 0);
});
