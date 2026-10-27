'use strict';
// AVA-only reporting (dashboard v2). Builds one row per session that an Agentic Virtual Agent
// took part in, from the AVA turns alone: turns whose ask action carries agentDetails. Turns
// from classic bot steps in the same flow (NLU intent menus, slot prompts) are left out.
//
// Genesys records no intent on AVA turns, so the intents in a session and whether the AVA
// answered each one validly come from Claude reading the masked AVA transcript. Analyses run
// in the background, newest sessions first, and are saved to disk so each session is read
// once (again only if more turns arrive). Without ANTHROPIC_API_KEY the dashboard still shows
// every session with Genesys's own turn signals.

const fs = require('node:fs');
const path = require('node:path');
const { mapLimit } = require('./genesys');
const { maskText, summarizeTurn, turnResponseMs } = require('./detail');
const { claudeEnabled, askJson, isFatalClaudeError } = require('./claude');

const BOT_AGG = '/api/v2/analytics/bots/aggregates/query';
const TURN_PAGE_SIZE = 250;
const MAX_TURN_PAGES_PER_BOT = Number(process.env.MAX_TURN_PAGES_PER_BOT) || 40;
const EXCLUDED_BOT_TYPES = new Set((process.env.EXCLUDE_BOT_TYPES ?? 'VOICESURVEY').split(',').map((t) => t.trim()).filter(Boolean));
const MEDIA_BY_FLOW_TYPE = { BOT: 'Voice', DIGITALBOT: 'Messaging' };

const MODEL = process.env.AVA_MODEL || 'claude-opus-5-5';
const MAX_ANALYSES = Number(process.env.MAX_AVA_ANALYSES) || 300; // per date range load, newest first
const CACHE_FILE = process.env.AVA_CACHE_FILE || path.join(__dirname, '..', 'data', 'ava-analyses.json');
const MAX_TRANSCRIPT_CHARS = 40_000;
const MAX_KNOWN_INTENTS = 60;
// Bump when the verdicts or instructions change, so saved analyses are redone.
const PROMPT_VERSION = 1;

// Third-party bots report ids like "agent_operator?instance_name=..."; show the part before the query.
function displayBotName(id, name) {
  if (name && name !== id) return name;
  return id && id.includes('?') ? `${id.split('?')[0]} (third-party)` : id;
}

// ---------- Turns ----------
const isAvaTurn = (t) => Boolean(t.askAction?.agentDetails);

// Genesys's own per-turn signals that something went wrong with the AVA's reply.
function turnIssues(t) {
  const issues = [];
  if (t.askActionResult === 'Error') issues.push('error');
  if (t.askActionResult === 'GuardrailsViolation' || (t.guardrailEvents || []).length) issues.push('guardrail');
  for (const c of t.toolCalls || []) if (c.status && c.status !== 'Success') issues.push('tool_failed');
  if (t.userInput && !(t.botPrompts || []).length && t.askActionResult !== 'AgentRequestedByUser' && !t.sessionEndDetails) issues.push('no_reply');
  return issues;
}

function summarizeAvaSession(sessionId, turns, bot) {
  turns.sort((a, b) => (a.dateCreated || '').localeCompare(b.dateCreated || ''));
  const agents = [];
  const issues = { error: 0, guardrail: 0, tool_failed: 0, no_reply: 0 };
  const responseTimesMs = [];
  let toolCalls = 0;
  let customerTurns = 0;
  let agentRequested = false;
  for (const t of turns) {
    const a = t.askAction.agentDetails;
    if (!agents.some((x) => x.id === a.agentId && x.version === a.agentVersion)) agents.push({ id: a.agentId, name: a.agentName, version: a.agentVersion });
    if (t.userInput) customerTurns++;
    toolCalls += (t.toolCalls || []).length;
    if (t.askActionResult === 'AgentRequestedByUser') agentRequested = true;
    for (const i of turnIssues(t)) issues[i]++;
    const ms = turnResponseMs(t);
    if (ms != null) responseTimesMs.push(ms);
  }
  const last = turns[turns.length - 1];
  const end = turns.map((t) => t.sessionEndDetails).filter(Boolean).pop();
  return {
    id: sessionId,
    conversationId: turns[0].conversation?.id || null,
    botId: bot.id,
    botName: bot.name,
    media: MEDIA_BY_FLOW_TYPE[bot.type] || bot.type || null,
    agentName: agents[0]?.name || null,
    agents,
    start: turns[0].dateCreated || null,
    end: last.dateCompleted || last.dateCreated || null,
    turns: turns.length,
    customerTurns,
    toolCalls,
    issues,
    agentRequested,
    endReason: end ? `${end.type}: ${end.reason}` : null,
    responseTimesMs,
  };
}

