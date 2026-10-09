'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeSessionRows, summarizeConversation, attachConversations, displayBotName } = require('../server/dataset');
const { maskText } = require('../server/detail');

const iv = '2026-10-01T00:00:00.000Z/2026-10-02T00:00:00.000Z';
const row = (group, metrics) => ({ group: { mediaType: 'CALL', ...group }, data: [{ interval: iv, metrics: Object.entries(metrics).map(([metric, stats]) => ({ metric, stats })) }] });

test('mergeSessionRows combines per-metric aggregate rows into one session', () => {
  const core = [
    row({ botSessionId: 's1', botId: 'b1', conversationId: 'c1' }, { nBotSessions: { count: 1 }, nBotSessionTurns: { count: 3 }, tBotSession: { count: 1, sum: 5000 } }),
    row({ botSessionId: 's1', botId: 'b1', conversationId: 'c1', botResult: 'ExitRequestedByUser' }, { tBotExit: { count: 1, sum: 5000 } }),
  ];
  const intents = [row({ botSessionId: 's1', botIntent: 'Billing' }, { oBotIntent: { count: 1, sum: 1 } })];
  const failures = [row({ botSessionId: 's1', botRecognitionFailureReason: 'NoMatchCollection' }, { tBotRecognitionFailure: { count: 2, sum: 10 } })];
  const finals = [row({ botSessionId: 's1', botFinalIntent: 'Billing' }, { tBotExit: { count: 1 } })];
  const [s] = mergeSessionRows(core, intents, failures, finals, new Map([['b1', { name: 'Billing bot', type: 'BOT' }]]));
  assert.equal(s.botName, 'Billing bot');
  assert.equal(s.media, 'Voice');
  assert.equal(s.turns, 3);
  assert.equal(s.durationMs, 5000);
  assert.equal(s.outcome, 'exit');
  assert.equal(s.botResult, 'ExitRequestedByUser');
  assert.deepEqual(s.intents, ['Billing']);
  assert.equal(s.finalIntent, 'Billing');
  assert.equal(s.recognitionFailures, 2);
});

test('summarizeConversation detects an agent after the bot', () => {
  const conv = summarizeConversation({
    conversationId: 'c1',
    conversationStart: '2026-10-01T10:00:00Z',
    participants: [
      { purpose: 'botflow', sessions: [{ flow: { flowId: 'b1', flowType: 'BOT', exitReason: 'USER_EXIT' }, segments: [{ segmentStart: '2026-10-01T10:00:01Z', segmentType: 'interact' }] }] },
      { purpose: 'acd', participantName: 'Billing queue', sessions: [{ segments: [{ segmentStart: '2026-10-01T10:01:00Z', segmentType: 'interact' }] }] },
      { purpose: 'agent', sessions: [{ segments: [{ segmentStart: '2026-10-01T10:02:00Z', segmentType: 'interact' }] }] },
    ],
  });
  assert.equal(conv.escalation, 'agent');
  assert.equal(conv.queueName, 'Billing queue');
  assert.equal(conv.botRuns[0].start, '2026-10-01T10:00:01Z');
});

test('attachConversations sets start time and leaves escalation null when detail is missing', () => {
  const sessions = [{ id: 's1', botId: 'b1', conversationId: 'c1', bucket: '2026-10-01T00:00:00.000Z' }, { id: 's2', botId: 'b1', conversationId: 'c2', bucket: '2026-10-01T00:00:00.000Z' }];
  const conversations = new Map([['c1', { start: '2026-10-01T10:00:00Z', escalation: 'none', queueName: null, botRuns: [{ flowId: 'b1', start: '2026-10-01T10:00:05Z' }] }]]);
  const [a, b] = attachConversations(sessions, conversations);
  assert.equal(a.start, '2026-10-01T10:00:05Z');
  assert.equal(a.escalation, 'none');
  assert.equal(b.start, '2026-10-01T00:00:00.000Z');
  assert.equal(b.escalation, null);
});

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
