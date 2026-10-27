'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../public/metrics');

const intent = (name, verdict) => ({ name, verdict, customerAsked: '', why: '' });
const session = (over) => ({ id: Math.random().toString(36).slice(2), agentName: 'DMV', agents: [{ name: 'DMV', version: '8.0' }], media: 'Voice', customerTurns: 3, toolCalls: 0, issues: { error: 0, guardrail: 0, tool_failed: 0, no_reply: 0 }, responseTimesMs: [], analysis: null, pending: false, ...over });
const analyzed = (...intents) => ({ analysis: { intents, refused: false } });

test('a session is valid to all intents only when every intent the AVA could answer was valid', () => {
  assert.equal(M.sessionVerdict(session(analyzed(intent('Renew', 'valid'), intent('Person', 'valid')))), 'all_valid');
  assert.equal(M.sessionVerdict(session(analyzed(intent('Renew', 'valid'), intent('Fees', 'partial')))), 'not_all_valid');
  assert.equal(M.sessionVerdict(session(analyzed(intent('Renew', 'valid'), intent('Fees', 'no_chance')))), 'all_valid');
  assert.equal(M.sessionVerdict(session(analyzed(intent('Fees', 'no_chance')))), 'customer_left');
  assert.equal(M.sessionVerdict(session(analyzed())), 'no_request');
  assert.equal(M.sessionVerdict(session({ customerTurns: 0 })), 'no_request');
  assert.equal(M.sessionVerdict(session({ pending: true })), 'pending');
  assert.equal(M.sessionVerdict(session({})), 'not_analyzed');
});

test('summarize rates sessions and intents over what was judged', () => {
  const rows = [
    session(analyzed(intent('Renew', 'valid'), intent('Person', 'valid'))),
    session({ ...analyzed(intent('Renew', 'not_valid'), intent('Fees', 'no_chance')), toolCalls: 4, issues: { error: 0, guardrail: 1, tool_failed: 1, no_reply: 0 } }),
    session({}),
  ];
  const s = M.summarize(rows);
  assert.equal(s.sessions, 3);
  assert.equal(s.analyzed, 2);
  assert.equal(s.allValidRate, 0.5);
  assert.equal(s.intents, 4);
  assert.equal(s.judgedIntents, 3);
  assert.equal(s.validIntentRate, 2 / 3);
  assert.equal(s.intentsPerSession, 2);
  assert.equal(s.toolSuccessRate, 0.75);
  assert.equal(s.guardrails, 1);
});

test('intentTable counts sessions once per intent and tallies verdicts', () => {
  const rows = M.intentTable([
    session(analyzed(intent('Renew', 'valid'), intent('Renew', 'partial'))),
    session(analyzed(intent('Renew', 'not_valid'), intent('Person', 'valid'))),
  ]);
  const renew = rows.find((r) => r.intent === 'Renew');
  assert.equal(renew.sessions, 2);
  assert.deepEqual([renew.valid, renew.partial, renew.not_valid], [1, 1, 1]);
  assert.equal(renew.validRate, 1 / 3);
  assert.equal(rows[0].intent, 'Renew');
});

test('applyFilters matches AVA, intent, verdicts, flags and preview', () => {
  const a = session(analyzed(intent('Renew', 'valid')));
  const b = session({ ...analyzed(intent('Fees', 'not_valid')), agentName: 'Benefits', issues: { error: 1, guardrail: 0, tool_failed: 0, no_reply: 0 } });
  const p = session({ ...analyzed(intent('Renew', 'valid')), preview: true });
  const all = [a, b, p];
  assert.deepEqual(M.applyFilters(all, {}), [a, b]);
  assert.deepEqual(M.applyFilters(all, { preview: 'only' }), [p]);
  assert.deepEqual(M.applyFilters(all, { agent: 'Benefits' }), [b]);
  assert.deepEqual(M.applyFilters(all, { intent: 'Renew', preview: 'include' }), [a, p]);
  assert.deepEqual(M.applyFilters(all, { verdict: 'not_all_valid' }), [b]);
  assert.deepEqual(M.applyFilters(all, { intentVerdict: 'not_valid' }), [b]);
  assert.deepEqual(M.applyFilters(all, { issues: 'no' }), [a]);
});

test('agentTable groups an AVA across its versions', () => {
  const rows = M.agentTable([
    session({ ...analyzed(intent('Renew', 'valid')), agents: [{ name: 'DMV', version: '8.0' }] }),
    session({ ...analyzed(intent('Renew', 'partial')), agents: [{ name: 'DMV', version: '9.0' }] }),
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].versions, ['8.0', '9.0']);
  assert.equal(rows[0].allValidRate, 0.5);
});
