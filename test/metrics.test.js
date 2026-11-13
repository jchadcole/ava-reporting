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

test('journeyGraph runs each session from Start through its intents to its outcome', () => {
  const rows = [
    session({ id: 'a', ...analyzed(intent('Renew', 'valid'), intent('Fees', 'not_valid')) }),
    session({ id: 'b', ...analyzed(intent('Renew', 'valid')) }),
    session({ id: 'c', ...analyzed(intent('Status', 'valid'), intent('Renew', 'valid'), intent('Fees', 'valid')) }),
    session({ id: 'd' }), // not analyzed: left out
  ];
  const g = M.journeyGraph(rows, { maxSteps: 2, maxPerStep: 1 });
  assert.equal(g.total, 3);
  const node = (id) => g.nodes.find((n) => n.id === id);
  assert.equal(node('0|Start').count, 3);
  assert.equal(node('1|Renew').count, 2);
  assert.equal(node('1|Other intents').count, 1); // only the most common intent per step is kept
  assert.equal(node('3|More intents').count, 1);
  assert.equal(node('end|all_valid').count, 2);
  assert.equal(g.links.find((l) => l.id === '0|Start>1|Renew').count, 2);
  // Focusing on a node or a link keeps only the sessions through it, out of the same total.
  const f = M.journeyGraph(rows, { maxSteps: 2, maxPerStep: 1, focus: ['1|Renew>2|Fees'] });
  assert.deepEqual([f.total, f.allTotal, f.paths[0].sessionId], [1, 3, 'a']);
  assert.equal(M.journeyGraph(rows, { focus: [M.sequenceFocus(['Renew'])] }).paths[0].sessionId, 'b');
  assert.equal(M.linkCounts(f.paths).get('1|Renew>2|Fees'), 1);
});

test('topPaths ranks full intent sequences', () => {
  const rows = [
    session(analyzed(intent('Renew', 'valid'))),
    session(analyzed(intent('Renew', 'partial'))),
    session(analyzed(intent('Renew', 'valid'), intent('Fees', 'valid'))),
  ];
  const top = M.topPaths(rows);
  assert.deepEqual(top[0].path, ['Renew']);
  assert.equal(top[0].sessions, 2);
  assert.equal(top[0].allValidRate, 0.5);
});

test('withIntents keeps sessions with any or all of the picked intents', () => {
  const a = session(analyzed(intent('Renew', 'valid'), intent('Fees', 'valid')));
  const b = session(analyzed(intent('Renew', 'valid')));
  const c = session(analyzed(intent('Status', 'valid')));
  assert.deepEqual(M.withIntents([a, b, c], []), [a, b, c]);
  assert.deepEqual(M.withIntents([a, b, c], ['Fees', 'Status']), [a, c]);
  assert.deepEqual(M.withIntents([a, b, c], ['Renew', 'Fees'], 'all'), [a]);
});

test('containment follows the three rules and the exclusions', () => {
  const i = (supported, resolved, verdict = resolved ? 'valid' : 'not_valid') => ({ name: 'x', supported, resolved, verdict });
  const s = (intentsList, over = {}, a = {}) => session({ transferred: false, endedNormally: true, ...over, analysis: { intents: intentsList, transferReason: 'none', misunderstandings: 0, ...a } });
  const rule = (x) => M.containment(x).rule;
  assert.equal(rule(s([i(true, true), i(true, true)])), 'full_resolution');
  assert.equal(rule(s([i(true, true), i(false, false)], { transferred: true, endedNormally: false }, { transferReason: 'unsupported_intent' })), 'partial');
  assert.equal(rule(s([i(true, true), i(false, false, 'no_chance')])), 'deflection');
  assert.equal(rule(s([i(true, true), i(true, false)])), 'supported_unresolved');
  assert.equal(rule(s([i(true, true)], { transferred: true }, { transferReason: 'system_error' })), 'breakdown');
  assert.equal(rule(s([i(false, true)], { transferred: true }, { transferReason: 'unsupported_intent', misunderstandings: 3 })), 'breakdown');
  assert.equal(rule(s([i(false, false)], { transferred: true }, { transferReason: 'customer_preference' })), 'transferred');
  assert.equal(M.containment(s([i(true, true)], {}, { outdated: true })).status, null); // analyzed before these fields
  const sum = M.containmentSummary([s([i(true, true)]), s([i(true, false)]), session({})]);
  assert.deepEqual([sum.contained, sum.scored, sum.rate], [1, 2, 0.5]);
});

