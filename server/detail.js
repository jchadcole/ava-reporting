'use strict';
// Drill-down for one bot session: the conversation journey (which flows, queues and
// agents it passed through) and the turn-by-turn bot transcript.


const MASK = process.env.MASK_SENSITIVE !== 'false';
const SENSITIVE_SLOT = /card|cvv|cvc|security|ssn|social|pin|password|account|routing|dob|birth/i;

// Hide long digit runs (card numbers, PINs, account numbers) in customer input.
function maskText(text) {
  if (!MASK || !text) return text;
  return text.replace(/\d[\d\s-]{2,}\d/g, (run) => {
    const digits = run.replace(/\D/g, '');
    if (digits.length < 4) return run;
    if (digits.length >= 12) return '•'.repeat(digits.length - 4) + digits.slice(-4);
    return '•'.repeat(digits.length);
  });
}

function maskSlot(slot) {
  if (!MASK) return slot.value;
  if (SENSITIVE_SLOT.test(`${slot.name} ${slot.type}`)) return '•••';
  return maskText(slot.value);
}

const PURPOSE_LABEL = {
  customer: 'Customer',
  external: 'Customer',
  ivr: 'Call flow',
  botflow: 'Bot',
  acd: 'Queue',
  agent: 'Agent',
  workflow: 'Workflow',
  voicesurveyflow: 'Survey',
};

const userNames = new Map(); // userId -> Promise<name|null>
function agentName(request, userId) {
  if (!userId) return Promise.resolve(null);
  if (!userNames.has(userId)) {
    userNames.set(userId, request(`/api/v2/users/${encodeURIComponent(userId)}`).then((u) => u.name || null, () => null));
  }
  return userNames.get(userId);
}

function summarizeParticipant(p) {
  let start = null;
  let end = null;
  let flow = null;
  let disconnectType = null;
  for (const sess of p.sessions || []) {
    if (sess.flow) flow = sess.flow;
    for (const seg of sess.segments || []) {
      if (!start || seg.segmentStart < start) start = seg.segmentStart;
      if (seg.segmentEnd && (!end || seg.segmentEnd > end)) end = seg.segmentEnd;
      if (seg.disconnectType) disconnectType = seg.disconnectType;
    }
  }
  const isCustomer = p.purpose === 'customer' || p.purpose === 'external';
  return {
    role: PURPOSE_LABEL[p.purpose] || p.purpose,
    // Customer names and numbers are not needed for bot reporting, so they never leave the server.
    // Queue participants carry their in-queue flow, but the queue name is what matters here.
    name: isCustomer ? null : p.purpose === 'acd' ? p.participantName || flow?.flowName || null : flow?.flowName || p.participantName || null,
    start,
    end,
    durationMs: start && end ? Date.parse(end) - Date.parse(start) : null,
    exitReason: flow?.exitReason || null,
    transferTarget: flow?.transferTargetName || null,
    disconnectType,
  };
}

// Bot response time for a customer turn: from the moment the customer's input was
// captured (dateCreated) until the bot finished processing it and had its reply ready
// (dateCompleted). Voice turns mark customer input with dateInputStarted; messaging
// turns only carry the userInput text. The greeting turn has neither and is skipped.
function turnResponseMs(t) {
  if (!(t.dateInputStarted || t.userInput) || !t.dateCreated || !t.dateCompleted) return null;
  const ms = Date.parse(t.dateCompleted) - Date.parse(t.dateCreated);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function summarizeTurn(t) {
  return {
    time: t.dateCreated,
    responseMs: turnResponseMs(t),
    userInput: maskText(t.userInput || ''),
    botPrompts: t.botPrompts || [],
    action: t.askAction ? { name: t.askAction.actionName, type: t.askAction.actionType } : null,
    virtualAgent: t.askAction?.agentDetails ? { name: t.askAction.agentDetails.agentName, version: t.askAction.agentDetails.agentVersion } : null,
    result: t.askActionResult || null,
    intent: t.intent?.name ? { name: t.intent.name, confidence: t.intent.confidence } : null,
    slots: (t.intent?.slots || []).map((s) => ({ name: s.name, value: maskSlot(s), confidence: s.confidence })),
    toolCalls: (t.toolCalls || []).map((c) => ({ name: c.toolName, type: c.toolType, status: c.status, latencyMs: c.latencyMs ?? null })),
    guardrailEvents: (t.guardrailEvents || []).length,
    sessionEnd: t.sessionEndDetails ? `${t.sessionEndDetails.type}: ${t.sessionEndDetails.reason}` : null,
  };
}

async function fetchTurns(request, botId, sessionId) {
  const turns = [];
  let path = `/api/v2/analytics/botflows/${encodeURIComponent(botId)}/reportingturns?pageSize=100&sessionId=${encodeURIComponent(sessionId)}`;
  for (let i = 0; path && i < 20; i++) {
    const res = await request(path);
    turns.push(...(res.entities || []));
    path = res.nextUri || null;
  }
  turns.sort((a, b) => (a.dateCreated || '').localeCompare(b.dateCreated || ''));
  return turns.map(summarizeTurn);
}

async function getSessionDetail(client, { conversationId, botId, sessionId }) {
  const { request } = client;
  const [conversation, turns] = await Promise.all([
    conversationId ? request(`/api/v2/analytics/conversations/${encodeURIComponent(conversationId)}/details`).catch(() => null) : null,
    botId && sessionId ? fetchTurns(request, botId, sessionId).catch(() => []) : [],
  ]);
  const participants = conversation?.participants || [];
  const names = await Promise.all(participants.map((p) => (p.purpose === 'agent' ? agentName(request, p.userId) : null)));
  const journey = participants
    .map((p, i) => ({ ...summarizeParticipant(p), ...(names[i] ? { name: names[i] } : {}) }))
    .sort((a, b) => (a.start || '').localeCompare(b.start || ''));
  return {
    conversationId,
    sessionId,
    conversationStart: conversation?.conversationStart || null,
    conversationEnd: conversation?.conversationEnd || null,
    journey,
    turns,
  };
}

module.exports = { getSessionDetail, fetchTurns, turnResponseMs, maskText, summarizeTurn, summarizeParticipant };