async function fetchAvaTurns(request, botId, interval) {
  const bySession = new Map();
  let truncated = false;
  let path = `/api/v2/analytics/botflows/${encodeURIComponent(botId)}/reportingturns?pageSize=${TURN_PAGE_SIZE}&interval=${encodeURIComponent(interval)}`;
  for (let pages = 0; path; pages++) {
    if (pages >= MAX_TURN_PAGES_PER_BOT) {
      truncated = true;
      break;
    }
    let res;
    try {
      res = await request(path);
    } catch {
      break; // some bot types (third-party, some digital bots) don't report turns
    }
    for (const t of res.entities || []) {
      if (!t.sessionId || !isAvaTurn(t)) continue;
      if (!bySession.has(t.sessionId)) bySession.set(t.sessionId, []);
      bySession.get(t.sessionId).push(t);
    }
    path = res.nextUri || null;
  }
  return { bySession, truncated };
}

// ---------- Transcript for Claude ----------
const RESULT_NOTE = {
  NoInputCollection: 'customer said nothing',
  AgentRequestedByUser: 'customer asked for a person',
  GuardrailsViolation: 'guardrail blocked the reply',
  Error: 'error',
};

// Each turn holds the customer's input followed by the AVA's reply to it.
function avaTranscript(turns) {
  const lines = [];
  for (const raw of turns) {
    const t = summarizeTurn(raw);
    const notes = [
      t.result && t.result !== 'SuccessCollection' && (RESULT_NOTE[t.result] || `result: ${t.result}`),
      t.toolCalls.length && `tools: ${t.toolCalls.map((c) => `${c.name} (${c.status || 'unknown'})`).join(', ')}`,
      t.guardrailEvents && t.result !== 'GuardrailsViolation' && 'guardrail triggered',
      t.sessionEnd && `AVA session ended: ${t.sessionEnd}`,
    ].filter(Boolean);
    if (t.userInput) lines.push(`Customer: ${t.userInput}`);
    if (notes.length) lines.push(`[${notes.join('; ')}]`);
    for (const p of t.botPrompts) lines.push(`AVA: ${maskText(p)}`);
  }
  let text = lines.join('\n');
  if (text.length > MAX_TRANSCRIPT_CHARS) text = `[earlier turns omitted]\n${text.slice(-MAX_TRANSCRIPT_CHARS)}`;
  return text;
}

// ---------- Claude ----------
const VERDICTS = [
  { key: 'valid', label: 'Valid', description: 'The AVA understood the request and gave a relevant, complete response: it answered, completed the task, correctly declined something it must not do, or transferred because the customer asked for a person or a hand-off was the right step.' },
  { key: 'partial', label: 'Partly valid', description: 'The AVA addressed the request only in part, gave a vague answer, or the customer had to repeat or rephrase before it got there.' },
  { key: 'not_valid', label: 'Not valid', description: 'The AVA misunderstood, gave a wrong, irrelevant or made-up answer, hit an error or failed tool and could not finish, gave no reply, or transferred because it could not handle the request.' },
  { key: 'no_chance', label: 'Customer left first', description: 'The session ended before the AVA could respond to the request, for example the customer hung up mid-request.' },
];

const SCHEMA = {
  type: 'object',
  properties: {
    intents: {
      type: 'array',
      description: 'Every distinct intent in the order the customer raised it. Empty if the customer never asked for anything.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short, generic intent name in sentence case, 2 to 5 words, e.g. "Renew driver license". Reuse a known name when it means the same thing.' },
          customerAsked: { type: 'string', description: 'What the customer asked for, paraphrased in one short sentence without personal details.' },
          verdict: { type: 'string', enum: VERDICTS.map((v) => v.key) },
          why: { type: 'string', description: 'One sentence on why the response got this verdict, specific to the conversation.' },
        },
        required: ['name', 'customerAsked', 'verdict', 'why'],
        additionalProperties: false,
      },
    },
  },
  required: ['intents'],
  additionalProperties: false,
};