test('abandonment follows the three rules and the exclusions', () => {
  const i = (supported, resolved) => ({ name: 'x', supported, resolved, verdict: resolved ? 'valid' : 'not_valid' });
  const s = (intentsList, over = {}, a = {}) => session({ transferred: false, exitType: 'user_hangup', customerTurns: 2, ...over, analysis: { intents: intentsList, transferReason: 'none', misunderstandings: 0, lastBotState: 'providing_answer', midSessionSilence: false, ...a } });
  const rule = (x) => M.abandonment(x).rule;
  assert.equal(rule(s([i(true, false)], {}, { misunderstandings: 2 })), 'frustration');
  assert.equal(rule(s([i(false, false)], { exitType: 'timeout' }, { lastBotState: 'fallback_prompt' })), 'dead_end');
  assert.equal(rule(s([i(true, false)], { customerTurns: 3 })), 'premature');
  assert.equal(rule(s([i(true, false)], { customerTurns: 3, exitType: 'timeout' })), 'other'); // premature needs a hang-up
  assert.equal(rule(s([i(true, false)], { transferred: true }, { misunderstandings: 3 })), 'escalation');
  assert.equal(rule(s([i(true, false), i(true, true)], {}, { misunderstandings: 3 })), 'deflection');
  assert.equal(M.abandonment(s([i(true, true)], {}, { lastBotState: undefined })).status, null); // analyzed before these fields
  const sum = M.abandonmentSummary([s([i(true, false)], { customerTurns: 4 }), s([i(true, true)])]);
  assert.deepEqual([sum.abandoned, sum.scored, sum.rate], [1, 2, 0.5]);
});

test('a not-contained session explains the rule that decided it and why the others failed', () => {
  const s = session({ transferred: true, handoff: 'agent', endedNormally: false, analysis: { intents: [{ name: 'Speak to a person', supported: true, resolved: false, verdict: 'valid' }], transferReason: 'customer_preference', misunderstandings: 0, lastBotState: 'providing_answer' } });
  const x = M.containmentExplanation(s);
  assert.equal(x.title, 'Supported intent not resolved');
  assert.match(x.summary, /did not resolve “Speak to a person”/);
  assert.equal(x.rules.length, 3);
  assert.match(x.rules[1].why, /because the customer asked for a person, not because of an unsupported intent/);
  assert.equal(M.containmentExplanation(session({ transferred: false, endedNormally: true, analysis: { intents: [{ name: 'A', supported: true, resolved: true, verdict: 'valid' }], transferReason: 'none', misunderstandings: 0 } })), null);
});

test('escalation: intents driving hand-offs, last intent before the hand-off and reasons', () => {
  const mk = (id, names, transferred, reason, extra = {}) => ({ id, customerTurns: 3, transferred, handoff: transferred ? 'agent' : 'none', analysis: { intents: names.map((n) => ({ name: n, verdict: n === 'Refund' ? 'not_valid' : 'valid', supported: true, resolved: n !== 'Refund' })), transferReason: reason }, ...extra });
  const sessions = [
    mk('a', ['Order status', 'Refund', 'Speak to an agent'], true, 'unsupported_intent'),
    mk('b', ['Refund'], true, 'user_frustration'),
    mk('c', ['Refund'], false, 'none'),
    mk('d', ['Order status'], false, 'none'),
    mk('e', ['Speak to an agent'], true, 'customer_preference', { handoff: 'queue' }),
    { id: 'f', customerTurns: 2, transferred: true, handoff: 'agent', pending: true },
  ];
  assert.equal(M.isEscalated(sessions[0]), true);
  assert.equal(M.isEscalated(sessions[2]), false);
  assert.equal(M.lastIntentBeforeEscalation(sessions[0]), 'Refund');
  assert.equal(M.lastIntentBeforeEscalation(sessions[4]), 'Speak to an agent');
  const rows = M.escalationIntentTable(sessions);
  const refund = rows.find((r) => r.intent === 'Refund');
  assert.equal(rows[0].intent, 'Refund');
  assert.equal(refund.escalated, 2);
  assert.equal(refund.sessions, 3);
  assert.equal(refund.lastBefore, 2);
  assert.equal(refund.resolvedRate, 0);
  assert.ok(Math.abs(refund.shareOfEscalated - 2 / 3) < 1e-9);
  const order = rows.find((r) => r.intent === 'Order status');
  assert.equal(order.escalationRate, 0.5);
  assert.equal(order.lastBefore, 0);
  const sum = M.escalationSummary(sessions);
  assert.equal(sum.escalated, 4);
  assert.equal(sum.reachedAgent, 3);
  assert.equal(sum.queueOnly, 1);
  assert.equal(sum.topLastIntent, 'Refund');
  const g = M.journeyGraph(sessions.filter(M.isEscalated), { outcome: M.escalationOutcome, outcomes: M.ESCALATION_OUTCOMES });
  assert.equal(g.total, 3);
  assert.deepEqual(g.nodes.filter((n) => n.kind === 'outcome').map((n) => n.label).sort(), ['Customer asked for a person', 'Customer frustration', 'Unsupported intent']);
  assert.equal(g.outcomeOrder[0], 'unsupported_intent');
});

