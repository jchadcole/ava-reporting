'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../public/metrics');

const base = { intents: [], finalIntent: null, recognitionFailures: 0, recognitionFailureReasons: [], queries: 0, selfServedQueries: 0, turns: 2, durationMs: 1000, media: 'Voice' };
const session = (over) => ({ ...base, id: Math.random().toString(36).slice(2), ...over });

test('containment prefers conversation escalation over bot outcome', () => {
  assert.equal(M.containment(session({ escalation: 'agent', outcome: 'disconnect' })), 'escalated');
  assert.equal(M.containment(session({ escalation: 'queue', outcome: 'disconnect' })), 'escalated');
  assert.equal(M.containment(session({ escalation: 'none', outcome: 'exit' })), 'contained');
});

test('containment falls back to bot outcome without conversation detail', () => {
  assert.equal(M.containment(session({ escalation: null, outcome: 'disconnect' })), 'contained');
  assert.equal(M.containment(session({ escalation: null, outcome: 'exit' })), 'escalated');
  assert.equal(M.containment(session({ escalation: null, outcome: 'unknown' })), 'unknown');
});

test('summarize computes rates over known outcomes', () => {
  const rows = [
    session({ escalation: 'none', queries: 2, selfServedQueries: 2, intents: ['Billing'] }),
    session({ escalation: 'agent', queries: 2, selfServedQueries: 0, recognitionFailures: 1, turns: 4, durationMs: 3000 }),
    session({ escalation: null, outcome: 'unknown' }),
  ];
  const s = M.summarize(rows);
  assert.equal(s.sessions, 3);
  assert.equal(s.contained, 1);
  assert.equal(s.escalated, 1);
  assert.equal(s.unknown, 1);
  assert.equal(s.containmentRate, 0.5);
  assert.equal(s.selfServiceRate, 0.5);
  assert.equal(s.agentRate, 1 / 3);
  assert.equal(s.recognitionFailureRate, 1 / 3);
  assert.equal(s.medianDurationMs, 1000);
  assert.equal(s.avgTurns, 8 / 3);
});

test('applyFilters matches bot, intent (including final intent), outcome and failures', () => {
  const rows = [
    session({ botId: 'a', intents: ['Billing'], escalation: 'none' }),
    session({ botId: 'a', finalIntent: 'Billing', escalation: 'agent', recognitionFailures: 1 }),
    session({ botId: 'b', intents: ['Hours'], escalation: 'none', media: 'Messaging' }),
  ];
  assert.equal(M.applyFilters(rows, { botIds: ['a'] }).length, 2);
  assert.equal(M.applyFilters(rows, { intent: 'Billing' }).length, 2);
  assert.equal(M.applyFilters(rows, { intent: 'Billing', containment: 'contained' }).length, 1);
  assert.equal(M.applyFilters(rows, { recognitionFailure: 'yes' }).length, 1);
  assert.equal(M.applyFilters(rows, { media: 'Messaging' }).length, 1);
});

test('applyFilters hides, includes or isolates preview sessions', () => {
  const rows = [session({ preview: true }), session({ preview: false }), session({})];
  assert.equal(M.applyFilters(rows, { preview: 'exclude' }).length, 2);
  assert.equal(M.applyFilters(rows, { preview: 'include' }).length, 3);
  assert.equal(M.applyFilters(rows, { preview: 'only' }).length, 1);
  assert.equal(M.applyFilters(rows, {}).length, 3);
});

test('looping sessions keep every intent, in order, with repeats', () => {
  const rows = [
    session({ intents: ['Balance', 'Knowledge'], intentPath: ['Fraud', 'Balance', 'Fraud'] }),
    session({ intents: ['Balance'] }),
    session({}),
  ];
  assert.deepEqual(M.intentPath(rows[0]), ['Fraud', 'Balance', 'Fraud', 'Knowledge']);
  assert.deepEqual(M.intentPath(rows[1]), ['Balance']);
  assert.equal(M.applyFilters(rows, { intentCount: 'multiple' }).length, 1);
  assert.equal(M.applyFilters(rows, { intentCount: 'one' }).length, 1);
  assert.equal(M.applyFilters(rows, { intentCount: 'none' }).length, 1);
  const table = Object.fromEntries(M.intentTable(rows).map((r) => [r.intent, r]));
  assert.equal(table.Fraud.sessions, 1);
  assert.equal(table.Fraud.matches, 2);
  assert.equal(table.Balance.sessions, 2);
  const sum = M.summarize(rows);
  assert.equal(sum.multiIntent, 1);
  assert.equal(sum.intentsPerSession, 2.5);
  assert.equal(M.applyFilters(rows, { intent: 'Fraud' }).length, 1);
});

test('byDay fills empty days in the interval', () => {
  const days = M.byDay([session({ start: '2026-10-02T12:00:00', escalation: 'none' })], '2026-10-01T00:00:00', '2026-10-04T00:00:00');
  assert.deepEqual(days.map((d) => d.day), ['2026-10-01', '2026-10-02', '2026-10-03']);
  assert.equal(days[1].contained, 1);
});

test('intentTable counts each session once per intent', () => {
  const rows = [session({ intents: ['Billing'], finalIntent: 'Billing', escalation: 'none' }), session({ intents: ['Billing', 'Hours'], escalation: 'agent' })];
  const t = M.intentTable(rows);
  const billing = t.find((r) => r.intent === 'Billing');
  assert.equal(billing.sessions, 2);
  assert.equal(billing.asFinal, 1);
  assert.equal(billing.containmentRate, 0.5);
  assert.equal(t.find((r) => r.intent === 'Hours').share, 0.5);
});

test('response stats pool every customer turn across sessions', () => {
  const rows = [session({ responseTimesMs: [400, 1200] }), session({ responseTimesMs: [800, 5000, 600] }), session({ responseTimesMs: [] })];
  const s = M.summarize(rows);
  assert.equal(s.responseTurns, 5);
  assert.equal(s.medianResponseMs, 800);
  assert.equal(s.maxResponseMs, 5000);
  assert.deepEqual(M.sessionResponse(rows[0]), { responseTurns: 2, timedSessions: 1, medianResponseMs: 800, maxResponseMs: 1200 });
  assert.equal(M.sessionResponse(rows[2]).maxResponseMs, null);
  assert.equal(M.botTable(rows.map((r) => ({ ...r, botId: 'b', botName: 'B' })))[0].maxResponseMs, 5000);
});

test('verificationTotals rebuilds Genesys-style totals from session rows', () => {
  const rows = [
    session({ conversationId: 'c1', outcome: 'exit', turns: 3, recognitionFailures: 1, queries: 2, selfServedQueries: 1, intents: ['Billing'], escalation: 'agent' }),
    session({ conversationId: 'c1', outcome: 'disconnect', turns: 1, escalation: 'agent' }),
    session({ conversationId: 'c2', outcome: 'unknown', turns: 2, intents: ['Billing', 'Hours'], escalation: 'none' }),
  ];
  const v = M.verificationTotals(rows);
  assert.deepEqual(v.totals, { sessions: 3, turns: 6, exits: 1, disconnects: 1, recognitionFailures: 1, queries: 2, selfServedQueries: 1, conversations: 2, conversationsWithAgent: 1 });
  assert.deepEqual(v.intentSessions, { Billing: 2, Hours: 1 });
});
