'use strict';
// Turn-by-turn transcript for one bot session, with sensitive values masked.


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

module.exports = { fetchTurns, turnResponseMs, maskText, summarizeTurn };