test('intents before the hand-off: every escalated session, whoever asked for the person', () => {
  const it = (name, verdict, resolved = verdict === 'valid') => ({ name, verdict, resolved, why: `${name} ${verdict}`, customerAsked: name });
  const sessions = [
    { id: 'a', start: '2026-10-28T10:00:00Z', transferred: true, handoff: 'agent', analysis: { intents: [it('Pay a fee', 'not_valid'), it('Speak to a person', 'valid'), it('Update address', 'valid')], transferReason: 'user_frustration' } },
    { id: 'b', start: '2026-10-28T11:00:00Z', transferred: true, handoff: 'queue', analysis: { intents: [it('Check claim status', 'valid'), it('Pay a fee', 'partial')], transferReason: 'unsupported_intent' } },
    { id: 'c', start: '2026-10-28T12:00:00Z', transferred: false, analysis: { intents: [it('Pay a fee', 'valid')] } },
    { id: 'd', start: '2026-10-28T13:00:00Z', transferred: true, analysis: { intents: [it('Request a live agent', 'valid')], transferReason: 'customer_preference' } },
    { id: 'e', start: '2026-10-28T14:00:00Z', transferred: false, analysis: { intents: [it('Pay a fee', 'not_valid'), it('Talk to an agent', 'valid')] } },
  ];
  assert.equal(M.isPersonRequest('Request a live agent'), true);
  assert.equal(M.isPersonRequest('Request a refund'), false);
  assert.deepEqual(M.namesBeforeHandoff(sessions[0]), ['Pay a fee']);
  // The AVA handed off without a request: every intent counts.
  assert.deepEqual(M.namesBeforeHandoff(sessions[1]), ['Check claim status', 'Pay a fee']);
  assert.deepEqual(M.namesBeforeHandoff(sessions[3]), []);
  // Asked for a person but never transferred: not part of the tab.
  assert.deepEqual(M.namesBeforeHandoff(sessions[4]), []);
  assert.equal(M.handoffOutcome(sessions[1]), 'partial');
  const rows = M.handoffIntentTable(sessions);
  const fee = rows.find((r) => r.intent === 'Pay a fee');
  assert.equal(rows[0].intent, 'Pay a fee');
  assert.equal(fee.before, 2);
  assert.equal(fee.rightBefore, 2);
  assert.equal(fee.sessions, 4);
  assert.equal(fee.escalationRate, 0.5);
  assert.equal(fee.customerAskedRate, 0.5);
  assert.deepEqual(fee.verdicts, { valid: 0, partial: 1, not_valid: 1, no_chance: 0 });
  assert.equal(fee.notes[0].verdict, 'not_valid');
  assert.equal(rows.find((r) => r.intent === 'Update address'), undefined);
  const sum = M.handoffSummary(sessions);
  assert.equal(sum.escalated, 3);
  assert.equal(sum.customerAsked, 2);
  assert.equal(sum.avaInitiated, 1);
  assert.equal(sum.noIntentsBefore, 1);
  assert.equal(sum.topLastIntent, 'Pay a fee');
  assert.equal(sum.failed, 2);
  assert.equal(sum.judged, 2);
  const g = M.journeyGraph(sessions.filter(M.isEscalated), { names: M.namesBeforeHandoff, outcome: M.handoffOutcome, outcomes: M.HANDOFF_OUTCOMES });
  assert.equal(g.total, 2);
  assert.ok(!g.nodes.some((n) => /agent|person/i.test(n.label) && n.kind === 'intent'));
});
