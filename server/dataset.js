'use strict';
// Builds one row per bot session for a time interval. Every dashboard number and the
// session list are computed from these rows in the browser (public/metrics.js), so
// filters apply to the KPIs, charts and list consistently.

const { mapLimit } = require('./genesys');
const { turnResponseMs } = require('./detail');

const BOT_AGG = '/api/v2/analytics/bots/aggregates/query';
const DETAILS = '/api/v2/analytics/conversations/details/query';
const DAY_MS = 86_400_000;
const DETAILS_WINDOW_MS = 30 * DAY_MS; // details queries are limited to ~31 days per call
const DETAILS_PAGE_SIZE = 100;
const MAX_DETAIL_CONVERSATIONS = Number(process.env.MAX_DETAIL_CONVERSATIONS) || 5000;
const TURN_PAGE_SIZE = 250;
const MAX_TURN_PAGES_PER_BOT = Number(process.env.MAX_TURN_PAGES_PER_BOT) || 40;

const MEDIA_LABEL = { CALL: 'Voice', MESSAGING: 'Messaging' };
// Survey "bots" are not virtual agents, so they are left out unless configured otherwise.
const EXCLUDED_BOT_TYPES = new Set((process.env.EXCLUDE_BOT_TYPES ?? 'VOICESURVEY').split(',').map((t) => t.trim()).filter(Boolean));

// Third-party bots report ids like "agent_operator?instance_name=..."; show the part before the query.
function displayBotName(id, name) {
  if (name && name !== id) return name;
  return id && id.includes('?') ? `${id.split('?')[0]} (third-party)` : id;
}

function botAgg(request, interval, groupBy, metrics, extra = {}) {
  return request(BOT_AGG, { interval, groupBy, metrics, ...extra });
}

function metricMap(metrics) {
  const out = {};
  for (const m of metrics || []) out[m.metric] = m.stats;
  return out;
}

// Merge the per-metric aggregate rows into session records keyed by botSessionId.
function mergeSessionRows(coreResults, intentResults, failureResults, finalIntentResults, botNames) {
  const sessions = new Map();
  const get = (group) => {
    let s = sessions.get(group.botSessionId);
    if (!s) {
      s = {
        id: group.botSessionId,
        botId: null,
        conversationId: null,
        media: null,
        bucket: null,
        durationMs: null,
        turns: 0,
        outcome: 'unknown',
        botResult: null,
        queries: 0,
        selfServedQueries: 0,
        intents: [],
        finalIntent: null,
        recognitionFailures: 0,
        recognitionFailureReasons: [],
      };
      sessions.set(group.botSessionId, s);
    }
    if (group.botId) s.botId = group.botId;
    if (group.conversationId) s.conversationId = group.conversationId;
    if (group.mediaType) s.media = MEDIA_LABEL[group.mediaType] || group.mediaType;
    return s;
  };

  for (const row of coreResults) {
    if (!row.group.botSessionId) continue;
    const s = get(row.group);
    for (const d of row.data || []) {
      const start = d.interval.split('/')[0];
      if (!s.bucket || start < s.bucket) s.bucket = start;
      const m = metricMap(d.metrics);
      if (m.nBotSessionTurns) s.turns += m.nBotSessionTurns.count;
      if (m.tBotSession) s.durationMs = (s.durationMs || 0) + m.tBotSession.sum;
      if (m.oBotSessionQuery) s.queries += m.oBotSessionQuery.sum;
      if (m.oBotSessionQuerySelfServed) s.selfServedQueries += m.oBotSessionQuerySelfServed.sum;
      if (m.tBotExit) s.outcome = 'exit';
      if (m.tBotDisconnect) s.outcome = 'disconnect';
      if ((m.tBotExit || m.tBotDisconnect) && row.group.botResult) s.botResult = row.group.botResult;
    }
  }
  for (const row of intentResults) {
    const s = sessions.get(row.group.botSessionId);
    if (s && row.group.botIntent && !s.intents.includes(row.group.botIntent)) s.intents.push(row.group.botIntent);
  }
  for (const row of failureResults) {
    const s = sessions.get(row.group.botSessionId);
    if (!s) continue;
    for (const d of row.data || []) {
      const m = metricMap(d.metrics);
      if (m.tBotRecognitionFailure) s.recognitionFailures += m.tBotRecognitionFailure.count;
    }
    const reason = row.group.botRecognitionFailureReason;
    if (reason && !s.recognitionFailureReasons.includes(reason)) s.recognitionFailureReasons.push(reason);
  }
  for (const row of finalIntentResults) {
    const s = sessions.get(row.group.botSessionId);
    if (s && row.group.botFinalIntent) s.finalIntent = row.group.botFinalIntent;
  }
  for (const s of sessions.values()) {
    const bot = botNames.get(s.botId);
    s.botName = displayBotName(s.botId, bot?.name);
    s.botType = bot?.type || null;
  }
  return [...sessions.values()];
}