const SYSTEM = `You review the part of a customer conversation handled by a Genesys Cloud Agentic Virtual Agent (AVA), an AI agent that answers customers and can call tools. List each intent the customer raised and judge whether the AVA gave a valid response to it.

An intent is something the customer wanted to get done or find out (a task, question or request). These are not intents: greetings, thanks, small talk, and answering the AVA's own questions such as giving a name, date of birth, account number or a yes/no confirmation; those are steps inside an intent. Asking to speak with a person is an intent ("Speak to a person"). If the customer raises the same intent again later, list it once and judge the AVA's handling overall.

For each intent choose one verdict:
${VERDICTS.map((v) => `- ${v.key}: ${v.description}`).join('\n')}

Lines in [brackets] are signals Genesys recorded for that turn (tool calls and their status, guardrail blocks, errors, the customer saying nothing). A guardrail block is valid when the AVA was right to refuse. Base every judgment only on the transcript; you cannot see tool results beyond what the AVA said. Card numbers, PINs and similar values are masked with •.`;

function analysisInput(session, transcript, knownIntents) {
  const parts = [
    `AVA: ${session.agentName || 'unknown'} (in bot flow ${session.botName})`,
    `Channel: ${session.media || 'unknown'}`,
  ];
  if (knownIntents.length) parts.push(`Intent names already used for this AVA (reuse one when it fits):\n${knownIntents.join('\n')}`);
  parts.push(`AVA transcript:\n${transcript}`);
  return parts.join('\n\n');
}

