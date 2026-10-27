// Metric calculations for the AVA dashboard (v2). Pure functions over AVA session rows, so the
// same code runs in the browser and in Node tests.
(function (root) {
  'use strict';

  // ---------- Per session ----------
  const intents = (s) => s.analysis?.intents || [];
  // Intents the AVA had a chance to answer (the customer didn't leave first).
  const judged = (s) => intents(s).filter((i) => i.verdict !== 'no_chance');

  // Did the AVA give a valid response to every intent in the session?
  //   all_valid / not_all_valid: Claude listed the intents and judged each one
  //   customer_left: every intent was cut off before the AVA could answer
  //   no_request: the customer never asked for anything
  //   pending / not_analyzed: no analysis yet
  function sessionVerdict(s) {
    if (s.customerTurns === 0) return 'no_request';
    if (!s.analysis) return s.pending ? 'pending' : 'not_analyzed';
    if (!intents(s).length) return 'no_request';
    const j = judged(s);
    if (!j.length) return 'customer_left';
    return j.every((i) => i.verdict === 'valid') ? 'all_valid' : 'not_all_valid';
  }

  const SESSION_VERDICT_LABEL = {
    all_valid: 'Yes',
    not_all_valid: 'No',
    customer_left: 'Customer left first',
    no_request: 'No request',
    pending: 'Being analyzed',
    not_analyzed: 'Not analyzed',
  };

  const issueCount = (s) => Object.values(s.issues || {}).reduce((a, b) => a + b, 0);

  function median(values) {
    if (!values.length) return null;
    const v = values.slice().sort((a, b) => a - b);
    const mid = v.length >> 1;
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  }
  const ratio = (a, b) => (b ? a / b : null);

  // ---------- Filters ----------
  function applyFilters(sessions, f = {}) {
    const q = (f.search || '').trim().toLowerCase();
    return sessions.filter((s) => {
      if (f.preview === 'only' ? !s.preview : f.preview !== 'include' && s.preview) return false;
      if (f.agent && s.agentName !== f.agent) return false;
      if (f.media && s.media !== f.media) return false;
      if (f.intent && !intents(s).some((i) => i.name === f.intent)) return false;
      if (f.verdict && sessionVerdict(s) !== f.verdict) return false;
      if (f.intentVerdict && !intents(s).some((i) => i.verdict === f.intentVerdict && (!f.intent || i.name === f.intent))) return false;
      if (f.issues === 'yes' && !issueCount(s)) return false;
      if (f.issues === 'no' && issueCount(s)) return false;
      if (q && !`${s.conversationId || ''} ${s.id}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }

  function options(sessions) {
    const agents = new Set();
    const media = new Set();
    const names = new Set();
    for (const s of sessions) {
      if (s.agentName) agents.add(s.agentName);
      if (s.media) media.add(s.media);
      for (const i of intents(s)) names.add(i.name);
    }
    const sort = (set) => [...set].sort((a, b) => a.localeCompare(b));
    return { agents: sort(agents), media: sort(media), intents: sort(names) };
  }

  // ---------- Summaries ----------
  function tallyIntents(sessions) {
    const t = { valid: 0, partial: 0, not_valid: 0, no_chance: 0 };
    for (const s of sessions) for (const i of intents(s)) if (i.verdict in t) t[i.verdict]++;
    return t;
  }

  function summarize(sessions) {
    const analyzed = sessions.filter((s) => s.analysis);
    const verdicts = {};
    for (const s of sessions) {
      const v = sessionVerdict(s);
      verdicts[v] = (verdicts[v] || 0) + 1;
    }
    const scored = (verdicts.all_valid || 0) + (verdicts.not_all_valid || 0);
    const withIntents = analyzed.filter((s) => intents(s).length);
    const t = tallyIntents(sessions);
    const judgedIntents = t.valid + t.partial + t.not_valid;
    const responseTimes = sessions.flatMap((s) => s.responseTimesMs || []);
    let toolCalls = 0, toolFailures = 0, guardrails = 0, errors = 0;
    for (const s of sessions) {
      toolCalls += s.toolCalls || 0;
      toolFailures += s.issues?.tool_failed || 0;
      guardrails += s.issues?.guardrail || 0;
      errors += (s.issues?.error || 0) + (s.issues?.no_reply || 0);
    }
    return {
      sessions: sessions.length,
      analyzed: analyzed.length,
      verdicts,
      scored,
      allValid: verdicts.all_valid || 0,
      allValidRate: ratio(verdicts.all_valid || 0, scored),
      intents: t.valid + t.partial + t.not_valid + t.no_chance,
      intentsPerSession: ratio(withIntents.reduce((a, s) => a + intents(s).length, 0), withIntents.length),
      multiIntent: withIntents.filter((s) => intents(s).length > 1).length,
      intentVerdicts: t,
      judgedIntents,
      validIntentRate: ratio(t.valid, judgedIntents),
      toolCalls,
      toolFailures,
      toolSuccessRate: toolCalls ? 1 - toolFailures / toolCalls : null,
      guardrails,
      errors,
      agentRequested: sessions.filter((s) => s.agentRequested).length,
      medianResponseMs: median(responseTimes),
      responseTurns: responseTimes.length,
    };
  }

  // One row per intent name: how often it came up and how the AVA handled it.
  function intentTable(sessions) {
    const rows = new Map();
    for (const s of sessions) {
      const seen = new Set();
      for (const i of intents(s)) {
        if (!rows.has(i.name)) rows.set(i.name, { intent: i.name, sessions: 0, valid: 0, partial: 0, not_valid: 0, no_chance: 0 });
        const r = rows.get(i.name);
        if (!seen.has(i.name)) r.sessions++;
        seen.add(i.name);
        if (i.verdict in r) r[i.verdict]++;
      }
    }
    return [...rows.values()]
      .map((r) => ({ ...r, judged: r.valid + r.partial + r.not_valid, validRate: ratio(r.valid, r.valid + r.partial + r.not_valid) }))
      .sort((a, b) => b.sessions - a.sessions || a.intent.localeCompare(b.intent));
  }

  // One row per AVA (all versions together).
  function agentTable(sessions) {
    const groups = new Map();
    for (const s of sessions) {
      const k = s.agentName || '(unknown)';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(s);
    }
    return [...groups].map(([agentName, list]) => {
      const sum = summarize(list);
      const versions = new Set(list.flatMap((s) => (s.agents || []).filter((a) => a.name === agentName).map((a) => a.version)));
      return {
        agentName,
        versions: [...versions].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b)),
        media: [...new Set(list.map((s) => s.media).filter(Boolean))].join(', '),
        sessions: list.length,
        analyzed: sum.analyzed,
        intentsPerSession: sum.intentsPerSession,
        allValidRate: sum.allValidRate,
        validIntentRate: sum.validIntentRate,
        toolCalls: sum.toolCalls,
        toolFailures: sum.toolFailures,
        guardrails: sum.guardrails,
        medianResponseMs: sum.medianResponseMs,
      };
    }).sort((a, b) => b.sessions - a.sessions);
  }

  function localDay(d) {
    const x = new Date(d);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  }

  const api = { sessionVerdict, SESSION_VERDICT_LABEL, intents, judged, issueCount, median, applyFilters, options, summarize, intentTable, agentTable, localDay };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AvaMetrics = api;
})(typeof window !== 'undefined' ? window : globalThis);