function participantStart(p) {
  let start = null;
  for (const sess of p.sessions || []) {
    for (const seg of sess.segments || []) {
      if (!start || seg.segmentStart < start) start = seg.segmentStart;
    }
  }
  return start;
}

// Reduce a conversation-details record to what the dashboard needs: when it started,
// when each bot flow ran, and whether the customer reached a queue or an agent.
function summarizeConversation(c) {
  const botRuns = [];
  let reachedQueue = false;
  let reachedAgent = false;
  let queueName = null;
  for (const p of c.participants || []) {
    if (p.purpose === 'acd') {
      reachedQueue = true;
      queueName = queueName || p.participantName || null;
    }
    if (p.purpose === 'agent') {
      const interacted = (p.sessions || []).some((s) => (s.segments || []).some((seg) => seg.segmentType === 'interact'));
      if (interacted) reachedAgent = true;
    }
    for (const sess of p.sessions || []) {
      const flow = sess.flow;
      if (flow && /BOT/.test(flow.flowType || '')) {
        const start = (sess.segments || []).reduce((min, seg) => (!min || seg.segmentStart < min ? seg.segmentStart : min), null);
        botRuns.push({ flowId: flow.flowId, start, exitReason: flow.exitReason || null, transferTargetName: flow.transferTargetName || null });
      }
    }
  }
  botRuns.sort((a, b) => (a.start || '').localeCompare(b.start || ''));
  return {
    conversationId: c.conversationId,
    start: c.conversationStart,
    botRuns,
    escalation: reachedAgent ? 'agent' : reachedQueue ? 'queue' : 'none',
    queueName,
  };
}

async function fetchConversationSummaries(request, startMs, endMs) {
  const out = new Map();
  let truncated = false;
  for (let ws = startMs; ws < endMs && !truncated; ws += DETAILS_WINDOW_MS) {
    const we = Math.min(endMs, ws + DETAILS_WINDOW_MS);
    const interval = `${new Date(ws).toISOString()}/${new Date(we).toISOString()}`;
    for (let page = 1; ; page++) {
      const res = await request(DETAILS, {
        interval,
        order: 'desc',
        orderBy: 'conversationStart',
        paging: { pageSize: DETAILS_PAGE_SIZE, pageNumber: page },
        segmentFilters: [{ type: 'and', predicates: [{ dimension: 'purpose', value: 'botflow' }] }],
      });
      for (const c of res.conversations || []) out.set(c.conversationId, summarizeConversation(c));
      if (out.size >= MAX_DETAIL_CONVERSATIONS) {
        truncated = true;
        break;
      }
      if (!res.conversations || res.conversations.length < DETAILS_PAGE_SIZE) break;
    }
  }
  return { conversations: out, truncated };
}

// Attach conversation-level facts (exact start time, escalation) to each session.
function attachConversations(sessions, conversations) {
  const byConversation = new Map();
  for (const s of sessions) {
    if (!s.conversationId) continue;
    if (!byConversation.has(s.conversationId)) byConversation.set(s.conversationId, []);
    byConversation.get(s.conversationId).push(s);
  }
  for (const [cid, group] of byConversation) {
    const conv = conversations.get(cid);
    if (!conv) continue;
    group.sort((a, b) => (a.bucket || '').localeCompare(b.bucket || ''));
    const runsByBot = new Map();
    for (const run of conv.botRuns) {
      if (!runsByBot.has(run.flowId)) runsByBot.set(run.flowId, []);
      runsByBot.get(run.flowId).push(run);
    }
    for (const s of group) {
      const run = runsByBot.get(s.botId)?.shift();
      s.start = run?.start || conv.start;
      s.conversationStart = conv.start;
      s.escalation = conv.escalation;
      s.queueName = conv.queueName;
      if (run?.transferTargetName && !s.queueName) s.queueName = run.transferTargetName;
    }
  }
  for (const s of sessions) {
    if (!s.start) s.start = s.bucket;
    if (s.escalation === undefined) s.escalation = null; // conversation details not available
    delete s.bucket;
  }
  return sessions;
}