// ---------- Saved analyses ----------
let store = null;
function loadStore() {
  if (store) return store;
  try {
    store = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    store = {};
  }
  return store;
}
let saveTimer = null;
function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    const tmp = `${CACHE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 1));
    fs.renameSync(tmp, CACHE_FILE);
  }, 200);
}

const storeKey = (orgKey, sessionId) => `${orgKey}:${sessionId}`;
// A saved analysis stays good while the prompt is unchanged and no turns were added since.
function savedAnalysis(orgKey, s) {
  const a = loadStore()[storeKey(orgKey, s.id)];
  return a && a.promptVersion === PROMPT_VERSION && a.turns === s.turns ? a : null;
}

// Intent names already given to this AVA's sessions, most used first, so names stay consistent.
function knownIntentNames(agentName) {
  const counts = new Map();
  for (const a of Object.values(loadStore())) {
    if (a.agentName !== agentName) continue;
    for (const i of a.intents || []) counts.set(i.name, (counts.get(i.name) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, MAX_KNOWN_INTENTS).map(([n]) => n);
}

// ---------- Background analysis ----------
// One queue per server: sessions waiting to be read, keyed like the store.
const queue = new Map(); // key -> { orgKey, session, turns }
const status = { running: false, done: 0, failed: 0, error: null, usage: { input: 0, output: 0 } };

async function analyzeOne({ orgKey, session, turns }) {
  const transcript = avaTranscript(turns);
  const { refused, data, model, usage } = await askJson({ model: MODEL, system: SYSTEM, input: analysisInput(session, transcript, knownIntentNames(session.agentName)), schema: SCHEMA });
  status.usage.input += usage.input || 0;
  status.usage.output += usage.output || 0;
  loadStore()[storeKey(orgKey, session.id)] = {
    agentName: session.agentName,
    intents: refused ? [] : data.intents.filter((i) => i.name?.trim() && VERDICTS.some((v) => v.key === i.verdict)),
    refused,
    model,
    turns: session.turns,
    promptVersion: PROMPT_VERSION,
    analyzedAt: new Date().toISOString(),
  };
  saveStore();
}

async function runQueue() {
  if (status.running) return;
  status.running = true;
  try {
    while (queue.size && !status.error) {
      const batch = [...queue.values()].sort((a, b) => (b.session.start || '').localeCompare(a.session.start || '')).slice(0, 12);
      await mapLimit(batch, 6, async (job) => {
        const key = storeKey(job.orgKey, job.session.id);
        try {
          await analyzeOne(job);
          status.done++;
        } catch (err) {
          status.failed++;
          if (isFatalClaudeError(err)) status.error = err.message;
          else console.error(`AVA analysis failed for ${job.session.id}: ${err.message}`);
        }
        queue.delete(key);
      });
    }
  } finally {
    status.running = false;
  }
}

function analysisEnabled() {
  return claudeEnabled() && process.env.AVA_ANALYSIS !== 'off';
}

// Queue every session in the build that has a customer request and no current analysis.
function queueAnalyses(orgKey, build) {
  if (!analysisEnabled() || status.error) return;
  const waiting = build.sessions.filter((s) => s.customerTurns > 0 && !savedAnalysis(orgKey, s)).slice(0, MAX_ANALYSES);
  for (const s of waiting) {
    const key = storeKey(orgKey, s.id);
    if (!queue.has(key)) queue.set(key, { orgKey, session: s, turns: build.turns.get(s.id) });
  }
  if (queue.size) runQueue();
}

// ---------- Build ----------
// The Genesys part: AVA sessions and their raw turns. Cached by the server per org and range.
async function buildAvaTurns(client, startIso, endIso) {
  const { request } = client;
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (!(startMs < endMs)) throw Object.assign(new Error('start must be before end'), { status: 400 });
  const interval = `${new Date(startMs).toISOString()}/${new Date(endMs).toISOString()}`;

  const [names, previews] = await Promise.all([
    request(BOT_AGG, { interval, groupBy: ['botId', 'botName', 'botFlowType'], metrics: ['nBotSessions'] }),
    // Sessions run from Architect's preview (test) mode; the browser hides them by default.
    request(BOT_AGG, { interval, groupBy: ['botSessionId', 'previewMode'], metrics: ['nBotSessions'] }),
  ]);
  const bots = new Map();
  for (const r of names.results || []) {
    const g = r.group;
    if (!g.botId || g.botId.includes('?') || EXCLUDED_BOT_TYPES.has(g.botFlowType)) continue;
    bots.set(g.botId, { id: g.botId, name: displayBotName(g.botId, g.botName), type: g.botFlowType || null });
  }
  const previewIds = new Set((previews.results || []).filter((r) => String(r.group.previewMode) === 'true').map((r) => r.group.botSessionId));

  const sessions = [];
  const turns = new Map();
  let truncated = false;
  await mapLimit([...bots.values()], 4, async (bot) => {
    const res = await fetchAvaTurns(request, bot.id, interval);
    if (res.truncated) truncated = true;
    for (const [id, list] of res.bySession) {
      const s = summarizeAvaSession(id, list, bot);
      s.preview = previewIds.has(id);
      sessions.push(s);
      turns.set(id, list);
    }
  });
  sessions.sort((a, b) => (b.start || '').localeCompare(a.start || ''));
  return {
    interval: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() },
    generatedAt: new Date().toISOString(),
    sessions,
    turns,
    truncated,
  };
}

// What the browser gets: the sessions with whatever analyses exist so far, plus progress.
function avaResponse(orgKey, build) {
  queueAnalyses(orgKey, build);
  const pending = new Set([...queue.values()].filter((j) => j.orgKey === orgKey).map((j) => j.session.id));
  let analyzed = 0;
  const sessions = build.sessions.map((s) => {
    const a = savedAnalysis(orgKey, s);
    if (a) analyzed++;
    return { ...s, analysis: a ? { intents: a.intents, refused: a.refused || false } : null, pending: pending.has(s.id) };
  });
  return {
    interval: build.interval,
    generatedAt: build.generatedAt,
    sessions,
    verdicts: VERDICTS,
    meta: { turnsTruncated: build.truncated },
    analysis: {
      enabled: analysisEnabled(),
      model: MODEL,
      analyzed,
      pending: pending.size,
      withRequests: build.sessions.filter((s) => s.customerTurns > 0).length,
      limit: MAX_ANALYSES,
      error: status.error,
    },
  };
}

module.exports = { buildAvaTurns, avaResponse, displayBotName, summarizeAvaSession, avaTranscript, analysisInput, turnIssues, isAvaTurn, VERDICTS, SCHEMA, status };
