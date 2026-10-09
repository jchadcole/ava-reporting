'use strict';
// Why escalated sessions went to a person. For each bot session whose conversation reached a
// queue or an agent, this gathers the bot transcript and Genesys's own AI summary (when the org
// has one), then asks Claude to sort the session into a "why" category with a short explanation.
// Analyses are saved to disk so each session is only sent once.
//
// Nothing is sent to Anthropic unless ANTHROPIC_API_KEY is set. Without it, the list still
// shows Genesys's summary reason where there is one.

const fs = require('node:fs');
const path = require('node:path');
const { mapLimit } = require('./genesys');
const { fetchTurns, maskText } = require('./detail');

const MODEL = process.env.ESCALATION_MODEL || 'claude-opus-5-5';
const MAX_SESSIONS = Number(process.env.MAX_ESCALATION_SESSIONS) || 300;
const CACHE_FILE = process.env.ESCALATION_CACHE_FILE || path.join(__dirname, '..', 'data', 'escalation-analyses.json');
const MAX_TRANSCRIPT_CHARS = 40_000;
// Bump when the categories or instructions change, so saved analyses are redone.
const PROMPT_VERSION = 1;

const CATEGORIES = [
  { key: 'not_resolved', label: 'AVA couldn’t resolve it', description: 'The request was outside what the virtual agent knows or can do, or it kept misunderstanding the customer, so a person was needed.' },
  { key: 'planned_handoff', label: 'Hand-off by design', description: 'The virtual agent did its part (for example identifying the customer or collecting details) and transferred because the flow is built to hand this kind of request to a person.' },
  { key: 'prefers_human', label: 'Customer wanted a person', description: 'The customer asked for or insisted on a person even though the virtual agent could probably have helped (for example asking for an agent straight away, or refusing to engage).' },
  { key: 'unsafe_request', label: 'Illegal or dangerous request', description: 'The customer asked for something illegal, harmful, fraudulent or against policy, and the virtual agent handed off rather than help.' },
  { key: 'customer_at_risk', label: 'Customer may be in danger', description: 'The customer said something suggesting they or someone else may be at risk: self-harm, abuse, a medical emergency, threats or a crisis.' },
  { key: 'other', label: 'Other or unclear', description: 'None of the above fits, or the transcript does not show why the session was escalated.' },
];

const SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string', enum: CATEGORIES.map((c) => c.key) },
    why: { type: 'string', description: 'One or two plain sentences on why this session went to a person, specific to what the customer said.' },
    initiatedBy: { type: 'string', enum: ['customer', 'virtual_agent', 'unclear'], description: 'Who started the hand-off: the customer asking for a person, or the virtual agent or flow transferring.' },
  },
  required: ['category', 'why', 'initiatedBy'],
  additionalProperties: false,
};

const SYSTEM = `You review customer conversations with a Genesys Cloud virtual agent (a bot or AI virtual agent) that ended with the customer being transferred to a human agent or queue. Work out why the session was escalated and put it in exactly one category:

${CATEGORIES.map((c) => `- ${c.key}: ${c.description}`).join('\n')}

If several apply, choose the one that best explains why the hand-off happened; safety categories (customer_at_risk, unsafe_request) take precedence when there is real evidence for them. Base the answer only on the conversation; do not guess beyond it. Card numbers, PINs and similar values have been masked with •.`;

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

// ---------- Claude ----------
let anthropic;
function analysisEnabled() {
  return Boolean(process.env.ANTHROPIC_API_KEY) && process.env.ESCALATION_ANALYSIS !== 'off';
}
function getAnthropic() {
  if (!anthropic) {
    const Anthropic = require('@anthropic-ai/sdk');
    anthropic = new (Anthropic.default || Anthropic)();
  }
  return anthropic;
}

async function classify(input) {
  const response = await getAnthropic().beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: input }],
  });
  if (response.stop_reason === 'refusal') {
    return { category: 'other', why: 'The model declined to analyze this conversation.', initiatedBy: 'unclear', model: response.model };
  }
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const parsed = JSON.parse(text);
  return { category: parsed.category, why: parsed.why, initiatedBy: parsed.initiatedBy, model: response.model };
}

// ---------- Inputs from Genesys ----------
// Genesys's own AI summary of the conversation, when the org generates them.
async function genesysSummary(request, conversationId) {
  const res = await request(`/api/v2/conversations/${encodeURIComponent(conversationId)}/summaries`).catch(() => null);
  const usable = (res?.sessionSummaries || []).filter((s) => s.status === 'Completed' && s.text && (s.confidence ?? 1) >= 0.3);
  if (!usable.length) return null;
  const best = usable.sort((a, b) => (b.reason ? 1 : 0) - (a.reason ? 1 : 0) || (b.confidence || 0) - (a.confidence || 0))[0];
  return {
    text: maskText(best.text),
    reason: best.reason?.text ? maskText([best.reason.text, best.reason.description].filter(Boolean).join(': ')) : null,
    resolution: best.resolution?.text ? maskText([best.resolution.text, best.resolution.description].filter(Boolean).join(': ')) : null,
  };
}