// Bot response time per customer turn, keyed by bot session id. Reporting turns are
// only available per bot, so each bot with sessions in the interval is paged through.
async function fetchResponseTimes(request, botIds, interval) {
  const bySession = new Map();
  let truncated = false;
  await mapLimit(botIds, 4, async (botId) => {
    let path = `/api/v2/analytics/botflows/${encodeURIComponent(botId)}/reportingturns?pageSize=${TURN_PAGE_SIZE}&interval=${encodeURIComponent(interval)}`;
    let pages = 0;
    while (path) {
      if (pages++ >= MAX_TURN_PAGES_PER_BOT) {
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
        const ms = turnResponseMs(t);
        if (ms == null || !t.sessionId) continue;
        if (!bySession.has(t.sessionId)) bySession.set(t.sessionId, []);
        bySession.get(t.sessionId).push(ms);
      }
      path = res.nextUri || null;
    }
  });
  return { bySession, truncated };
}

async function buildDataset(client, startIso, endIso) {
  const { request } = client;
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (!(startMs < endMs)) throw Object.assign(new Error('start must be before end'), { status: 400 });
  const interval = `${new Date(startMs).toISOString()}/${new Date(endMs).toISOString()}`;
  // Daily buckets only serve as a fallback timestamp when conversation details are missing.
  const granularity = endMs - startMs > DAY_MS ? 'P1D' : undefined;

  const [names, core, intents, failures, finals, details] = await Promise.all([
    botAgg(request, interval, ['botId', 'botName', 'botFlowType'], ['nBotSessions']),
    botAgg(
      request,
      interval,
      ['botSessionId', 'botId', 'conversationId', 'botResult'],
      ['nBotSessions', 'nBotSessionTurns', 'tBotSession', 'tBotExit', 'tBotDisconnect', 'oBotSessionQuery', 'oBotSessionQuerySelfServed'],
      granularity ? { granularity } : {}
    ),
    botAgg(request, interval, ['botSessionId', 'botIntent'], ['oBotIntent']),
    botAgg(request, interval, ['botSessionId', 'botRecognitionFailureReason'], ['tBotRecognitionFailure']),
    botAgg(request, interval, ['botSessionId', 'botFinalIntent'], ['tBotExit', 'tBotDisconnect']),
    fetchConversationSummaries(request, startMs, endMs),
  ]);

  const botNames = new Map();
  for (const r of names.results || []) {
    if (r.group.botId) botNames.set(r.group.botId, { name: r.group.botName || r.group.botId, type: r.group.botFlowType || null });
  }
  const merged = mergeSessionRows(core.results || [], intents.results || [], failures.results || [], finals.results || [], botNames);
  const sessions = attachConversations(
    merged.filter((s) => !EXCLUDED_BOT_TYPES.has(s.botType)),
    details.conversations
  );
  const botIds = [...new Set(sessions.map((s) => s.botId).filter((id) => id && !id.includes('?')))];
  const responses = await fetchResponseTimes(request, botIds, interval);
  for (const s of sessions) s.responseTimesMs = responses.bySession.get(s.id) || [];
  sessions.sort((a, b) => (b.start || '').localeCompare(a.start || ''));

  return {
    interval: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() },
    generatedAt: new Date().toISOString(),
    sessions,
    meta: {
      conversationsWithDetails: details.conversations.size,
      detailsTruncated: details.truncated,
      responseTimesTruncated: responses.truncated,
    },
  };
}

module.exports = { buildDataset, displayBotName, mergeSessionRows, summarizeConversation, attachConversations };
