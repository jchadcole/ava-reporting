'use strict';
// Independent totals straight from Genesys for the "Check against Genesys" view.
// The dashboard builds its numbers by merging per-session rows; these are Genesys's own
// org- or bot-level aggregates for the same interval, queried separately, so a merge or
// classification mistake shows up as a difference.

const BOT_AGG = '/api/v2/analytics/bots/aggregates/query';
const DETAILS = '/api/v2/analytics/conversations/details/query';
const DAY_MS = 86_400_000;
const EXCLUDED_BOT_TYPES = new Set((process.env.EXCLUDE_BOT_TYPES ?? 'VOICESURVEY').split(',').map((t) => t.trim()).filter(Boolean));

const botFilter = (botId) => (botId ? { filter: { type: 'and', predicates: [{ dimension: 'botId', value: botId }] } } : {});

// Whether a result group counts under the dashboard's preview filter (exclude, include or only).
function previewMatches(group, preview = 'include') {
  const isPreview = String(group.previewMode) === 'true';
  return preview === 'exclude' ? !isPreview : preview === 'only' ? isPreview : true;
}

// Sum a metric's stats across result groups, skipping bot types the dashboard leaves out.
function sumMetric(results, metric, field, preview) {
  let total = 0;
  for (const r of results || []) {
    if (EXCLUDED_BOT_TYPES.has(r.group.botFlowType) || !previewMatches(r.group, preview)) continue;
    for (const d of r.data || []) for (const m of d.metrics || []) if (m.metric === metric) total += m.stats[field] || 0;
  }
  return total;
}

// Conversation counts from the details query (totalHits only), in windows of up to 30 days.
async function countConversations(request, startMs, endMs, extraSegmentFilters) {
  let total = 0;
  for (let ws = startMs; ws < endMs; ws += 30 * DAY_MS) {
    const we = Math.min(endMs, ws + 30 * DAY_MS);
    const res = await request(DETAILS, {
      interval: `${new Date(ws).toISOString()}/${new Date(we).toISOString()}`,
      paging: { pageSize: 1, pageNumber: 1 },
      segmentFilters: [{ type: 'and', predicates: [{ dimension: 'purpose', value: 'botflow' }] }, ...extraSegmentFilters],
    });
    total += res.totalHits || 0;
  }
  return total;
}

async function buildVerification(client, startIso, endIso, botId, preview = 'include') {
  const { request } = client;
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  const interval = `${new Date(startMs).toISOString()}/${new Date(endMs).toISOString()}`;
  const metrics = ['nBotSessions', 'nBotSessionTurns', 'tBotExit', 'tBotDisconnect', 'tBotRecognitionFailure', 'oBotSessionQuery', 'oBotSessionQuerySelfServed'];

  // Preview sessions have no conversation, so conversation counts only make sense when they aren't the whole set.
  const countConversationsToo = !botId && preview !== 'only';
  const [totals, intents, conversations, withAgent] = await Promise.all([
    request(BOT_AGG, { interval, groupBy: ['botFlowType', 'previewMode'], metrics, ...botFilter(botId) }),
    request(BOT_AGG, { interval, groupBy: ['botFlowType', 'previewMode', 'botIntent'], metrics: ['oBotIntent'], ...botFilter(botId) }),
    // Conversation-level checks can't be narrowed to one bot through the details query.
    !countConversationsToo ? null : countConversations(request, startMs, endMs, []),
    !countConversationsToo ? null : countConversations(request, startMs, endMs, [{ type: 'and', predicates: [{ dimension: 'purpose', value: 'agent' }, { dimension: 'segmentType', value: 'interact' }] }]),
  ]);

  const intentCounts = {};
  for (const r of intents.results || []) {
    if (!r.group.botIntent || EXCLUDED_BOT_TYPES.has(r.group.botFlowType) || !previewMatches(r.group, preview)) continue;
    for (const d of r.data || []) for (const m of d.metrics || []) if (m.metric === 'oBotIntent') intentCounts[r.group.botIntent] = (intentCounts[r.group.botIntent] || 0) + m.stats.count;
  }

  return {
    interval: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() },
    botId: botId || null,
    preview,
    excludedBotTypes: [...EXCLUDED_BOT_TYPES],
    totals: {
      sessions: sumMetric(totals.results, 'nBotSessions', 'count', preview),
      turns: sumMetric(totals.results, 'nBotSessionTurns', 'count', preview),
      exits: sumMetric(totals.results, 'tBotExit', 'count', preview),
      disconnects: sumMetric(totals.results, 'tBotDisconnect', 'count', preview),
      recognitionFailures: sumMetric(totals.results, 'tBotRecognitionFailure', 'count', preview),
      queries: sumMetric(totals.results, 'oBotSessionQuery', 'sum', preview),
      selfServedQueries: sumMetric(totals.results, 'oBotSessionQuerySelfServed', 'sum', preview),
      conversations,
      conversationsWithAgent: withAgent,
    },
    intentSessions: intentCounts,
  };
}

module.exports = { buildVerification, sumMetric, previewMatches };