function transcriptText(session, turns) {
  const lines = [];
  // Each turn holds the customer's input followed by the bot's reply to it.
  for (const t of turns) {
    const notes = [
      t.intent && `intent: ${t.intent.name}`,
      t.virtualAgent && `AI agent: ${t.virtualAgent.name}`,
      t.toolCalls?.length && `tools: ${t.toolCalls.map((c) => `${c.name} (${c.status || 'unknown'})`).join(', ')}`,
      t.result && t.result !== 'SuccessCollection' && `result: ${t.result}`,
      t.sessionEnd && `bot session ended: ${t.sessionEnd}`,
    ].filter(Boolean);
    if (t.userInput) lines.push(`Customer: ${maskText(t.userInput)}`);
    if (notes.length) lines.push(`[${notes.join('; ')}]`);
    for (const p of t.botPrompts || []) lines.push(`Bot: ${maskText(p)}`);
  }
  let text = lines.join('\n');
  if (text.length > MAX_TRANSCRIPT_CHARS) text = `[earlier turns omitted]\n${text.slice(-MAX_TRANSCRIPT_CHARS)}`;
  return text;
}

function analysisInput(session, transcript, summary) {
  const after = session.escalation === 'agent' ? `connected to an agent${session.queueName ? ` from the ${session.queueName} queue` : ''}` : `sent to ${session.queueName ? `the ${session.queueName} queue` : 'a queue'} (no agent answered)`;
  const parts = [
    `Virtual agent: ${session.botName}`,
    `Channel: ${session.media || 'unknown'}`,
    `After the bot, the customer was ${after}.`,
  ];
  if (transcript) parts.push(`Bot transcript:\n${transcript}`);
  if (summary) parts.push(`Genesys's AI summary of the whole conversation:\n${summary.text}${summary.reason ? `\nContact reason: ${summary.reason}` : ''}`);
  return parts.join('\n\n');
}

// ---------- Build ----------
async function buildEscalations(client, orgKey, dataset) {
  const { request } = client;
  const escalated = dataset.sessions.filter((s) => (s.escalation === 'agent' || s.escalation === 'queue') && s.conversationId);
  const sessions = escalated.slice(0, MAX_SESSIONS); // the dataset is newest first
  const enabled = analysisEnabled();
  const saved = loadStore();
  let stopError = null; // a bad key or exhausted credit fails every call, so stop at the first one

  const rows = await mapLimit(sessions, 6, async (s) => {
    const key = `${orgKey}:${s.id}`;
    const prior = saved[key]?.promptVersion === PROMPT_VERSION ? saved[key] : null;
    const [turns, summary] = await Promise.all([
      s.botId && !s.botId.includes('?') ? fetchTurns(request, s.botId, s.id).catch(() => []) : [],
      genesysSummary(request, s.conversationId),
    ]);
    const transcript = turns.length ? transcriptText(s, turns) : '';
    let analysis = prior;
    let error = null;
    if (!analysis && enabled && !stopError && (transcript || summary)) {
      try {
        analysis = { ...(await classify(analysisInput(s, transcript, summary))), source: transcript ? 'transcript' : 'genesys-summary', promptVersion: PROMPT_VERSION, analyzedAt: new Date().toISOString() };
        saved[key] = analysis;
        saveStore();
      } catch (err) {
        error = err.message;
        if ([401, 403].includes(err.status) || /credit balance/i.test(err.message)) stopError = err.message;
      }
    }
    return {
      sessionId: s.id,
      hasTranscript: Boolean(transcript),
      genesysReason: summary?.reason || null,
      genesysSummary: summary?.text || null,
      category: analysis?.category || null,
      why: analysis?.why || null,
      initiatedBy: analysis?.initiatedBy || null,
      analysisSource: analysis?.source || null,
      error,
    };
  });

  return {
    analysisEnabled: enabled,
    model: MODEL,
    categories: CATEGORIES.map(({ key, label, description }) => ({ key, label, description })),
    analysisError: stopError,
    escalatedSessions: escalated.length,
    truncated: escalated.length > sessions.length,
    rows,
  };
}

module.exports = { buildEscalations, transcriptText, analysisInput, CATEGORIES, SCHEMA };
