// Pure reporting logic over bot-session rows. Loaded as a classic script in the browser
// (window.AvaMetrics) and with require() in tests.
(function (root) {
  'use strict';

  const RESULT_LABELS = {
    ExitRequestedByBot: 'Bot handed back to the flow',
    ExitRequestedByUser: 'Customer asked to leave the bot',
    ExitAgentRequestedByUser: 'Customer asked for an agent',
    ExitRecognitionFailure: 'Exited after recognition failures',
    ExitError: 'Exited on an error',
    DisconnectRequestedByUser: 'Customer disconnected',
    DisconnectRequestedByBot: 'Bot ended the conversation',
    DisconnectSessionExpired: 'Session expired',
    DisconnectError: 'Disconnected on an error',
  };

  const FAILURE_LABELS = {
    NoMatchCollection: 'No match (didn’t understand)',
    NoInputCollection: 'No input (silence / no reply)',
    NoMatchConfirmation: 'No match on confirmation',
    NoInputConfirmation: 'No input on confirmation',
  };

  function humanize(code) {
    return code ? code.replace(/([a-z])([A-Z])/g, '$1 $2') : 'Unknown';
  }
  const resultLabel = (code) => (code ? RESULT_LABELS[code] || humanize(code) : 'Still active / not reported');
  const failureLabel = (code) => FAILURE_LABELS[code] || humanize(code);

  // Contained = the conversation never reached a queue or agent after the bot.
  // When conversation details are missing we fall back to the bot's own outcome:
  // a disconnect inside the bot counts as contained, an exit back to the flow as escalated.
  function containment(s) {
    if (s.escalation === 'agent' || s.escalation === 'queue') return 'escalated';
    if (s.escalation === 'none') return 'contained';
    if (s.outcome === 'disconnect') return 'contained';
    if (s.outcome === 'exit') return 'escalated';
    return 'unknown';
  }

  function applyFilters(sessions, f = {}) {
    const bots = f.botIds && f.botIds.length ? new Set(f.botIds) : null;
    const q = (f.search || '').trim().toLowerCase();
    return sessions.filter((s) => {
      if (bots && !bots.has(s.botId)) return false;
      if (f.media && s.media !== f.media) return false;
      if (f.intent && !(s.intents.includes(f.intent) || s.finalIntent === f.intent)) return false;
      if (f.containment && containment(s) !== f.containment) return false;
      if (f.botResult && (s.botResult || '') !== f.botResult) return false;
      if (f.recognitionFailure === 'yes' && !s.recognitionFailures) return false;
      if (f.recognitionFailure === 'no' && s.recognitionFailures) return false;
      if (q && !(`${s.conversationId || ''} ${s.id}`.toLowerCase().includes(q))) return false;
      return true;
    });
  }

  const ratio = (n, d) => (d ? n / d : null);
  const median = (values) => {
    const v = values.filter((x) => x != null).sort((a, b) => a - b);
    if (!v.length) return null;
    const mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  };
  const mean = (values) => {
    const v = values.filter((x) => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };

  // Bot response times are per customer turn; org- and bot-level figures pool every
  // turn rather than averaging per-session values, so a long session weighs more.
  function responseStats(sessions) {
    const times = [];
    let timedSessions = 0;
    for (const s of sessions) {
      if (s.responseTimesMs?.length) timedSessions++;
      for (const ms of s.responseTimesMs || []) times.push(ms);
    }
    return { responseTurns: times.length, timedSessions, medianResponseMs: median(times), maxResponseMs: times.length ? times.reduce((a, b) => (b > a ? b : a)) : null };
  }

  function sessionResponse(s) {
    return responseStats([s]);
  }

  function summarize(sessions) {
    let contained = 0, escalated = 0, unknown = 0, reachedAgent = 0, inferred = 0;
    let queries = 0, served = 0, withFailure = 0, withIntent = 0;
    for (const s of sessions) {
      const c = containment(s);
      if (c === 'contained') contained++;
      else if (c === 'escalated') escalated++;
      else unknown++;
      if (s.escalation === 'agent') reachedAgent++;
      if (s.escalation == null) inferred++;
      queries += s.queries || 0;
      served += s.selfServedQueries || 0;
      if (s.recognitionFailures) withFailure++;
      if (s.intents.length) withIntent++;
    }
    const known = contained + escalated;
    return {
      sessions: sessions.length,
      contained,
      escalated,
      unknown,
      inferred,
      reachedAgent,
      containmentRate: ratio(contained, known),
      escalationRate: ratio(escalated, known),
      agentRate: ratio(reachedAgent, sessions.length),
      selfServiceRate: ratio(served, queries),
      queries,
      intentRate: ratio(withIntent, sessions.length),
      recognitionFailureRate: ratio(withFailure, sessions.length),
      avgTurns: mean(sessions.map((s) => s.turns)),
      // Median, because messaging sessions can stay open for days and swamp an average.
      medianDurationMs: median(sessions.map((s) => s.durationMs)),
      ...responseStats(sessions),
    };
  }

  function localDay(iso) {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // Daily contained / escalated counts, with empty days filled across [startIso, endIso).
  function byDay(sessions, startIso, endIso) {
    const days = new Map();
    const cursor = new Date(startIso);
    cursor.setHours(0, 0, 0, 0);
    const end = new Date(endIso);
    while (cursor < end) {
      days.set(localDay(cursor), { day: localDay(cursor), contained: 0, escalated: 0, unknown: 0 });
      cursor.setDate(cursor.getDate() + 1);
    }
    for (const s of sessions) {
      if (!s.start) continue;
      const key = localDay(s.start);
      if (!days.has(key)) days.set(key, { day: key, contained: 0, escalated: 0, unknown: 0 });
      days.get(key)[containment(s)]++;
    }
    return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
  }

  function countBy(sessions, keyFn, labelFn) {
    const counts = new Map();
    for (const s of sessions) {
      for (const key of [].concat(keyFn(s))) {
        if (key === undefined) continue;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([key, count]) => ({ key, label: labelFn ? labelFn(key) : key, count }))
      .sort((a, b) => b.count - a.count);
  }

  const byResult = (sessions) => countBy(sessions, (s) => s.botResult || null, resultLabel);
  const byFailureReason = (sessions) => countBy(sessions, (s) => s.recognitionFailureReasons, failureLabel);

  function groupTable(sessions, keysFn, describe) {
    const groups = new Map();
    for (const s of sessions) {
      for (const key of keysFn(s)) {
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(s);
      }
    }
    return [...groups.entries()]
      .map(([key, rows]) => ({ key, ...describe(key, rows), ...summarize(rows) }))
      .sort((a, b) => b.sessions - a.sessions);
  }

  function intentTable(sessions) {
    const total = sessions.length;
    return groupTable(
      sessions,
      (s) => [...new Set(s.intents.concat(s.finalIntent ? [s.finalIntent] : []))],
      (key, rows) => ({ intent: key, share: ratio(rows.length, total), asFinal: rows.filter((r) => r.finalIntent === key).length })
    );
  }

  function botTable(sessions) {
    return groupTable(
      sessions,
      (s) => [s.botId],
      (key, rows) => ({ botId: key, botName: rows[0].botName, botType: rows[0].botType, media: [...new Set(rows.map((r) => r.media))].join(', ') })
    );
  }

  function options(sessions) {
    const bots = new Map();
    const intents = new Set();
    const results = new Set();
    const media = new Set();
    for (const s of sessions) {
      bots.set(s.botId, s.botName);
      s.intents.forEach((i) => intents.add(i));
      if (s.finalIntent) intents.add(s.finalIntent);
      if (s.botResult) results.add(s.botResult);
      if (s.media) media.add(s.media);
    }
    const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });
    return {
      bots: [...bots.entries()].map(([id, name]) => ({ id, name: name || id })).sort((a, b) => byName(a.name, b.name)),
      intents: [...intents].sort(byName),
      results: [...results].sort().map((code) => ({ code, label: resultLabel(code) })),
      media: [...media].sort(),
    };
  }

  const api = { containment, applyFilters, summarize, byDay, byResult, byFailureReason, intentTable, botTable, options, resultLabel, failureLabel, localDay, median, responseStats, sessionResponse };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AvaMetrics = api;
})(typeof window !== 'undefined' ? window : globalThis);
