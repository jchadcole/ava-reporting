'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Stand in for Claude so the analysis queue can run without a key or network.
const calls = [];
require.cache[require.resolve('../server/claude')] = {
  exports: {
    claudeEnabled: () => true,
    isFatalClaudeError: () => false,
    askJson: async ({ input }) => {
      calls.push(input);
      return { refused: false, model: 'test', usage: { input: 10, output: 5 }, data: { intents: [{ name: 'Renew driver license', customerAsked: 'Renew a license', verdict: 'valid', why: 'It renewed it.' }, { name: 'Speak to a person', customerAsked: 'Wants an agent', verdict: 'valid', why: 'It transferred.' }] } };
    },
  },
};
process.env.AVA_CACHE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ava-')), 'analyses.json');
const ava = require('../server/ava');

const agent = { agentId: 'a1', agentName: 'DMV Agent', agentVersion: '8.0' };
const avaAsk = { actionType: 'CallAgenticVirtualAgentAction', agentDetails: agent };
const turns = [
  { sessionId: 's1', conversation: { id: 'c1' }, askAction: avaAsk, dateCreated: '2026-10-20T10:00:00Z', dateCompleted: '2026-10-20T10:00:01Z', userInput: '', botPrompts: ['Hi, how can I help?'], askActionResult: 'SuccessCollection' },
  { sessionId: 's1', conversation: { id: 'c1' }, askAction: avaAsk, dateCreated: '2026-10-20T10:00:10Z', dateCompleted: '2026-10-20T10:00:12Z', userInput: 'renew my license, card 4111 1111 1111 1234', botPrompts: ['Done.'], askActionResult: 'SuccessCollection', toolCalls: [{ toolName: 'renew', status: 'Success' }, { toolName: 'pay', status: 'Failure' }] },
  { sessionId: 's1', conversation: { id: 'c1' }, askAction: avaAsk, dateCreated: '2026-10-20T10:00:20Z', dateCompleted: '2026-10-20T10:00:21Z', userInput: 'can you waive the fee', botPrompts: ['Sorry I cannot answer that.'], askActionResult: 'GuardrailsViolation', guardrailEvents: [{}] },
  { sessionId: 's1', conversation: { id: 'c1' }, askAction: avaAsk, dateCreated: '2026-10-20T10:00:30Z', dateCompleted: '2026-10-20T10:00:31Z', userInput: 'agent please', botPrompts: [], askActionResult: 'AgentRequestedByUser', sessionEndDetails: { type: 'Exit', reason: 'AgentRequestedByUser' } },
];
const bot = { id: 'b1', name: 'DMV Flow', type: 'BOT' };

test('only turns with AVA agent details count as AVA turns', () => {
  assert.equal(ava.isAvaTurn(turns[0]), true);
  assert.equal(ava.isAvaTurn({ askAction: { actionType: 'AskForNLUIntentAction' }, intent: { name: 'Billing' } }), false);
});

test('an AVA session row carries Genesys signals from its turns', () => {
  const s = ava.summarizeAvaSession('s1', turns.slice().reverse(), bot);
  assert.equal(s.agentName, 'DMV Agent');
  assert.deepEqual(s.agents, [{ id: 'a1', name: 'DMV Agent', version: '8.0' }]);
  assert.equal(s.media, 'Voice');
  assert.equal(s.start, '2026-10-20T10:00:00Z');
  assert.equal(s.customerTurns, 3);
  assert.equal(s.toolCalls, 2);
  assert.deepEqual(s.issues, { error: 0, guardrail: 1, tool_failed: 1, no_reply: 0 });
  assert.equal(s.agentRequested, true);
  assert.equal(s.endReason, 'Exit: AgentRequestedByUser');
});

test('the transcript Claude reads is masked and notes Genesys signals', () => {
  const text = ava.avaTranscript(turns);
  assert.ok(!text.includes('4111'));
  assert.match(text, /\[tools: renew \(Success\), pay \(Failure\)\]/);
  assert.match(text, /\[guardrail blocked the reply\]/);
  assert.match(text, /\[customer asked for a person; AVA session ended: Exit: AgentRequestedByUser\]/);
});

test('sessions are analyzed in the background once, then served from the saved analyses', async () => {
  const silent = { ...ava.summarizeAvaSession('s2', [{ ...turns[0], sessionId: 's2' }], bot) };
  const build = { interval: {}, generatedAt: '', truncated: false, sessions: [ava.summarizeAvaSession('s1', turns.slice(), bot), silent], turns: new Map([['s1', turns], ['s2', [turns[0]]]]) };
  const first = ava.avaResponse('org', build);
  assert.equal(first.analysis.pending, 1); // the session with no customer input is never sent
  assert.equal(first.sessions[0].pending, true);
  while (ava.status.running) await new Promise((r) => setTimeout(r, 10));
  const second = ava.avaResponse('org', build);
  assert.equal(second.analysis.analyzed, 1);
  assert.equal(second.analysis.pending, 0);
  assert.deepEqual(second.sessions[0].analysis.intents.map((i) => i.name), ['Renew driver license', 'Speak to a person']);
  assert.equal(calls.length, 1);
  // The next session for the same AVA is told which intent names are already in use.
  const next = ava.analysisInput({ agentName: 'DMV Agent', botName: 'DMV Flow', media: 'Voice' }, 'AVA: hi', ['Renew driver license']);
  assert.match(next, /reuse one when it fits\):\nRenew driver license/);
});
