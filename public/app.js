// Dashboard UI. Loads one dataset of bot sessions per date range from the server
// (or from window.AVA_SNAPSHOT in a static snapshot) and recomputes every panel
// locally whenever a filter changes.
(function () {
  'use strict';
  const M = window.AvaMetrics;
  const SNAPSHOT = window.AVA_SNAPSHOT || null;
  const PAGE_SIZE = 25;

  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const pct = (v, digits = 0) => (v == null ? '–' : `${(v * 100).toFixed(digits)}%`);
  const num = (v, digits = 0) => (v == null ? '–' : v.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits }));
  const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '–');
  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '');
  const fmtMs = (ms) => (ms == null ? '–' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`);
  function fmtDuration(ms) {
    if (ms == null) return '–';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
    return `${Math.round(h / 24)}d`;
  }

  const FILTER_IDS = { bot: 'f-bot', media: 'f-media', intent: 'f-intent', containment: 'f-containment', result: 'f-result', failure: 'f-failure' };

  const state = {
    org: '',
    orgs: [],
    range: '30',
    from: null,
    to: null,
    filters: { bot: '', media: '', intent: '', containment: '', result: '', failure: '', search: '' },
    dataset: null,
    filtered: [],
    page: 1,
    sort: { key: 'start', dir: -1 },
    detailCache: new Map(),
    expanded: { intents: false, bots: false },
  };
  const TABLE_PREVIEW_ROWS = 10;

  // Long tables show their top rows plus a toggle; the active filter row always stays visible.
  function visibleRows(table, rows, isActive) {
    if (state.expanded[table] || rows.length <= TABLE_PREVIEW_ROWS) return rows;
    return rows.filter((r, i) => i < TABLE_PREVIEW_ROWS || isActive(r));
  }

  function renderShowMore(table, total) {
    const el = $(table).closest('.card').querySelector('.show-more') || (() => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-ghost show-more';
      $(table).closest('.card').appendChild(b);
      b.addEventListener('click', () => {
        state.expanded[table] = !state.expanded[table];
        render();
      });
      return b;
    })();
    el.hidden = total <= TABLE_PREVIEW_ROWS;
    el.textContent = state.expanded[table] ? 'Show fewer' : `Show all ${total}`;
  }

  // ---------- URL state, so a filtered view can be bookmarked or shared ----------
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    if (p.get('org')) state.org = p.get('org');
    if (p.get('range')) state.range = p.get('range');
    if (p.get('from')) state.from = p.get('from');
    if (p.get('to')) state.to = p.get('to');
    for (const k of Object.keys(state.filters)) if (p.get(k)) state.filters[k] = p.get(k);
  }
  function writeHash() {
    const p = new URLSearchParams();
    if (!SNAPSHOT) {
      if (state.org) p.set('org', state.org);
      p.set('range', state.range);
      if (state.range === 'custom') {
        if (state.from) p.set('from', state.from);
        if (state.to) p.set('to', state.to);
      }
    }
    for (const [k, v] of Object.entries(state.filters)) if (v) p.set(k, v);
    history.replaceState(null, '', `#${p.toString()}`);
  }

  function currentInterval() {
    if (state.range === 'custom' && state.from && state.to) {
      const start = new Date(`${state.from}T00:00:00`);
      const end = new Date(`${state.to}T00:00:00`);
      end.setDate(end.getDate() + 1);
      return { start: start.toISOString(), end: end.toISOString() };
    }
    const days = Number(state.range) || 30;
    const end = new Date();
    const start = new Date(end.getTime() - days * 86_400_000);
    return { start: start.toISOString(), end: end.toISOString() };
  }

  // ---------- Data loading ----------
  let loadSeq = 0;
  let loadAbort = null;

  async function load() {
    // Only the latest request may update the page: a slow earlier load (say 90 days)
    // must not land after a quicker later one and show numbers for the wrong range.
    const seq = ++loadSeq;
    if (loadAbort) loadAbort.abort();
    loadAbort = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const main = $('main');
    main.classList.add('loading');
    showBanner('');
    try {
      if (SNAPSHOT) {
        state.dataset = SNAPSHOT.dataset;
      } else {
        const { start, end } = currentInterval();
        const qs = new URLSearchParams({ start, end });
        if (state.org) qs.set('org', state.org);
        const res = await fetch(`api/dataset?${qs}`, { signal: loadAbort?.signal });
        const body = await res.json();
        if (seq !== loadSeq) return;
        if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
        state.dataset = body;
      }
      const meta = state.dataset.meta || {};
      if (meta.detailsTruncated) showBanner(`Conversation detail was capped at ${num(meta.conversationsWithDetails)} conversations, so containment for older sessions is estimated from the bot outcome. Narrow the date range for exact numbers.`);
      $('updated').textContent = `Updated ${fmtDateTime(state.dataset.generatedAt)}`;
      const iv = state.dataset.interval;
      const endShown = new Date(new Date(iv.end).getTime() - 1);
      $('subtitle').textContent = `${new Date(iv.start).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} – ${endShown.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}${SNAPSHOT ? ' · snapshot' : ''}`;
      main.hidden = false;
      render();
    } catch (err) {
      if (seq !== loadSeq) return; // superseded by a newer load
      // Don't leave the previous org's or range's numbers on screen under the new selection.
      state.dataset = null;
      main.hidden = true;
      $('updated').textContent = '';
      showBanner(`Couldn’t load data: ${err.message}`, true);
    } finally {
      if (seq === loadSeq) main.classList.remove('loading');
    }
  }

  function showBanner(text, isError) {
    const b = $('banner');
    b.hidden = !text;
    b.textContent = text;
    b.classList.toggle('error', !!isError);
  }

  function fillSelect(id, allLabel, items, selected) {
    const sel = $(id);
    const values = items.map((i) => (typeof i === 'string' ? { value: i, label: i } : i));
    // Keep a selected value visible even if this date range has no data for it.
    if (selected && !values.some((v) => v.value === selected)) values.unshift({ value: selected, label: selected });
    sel.innerHTML = `<option value="">${esc(allLabel)}</option>` + values.map((v) => `<option value="${esc(v.value)}">${esc(v.label)}</option>`).join('');
    sel.value = selected || '';
  }

  function populateOptions() {
    const optionsWithout = (key) => M.options(M.applyFilters(state.dataset.sessions, filterSpec(key)));
    fillSelect('f-bot', 'All virtual agents', optionsWithout('bot').bots.map((b) => ({ value: b.id, label: b.name })), state.filters.bot);
    fillSelect('f-media', 'All channels', optionsWithout('media').media, state.filters.media);
    fillSelect('f-intent', 'All intents', optionsWithout('intent').intents, state.filters.intent);
    fillSelect('f-result', 'All exit reasons', optionsWithout('result').results.map((r) => ({ value: r.code, label: r.label })), state.filters.result);
  }

  // Filters as metrics.applyFilters expects them; `except` leaves one out, which is how
  // each dropdown lists only the values that still match the other active filters.
  function filterSpec(except) {
    const f = { ...state.filters };
    if (except) f[except] = '';
    return {
      botIds: f.bot ? [f.bot] : null,
      media: f.media,
      intent: f.intent,
      containment: f.containment,
      botResult: f.result,
      recognitionFailure: f.failure,
      search: f.search,
    };
  }

  // ---------- Rendering ----------
  function render() {
    if (!state.dataset) return;
    const f = state.filters;
    populateOptions();
    state.filtered = M.applyFilters(state.dataset.sessions, {
      botIds: f.bot ? [f.bot] : null,
      media: f.media,
      intent: f.intent,
      containment: f.containment,
      botResult: f.result,
      recognitionFailure: f.failure,
      search: f.search,
    });
    for (const [k, id] of Object.entries(FILTER_IDS)) $(id).value = f[k];
    $('f-search').value = f.search;
    writeHash();
    renderKpis(M.summarize(state.filtered));
    renderTrend(M.byDay(state.filtered, state.dataset.interval.start, state.dataset.interval.end));
    renderBarList('results', M.byResult(state.filtered), 'result', (key) => key || '');
    renderBarList('failures', M.byFailureReason(state.filtered), null);
    renderIntents(M.intentTable(state.filtered));
    renderBots(M.botTable(state.filtered));
    renderSessions();
  }

  function renderKpis(s) {
    const tiles = [
      { label: 'Bot sessions', value: num(s.sessions), sub: `${num(s.contained)} contained · ${num(s.escalated)} escalated` },
      { label: 'Containment rate', value: pct(s.containmentRate, 1), meter: s.containmentRate, sub: s.inferred ? `${num(s.inferred)} estimated from bot outcome` : 'Never reached a queue or agent' },
      { label: 'Reached an agent', value: pct(s.agentRate, 1), meter: s.agentRate, sub: `${num(s.reachedAgent)} sessions` },
      { label: 'Query self-service rate', value: pct(s.selfServiceRate, 1), meter: s.selfServiceRate, sub: `${num(s.queries)} questions asked` },
      { label: 'Intent recognized', value: pct(s.intentRate, 1), meter: s.intentRate, sub: 'Sessions matching ≥1 intent' },
      { label: 'Recognition failures', value: pct(s.recognitionFailureRate, 1), meter: s.recognitionFailureRate, sub: 'Sessions with no-match / no-input' },
      { label: 'Turns per session', value: num(s.avgTurns, 1), sub: 'Average' },
      { label: 'Session length', value: fmtDuration(s.medianDurationMs), sub: 'Median' },
      { label: 'Bot response time', value: fmtMs(s.medianResponseMs), sub: s.responseTurns ? `Median of ${num(s.responseTurns)} turns in ${num(s.timedSessions)} of ${num(s.sessions)} sessions` : 'No turn timing reported' },
      { label: 'Longest response', value: fmtMs(s.maxResponseMs), sub: 'Slowest single bot reply' },
    ];
    $('kpis').innerHTML = tiles
      .map((t) => `<div class="kpi"><div class="kpi-label">${esc(t.label)}</div><div class="kpi-value">${esc(t.value)}</div>` +
        (t.meter != null ? `<div class="kpi-meter"><span style="width:${Math.min(100, t.meter * 100).toFixed(1)}%"></span></div>` : '') +
        `<div class="kpi-sub">${esc(t.sub)}</div></div>`)
      .join('');
  }

  // Stacked daily bars: contained (series 1) under escalated (series 2), 2px surface gap.
  function renderTrend(days) {
    const series = [
      { key: 'contained', label: 'Contained', color: 'var(--series-1)' },
      { key: 'escalated', label: 'Escalated', color: 'var(--series-2)' },
    ];
    if (days.some((d) => d.unknown)) series.push({ key: 'unknown', label: 'Unknown', color: 'var(--series-unknown)' });
    $('trend-legend').innerHTML = series.map((s) => `<span class="legend-item"><span class="swatch" style="background:${s.color}"></span>${esc(s.label)}</span>`).join('');

    const W = 720, H = 240, padL = 36, padR = 8, padT = 8, padB = 24;
    const innerW = W - padL - padR, innerH = H - padT - padB;
    const totals = days.map((d) => series.reduce((a, s) => a + d[s.key], 0));
    const maxRaw = Math.max(1, ...totals);
    const step = niceStep(maxRaw / 4);
    const max = Math.ceil(maxRaw / step) * step;
    const y = (v) => padT + innerH - (v / max) * innerH;
    const band = innerW / Math.max(1, days.length);
    const barW = Math.max(2, Math.min(28, band * 0.7));
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Sessions per day, contained versus escalated">`;
    for (let v = 0; v <= max; v += step) {
      svg += `<line class="${v === 0 ? 'baseline' : 'gridline'}" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/>`;
      svg += `<text x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
    }
    const labelEvery = Math.ceil(days.length / 8);
    days.forEach((d, i) => {
      const x = padL + i * band + (band - barW) / 2;
      let acc = 0;
      const segs = series.filter((s) => d[s.key] > 0);
      segs.forEach((s, j) => {
        const top = y(acc + d[s.key]);
        const bottom = y(acc);
        const gap = j > 0 ? 2 : 0;
        const h = Math.max(0, bottom - top - gap);
        const isTop = j === segs.length - 1;
        const r = isTop ? Math.min(4, barW / 2, h) : 0;
        svg += `<path d="${roundedTopRect(x, top, barW, h, r)}" fill="${s.color}"/>`;
        acc += d[s.key];
      });
      if (i % labelEvery === 0) {
        const dt = new Date(`${d.day}T00:00:00`);
        svg += `<text x="${x + barW / 2}" y="${H - 6}" text-anchor="middle">${esc(dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}</text>`;
      }
      svg += `<rect class="hit" data-i="${i}" x="${padL + i * band}" y="${padT}" width="${band}" height="${innerH}"/>`;
    });
    svg += '</svg>';
    const el = $('trend');
    el.innerHTML = svg;
    el.querySelectorAll('.hit').forEach((hit) => {
      const d = days[Number(hit.dataset.i)];
      const total = series.reduce((a, s) => a + d[s.key], 0);
      const rate = d.contained + d.escalated ? d.contained / (d.contained + d.escalated) : null;
      hit.addEventListener('mousemove', (e) => showTooltip(e, new Date(`${d.day}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
        [...series.map((s) => [s.label, num(d[s.key]), s.color]), ['Total', num(total)], ['Containment', pct(rate, 1)]]));
      hit.addEventListener('mouseleave', hideTooltip);
    });
  }

  function roundedTopRect(x, y, w, h, r) {
    if (h <= 0) return '';
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  function niceStep(raw) {
    const pow = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
    for (const m of [1, 2, 5, 10]) if (m * pow >= raw) return Math.max(1, m * pow);
    return Math.max(1, 10 * pow);
  }

  function showTooltip(e, title, rows) {
    const tt = $('tooltip');
    tt.innerHTML = `<div class="tt-title">${esc(title)}</div>` + rows.map(([k, v, color]) =>
      `<div class="tt-row"><span>${color ? `<span class="swatch" style="background:${color}"></span>` : ''}${esc(k)}</span><span>${esc(v)}</span></div>`).join('');
    tt.hidden = false;
    const pad = 14;
    const rect = tt.getBoundingClientRect();
    let left = e.clientX + pad;
    if (left + rect.width > window.innerWidth - 8) left = e.clientX - rect.width - pad;
    let top = e.clientY + pad;
    if (top + rect.height > window.innerHeight - 8) top = e.clientY - rect.height - pad;
    tt.style.left = `${Math.max(8, left)}px`;
    tt.style.top = `${Math.max(8, top)}px`;
  }
  const hideTooltip = () => { $('tooltip').hidden = true; };

  function renderBarList(id, rows, filterKey) {
    const el = $(id);
    if (!rows.length) {
      el.innerHTML = '<div class="empty-state">No data for these filters.</div>';
      return;
    }
    const total = rows.reduce((a, r) => a + r.count, 0);
    const max = Math.max(...rows.map((r) => r.count));
    el.innerHTML = rows.slice(0, 10).map((r) => {
      const active = filterKey && (state.filters[filterKey] || '') === (r.key || '') && state.filters[filterKey];
      return `<div class="bar-row${active ? ' active' : ''}" data-key="${esc(r.key || '')}" ${filterKey && r.key ? 'tabindex="0" role="button"' : 'style="cursor:default"'}>
        <span class="bar-label" title="${esc(r.label)}">${esc(r.label)}</span>
        <span class="bar-value">${num(r.count)} · ${pct(r.count / total)}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${((r.count / max) * 100).toFixed(1)}%"></div></div>
      </div>`;
    }).join('');
    if (!filterKey) return;
    el.querySelectorAll('.bar-row[role=button]').forEach((row) => {
      const toggle = () => setFilter(filterKey, state.filters[filterKey] === row.dataset.key ? '' : row.dataset.key);
      row.addEventListener('click', toggle);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    });
  }

  const rateCell = (v) => `<td class="num"><span class="rate">${pct(v)}<span class="rate-bar"><span style="width:${v == null ? 0 : (v * 100).toFixed(1)}%"></span></span></span></td>`;

  function renderIntents(rows) {
    const el = $('intents');
    el.innerHTML = `<thead><tr><th>Intent</th><th class="num">Sessions</th><th class="num">Share</th><th class="num">Contained</th><th class="num">Reached agent</th><th class="num">Avg turns</th><th class="num">Recog. failures</th><th class="num">Final intent</th></tr></thead><tbody>` +
      (rows.length ? visibleRows('intents', rows, (r) => r.intent === state.filters.intent).map((r) => `<tr data-key="${esc(r.intent)}" class="${state.filters.intent === r.intent ? 'active' : ''}" tabindex="0">
        <td class="cell-strong">${esc(r.intent)}</td><td class="num">${num(r.sessions)}</td><td class="num">${pct(r.share)}</td>${rateCell(r.containmentRate)}<td class="num">${pct(r.agentRate)}</td>
        <td class="num">${num(r.avgTurns, 1)}</td><td class="num">${pct(r.recognitionFailureRate)}</td><td class="num">${num(r.asFinal)}</td></tr>`).join('')
        : '<tr class="empty"><td colspan="8">No intents were recognized in these sessions.</td></tr>') + '</tbody>';
    bindRowFilter(el, 'intent');
    renderShowMore('intents', rows.length);
  }

  function renderBots(rows) {
    const el = $('bots');
    el.innerHTML = `<thead><tr><th>Virtual agent</th><th>Channel</th><th class="num">Sessions</th><th class="num">Contained</th><th class="num">Reached agent</th><th class="num">Self-service</th><th class="num">Intent recognized</th><th class="num">Recog. failures</th><th class="num">Avg turns</th><th class="num">Median length</th><th class="num">Median response</th><th class="num">Longest response</th></tr></thead><tbody>` +
      (rows.length ? visibleRows('bots', rows, (r) => r.botId === state.filters.bot).map((r) => `<tr data-key="${esc(r.botId)}" class="${state.filters.bot === r.botId ? 'active' : ''}" tabindex="0">
        <td class="cell-strong">${esc(r.botName)}</td><td>${esc(r.media)}</td><td class="num">${num(r.sessions)}</td>${rateCell(r.containmentRate)}<td class="num">${pct(r.agentRate)}</td>
        <td class="num">${pct(r.selfServiceRate)}</td><td class="num">${pct(r.intentRate)}</td><td class="num">${pct(r.recognitionFailureRate)}</td><td class="num">${num(r.avgTurns, 1)}</td><td class="num">${fmtDuration(r.medianDurationMs)}</td><td class="num">${fmtMs(r.medianResponseMs)}</td><td class="num">${fmtMs(r.maxResponseMs)}</td></tr>`).join('')
        : '<tr class="empty"><td colspan="12">No sessions match these filters.</td></tr>') + '</tbody>';
    bindRowFilter(el, 'bot');
    renderShowMore('bots', rows.length);
  }

  function bindRowFilter(table, key) {
    table.querySelectorAll('tbody tr[data-key]').forEach((tr) => {
      const toggle = () => setFilter(key, state.filters[key] === tr.dataset.key ? '' : tr.dataset.key);
      tr.addEventListener('click', toggle);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') toggle(); });
    });
  }

  const SESSION_COLUMNS = [
    { key: 'start', label: 'Started', value: (s) => s.start || '' },
    { key: 'botName', label: 'Virtual agent', value: (s) => s.botName || '' },
    { key: 'media', label: 'Channel', value: (s) => s.media || '' },
    { key: 'containment', label: 'Outcome', value: (s) => M.containment(s) },
    { key: 'botResult', label: 'Bot exit', value: (s) => M.resultLabel(s.botResult) },
    { key: 'intents', label: 'Intents', value: (s) => s.intents.join(', ') },
    { key: 'turns', label: 'Turns', value: (s) => s.turns, num: true },
    { key: 'durationMs', label: 'Length', value: (s) => s.durationMs ?? -1, num: true },
    { key: 'response', label: 'Response (median · max)', value: (s) => M.sessionResponse(s).maxResponseMs ?? -1, num: true },
  ];

  function searchedSessions() {
    const rows = state.filtered.slice(); // search is already applied with the other filters
    const col = SESSION_COLUMNS.find((c) => c.key === state.sort.key) || SESSION_COLUMNS[0];
    rows.sort((a, b) => {
      const va = col.value(a), vb = col.value(b);
      return (typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb))) * state.sort.dir;
    });
    return rows;
  }

  function outcomeBadge(s) {
    const c = M.containment(s);
    const label = c === 'contained' ? 'Contained' : c === 'escalated' ? (s.escalation === 'agent' ? 'Escalated · agent' : s.escalation === 'queue' ? 'Escalated · queue' : 'Escalated') : 'Unknown';
    return `<span class="badge ${c}">${label}${s.escalation == null && c !== 'unknown' ? ' <span class="est">(est.)</span>' : ''}</span>`;
  }

  function responseCell(s) {
    const r = M.sessionResponse(s);
    return r.responseTurns ? `${fmtMs(r.medianResponseMs)} · <span class="cell-strong">${fmtMs(r.maxResponseMs)}</span>` : '<span class="muted">–</span>';
  }

  function renderSessions() {
    const rows = searchedSessions();
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    state.page = Math.min(state.page, pages);
    const pageRows = rows.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
    $('session-count').textContent = `(${num(rows.length)})`;
    const arrow = (k) => (state.sort.key === k ? (state.sort.dir < 0 ? ' ↓' : ' ↑') : '');
    const el = $('sessions');
    el.innerHTML = `<thead><tr>${SESSION_COLUMNS.map((c) => `<th data-sort="${c.key}" class="${c.num ? 'num' : ''}">${c.label}${arrow(c.key)}</th>`).join('')}</tr></thead><tbody>` +
      (pageRows.length ? pageRows.map((s) => `<tr data-id="${esc(s.id)}" tabindex="0">
        <td><div>${esc(fmtDateTime(s.start))}</div></td>
        <td><div class="cell-strong">${esc(s.botName)}</div></td>
        <td>${esc(s.media || '')}</td>
        <td>${outcomeBadge(s)}${s.queueName && s.escalation ? `<div class="cell-sub">${esc(s.queueName)}</div>` : ''}</td>
        <td>${esc(M.resultLabel(s.botResult))}${s.recognitionFailures ? `<div class="cell-sub">${s.recognitionFailures} recognition failure${s.recognitionFailures > 1 ? 's' : ''}</div>` : ''}</td>
        <td><div class="chips">${s.intents.map((i) => `<span class="chip">${esc(i)}</span>`).join('') || '<span class="muted">–</span>'}</div></td>
        <td class="num">${num(s.turns)}</td>
        <td class="num">${fmtDuration(s.durationMs)}</td>
        <td class="num">${responseCell(s)}</td></tr>`).join('')
        : '<tr class="empty"><td colspan="9">No sessions match these filters.</td></tr>') + '</tbody>';
    el.querySelectorAll('th[data-sort]').forEach((th) => th.addEventListener('click', () => {
      const k = th.dataset.sort;
      state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : ['start', 'turns', 'durationMs', 'response'].includes(k) ? -1 : 1 };
      renderSessions();
    }));
    el.querySelectorAll('tbody tr[data-id]').forEach((tr) => {
      const open = () => openSession(state.filtered.find((s) => s.id === tr.dataset.id));
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    });
    $('pager').innerHTML = `<span class="muted">${rows.length ? `${num((state.page - 1) * PAGE_SIZE + 1)}–${num(Math.min(rows.length, state.page * PAGE_SIZE))} of ${num(rows.length)}` : ''}</span>
      <span class="pages"><button class="btn" data-p="prev" ${state.page <= 1 ? 'disabled' : ''}>Previous</button><span class="muted">Page ${state.page} of ${pages}</span><button class="btn" data-p="next" ${state.page >= pages ? 'disabled' : ''}>Next</button></span>`;
    $('pager').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      state.page += b.dataset.p === 'next' ? 1 : -1;
      renderSessions();
      $('sessions-card').scrollIntoView({ block: 'start', behavior: 'smooth' });
    }));
  }

  function exportCsv() {
    const rows = searchedSessions();
    const header = ['Started', 'Virtual agent', 'Bot ID', 'Channel', 'Outcome', 'Escalation', 'Queue', 'Bot exit', 'Intents', 'Final intent', 'Recognition failures', 'Turns', 'Length (s)', 'Median response (ms)', 'Longest response (ms)', 'Conversation ID', 'Bot session ID'];
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [header.map(cell).join(',')].concat(rows.map((s) => [s.start, s.botName, s.botId, s.media, M.containment(s), s.escalation ?? 'estimated', s.queueName, M.resultLabel(s.botResult), s.intents.join('; '), s.finalIntent, s.recognitionFailures, s.turns, s.durationMs == null ? '' : Math.round(s.durationMs / 1000), M.sessionResponse(s).medianResponseMs ?? '', M.sessionResponse(s).maxResponseMs ?? '', s.conversationId, s.id].map(cell).join(',')));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ava-sessions-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---------- Session drill-down ----------
  let lastFocus = null;
  async function openSession(s) {
    if (!s) return;
    lastFocus = document.activeElement;
    const drawer = $('drawer');
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    $('drawer-title').textContent = s.botName;
    $('drawer-sub').textContent = `${fmtDateTime(s.start)} · ${s.media || ''}`;
    $('drawer-close').focus();
    const body = $('drawer-body');
    body.innerHTML = factsHtml(s) + '<section><h3>Conversation path</h3><div class="empty-state">Loading…</div></section>';
    let detail = state.detailCache.get(s.id);
    try {
      if (!detail) {
        if (SNAPSHOT) {
          detail = SNAPSHOT.details?.[s.id] || null;
        } else {
          const qs = new URLSearchParams({ conversationId: s.conversationId || '', botId: s.botId || '', sessionId: s.id });
          if (state.org) qs.set('org', state.org);
          const res = await fetch(`api/session?${qs}`);
          const json = await res.json();
          if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
          detail = json;
        }
        if (detail) state.detailCache.set(s.id, detail);
      }
      if (!drawer.classList.contains('open') || $('drawer-title').textContent !== s.botName) return;
      body.innerHTML = factsHtml(s, detail) + (detail ? journeyHtml(detail) + transcriptHtml(detail) : '<section><div class="empty-state">Turn-by-turn detail isn’t included in this snapshot for this session. The live dashboard loads it on demand.</div></section>');
    } catch (err) {
      body.innerHTML = factsHtml(s) + `<section><div class="empty-state">Couldn’t load session detail: ${esc(err.message)}</div></section>`;
    }
  }

  // ---------- Check against Genesys ----------
  const VERIFY_ROWS = [
    ['sessions', 'Bot sessions', 'nBotSessions'],
    ['turns', 'Bot turns', 'nBotSessionTurns'],
    ['exits', 'Sessions that exited the bot', 'tBotExit count'],
    ['disconnects', 'Sessions that disconnected in the bot', 'tBotDisconnect count'],
    ['recognitionFailures', 'Recognition failures', 'tBotRecognitionFailure count'],
    ['queries', 'Customer questions', 'oBotSessionQuery sum'],
    ['selfServedQueries', 'Questions self-served', 'oBotSessionQuerySelfServed sum'],
    ['conversations', 'Conversations with a bot', 'Conversation detail search, bot participant'],
    ['conversationsWithAgent', 'Conversations that reached an agent', 'Conversation detail search, bot and connected agent'],
  ];

  async function openVerify() {
    if (!state.dataset) return;
    lastFocus = document.activeElement;
    const drawer = $('drawer');
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    const bot = state.filters.bot;
    const botName = bot ? state.dataset.sessions.find((s) => s.botId === bot)?.botName : null;
    $('drawer-title').textContent = 'Check against Genesys';
    $('drawer-sub').textContent = `${$('subtitle').textContent}${botName ? ` · ${botName}` : ' · all virtual agents'}`;
    $('drawer-close').focus();
    const body = $('drawer-body');
    body.innerHTML = '<div class="empty-state">Asking Genesys for its own totals…</div>';
    try {
      const qs = new URLSearchParams({ start: state.dataset.interval.start, end: state.dataset.interval.end });
      if (state.org) qs.set('org', state.org);
      if (bot) qs.set('bot', bot);
      const res = await fetch(`api/verify?${qs}`);
      const genesys = await res.json();
      if (!res.ok) throw new Error(genesys.error || `Request failed (${res.status})`);
      if ($('drawer-title').textContent !== 'Check against Genesys') return;
      const mine = M.verificationTotals(M.applyFilters(state.dataset.sessions, { botIds: bot ? [bot] : null }));
      body.innerHTML = verifyHtml(mine, genesys, !!bot);
    } catch (err) {
      body.innerHTML = `<div class="empty-state">Couldn’t get Genesys totals: ${esc(err.message)}</div>`;
    }
  }

  function checkCell(a, b) {
    if (a == null || b == null) return '<td class="muted">–</td>';
    const d = a - b;
    return d === 0 ? '<td class="check-ok">✓ Match</td>' : `<td class="check-diff">⚠ ${d > 0 ? '+' : ''}${num(d)}</td>`;
  }

  function verifyHtml(mine, genesys, oneBot) {
    const rows = VERIFY_ROWS.filter(([k]) => genesys.totals[k] != null);
    const diffs = rows.filter(([k]) => mine.totals[k] !== genesys.totals[k]).length;
    const intents = Object.keys({ ...mine.intentSessions, ...genesys.intentSessions })
      .map((i) => [i, mine.intentSessions[i] || 0, genesys.intentSessions[i] || 0])
      .sort((a, b) => b[2] - a[2] || b[1] - a[1]);
    const intentDiffs = intents.filter(([, a, b]) => a !== b).length;
    return `<section class="verify-note">
        <p class="verify-note">Genesys’s numbers below come from separate queries to its own analytics, for the same org and time range${oneBot ? ' and virtual agent' : ''}. Only the virtual agent filter applies here; other filters are ignored. ${diffs || intentDiffs ? `${diffs + intentDiffs} row${diffs + intentDiffs > 1 ? 's differ' : ' differs'}; see the notes below.` : 'Every row matches.'}</p>
      </section>
      <section><h3>Totals</h3><div class="table-wrap"><table class="data"><thead><tr><th>Measure</th><th class="num">Dashboard</th><th class="num">Genesys</th><th>Check</th></tr></thead><tbody>
        ${rows.map(([k, label, source]) => `<tr style="cursor:default"><td><div class="cell-strong">${esc(label)}</div><div class="cell-sub">${esc(source)}</div></td><td class="num">${num(mine.totals[k])}</td><td class="num">${num(genesys.totals[k])}</td>${checkCell(mine.totals[k], genesys.totals[k])}</tr>`).join('')}
      </tbody></table></div></section>
      <section><h3>Sessions per intent</h3><div class="table-wrap"><table class="data"><thead><tr><th>Intent</th><th class="num">Dashboard</th><th class="num">Genesys</th><th>Check</th></tr></thead><tbody>
        ${intents.length ? intents.map(([i, a, b]) => `<tr style="cursor:default"><td>${esc(i)}</td><td class="num">${num(a)}</td><td class="num">${num(b)}</td>${checkCell(a, b)}</tr>`).join('') : '<tr class="empty"><td colspan="4">No intents in this range.</td></tr>'}
      </tbody></table></div></section>
      <section><h3>Why a row can differ</h3><ul class="verify-note">
        <li><b>Conversations with a bot</b>: third-party bots don’t appear as a bot participant in conversation detail, so their conversations count on the dashboard but not in Genesys’s search.</li>
        <li>Survey bots (${esc(genesys.excludedBotTypes.join(', ') || 'none')}) are left out on both sides.</li>
        <li>Data still arriving: Genesys finishes some sessions minutes after they end. Press Refresh and check again.</li>
        <li>To check a single session, copy its conversation ID from the session list and search for it in Genesys under Performance › Workspace › Interactions.</li>
      </ul></section>`;
  }

  function closeDrawer() {
    const drawer = $('drawer');
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    if (lastFocus) lastFocus.focus();
  }

  function factsHtml(s, detail) {
    const facts = [
      ['Outcome', outcomeBadge(s), true],
      ['Bot exit', esc(M.resultLabel(s.botResult)), true],
      ['Turns', num(s.turns)],
      ['Bot session length', fmtDuration(s.durationMs)],
      ['Bot response (median · longest)', M.sessionResponse(s).responseTurns ? `${fmtMs(M.sessionResponse(s).medianResponseMs)} · ${fmtMs(M.sessionResponse(s).maxResponseMs)}` : '–'],
      ['Intents', s.intents.length ? s.intents.map(esc).join(', ') : '–', true],
      ['Final intent', esc(s.finalIntent || '–'), true],
      ['Recognition failures', s.recognitionFailures ? `${s.recognitionFailures} (${s.recognitionFailureReasons.map((r) => esc(M.failureLabel(r))).join(', ')})` : '0', true],
      ['Questions self-served', s.queries ? `${num(s.selfServedQueries)} of ${num(s.queries)}` : '–'],
    ];
    if (s.queueName) facts.push(['Queue', esc(s.queueName), true]);
    if (detail?.conversationEnd && detail?.conversationStart) facts.push(['Whole conversation', fmtDuration(Date.parse(detail.conversationEnd) - Date.parse(detail.conversationStart))]);
    facts.push(['Conversation ID', `<span class="mono">${esc(s.conversationId || '–')}</span>`, true, true]);
    return `<section class="facts">${facts.map(([k, v, , wide]) => `<div class="fact${wide ? ' wide' : ''}"><div class="k">${esc(k)}</div><div class="v">${v}</div></div>`).join('')}</section>`;
  }

  function journeyHtml(d) {
    const steps = d.journey.filter((j) => j.role !== 'Customer');
    if (!steps.length) return '<section><h3>Conversation path</h3><div class="empty-state">Genesys returned no conversation detail.</div></section>';
    return `<section><h3>Conversation path</h3><ol class="journey">${steps.map((j) => {
      const cls = j.role === 'Bot' ? 'bot' : j.role === 'Agent' ? 'agent' : j.role === 'Queue' ? 'queue' : '';
      const meta = [j.exitReason && `Exit: ${j.exitReason}`, j.transferTarget && `Transfer to ${j.transferTarget}`, j.disconnectType && `Disconnect: ${j.disconnectType}`].filter(Boolean).join(' · ');
      return `<li class="${cls}"><div><div class="j-role">${esc(j.role)}</div><div class="j-name">${esc(j.name || j.role)}</div>${meta ? `<div class="j-meta">${esc(meta)}</div>` : ''}</div><div class="j-time">${esc(fmtTime(j.start))}<br>${esc(fmtDuration(j.durationMs))}</div></li>`;
    }).join('')}</ol></section>`;
  }

  function transcriptHtml(d) {
    if (!d.turns.length) return '<section><h3>Transcript</h3><div class="empty-state">Genesys has no turn-level data for this session. Some digital and third-party bots don’t report turns.</div></section>';
    const va = d.turns.find((t) => t.virtualAgent)?.virtualAgent;
    const html = d.turns.map((t) => {
      const userMeta = [];
      if (t.intent) userMeta.push(`<span class="chip">Intent: ${esc(t.intent.name)} (${pct(t.intent.confidence)})</span>`);
      for (const sl of t.slots) userMeta.push(`<span class="chip">${esc(sl.name)} = ${esc(sl.value)}</span>`);
      if (t.result) userMeta.push(`<span class="chip ${/Success/.test(t.result) ? 'ok' : /NoMatch|NoInput|Error|Failure/.test(t.result) ? 'fail' : ''}">${esc(t.result.replace(/([a-z])([A-Z])/g, '$1 $2'))}</span>`);
      const botMeta = [];
      if (t.responseMs != null) botMeta.push(`<span class="chip">Replied in ${esc(fmtMs(t.responseMs))}</span>`);
      if (t.action) botMeta.push(`<span class="chip">${esc(t.action.name)}</span>`);
      for (const c of t.toolCalls) botMeta.push(`<span class="chip ${c.status === 'Success' ? 'ok' : 'fail'}">Tool ${esc(c.name)} · ${esc(c.status)}${c.latencyMs != null ? ` · ${c.latencyMs} ms` : ''}</span>`);
      if (t.guardrailEvents) botMeta.push(`<span class="chip fail">${t.guardrailEvents} guardrail event${t.guardrailEvents > 1 ? 's' : ''}</span>`);
      return `<div class="turn">
        ${t.userInput ? `<div class="bubble user">${esc(t.userInput)}</div>` : ''}
        ${userMeta.length && t.userInput ? `<div class="turn-meta user">${userMeta.join('')}</div>` : ''}
        ${t.botPrompts.map((p) => `<div class="bubble bot">${esc(p)}</div>`).join('')}
        ${botMeta.length ? `<div class="turn-meta"><span>${esc(fmtTime(t.time))}</span>${botMeta.join('')}</div>` : `<div class="turn-meta"><span>${esc(fmtTime(t.time))}</span></div>`}
        ${t.sessionEnd ? `<div class="session-end">Session ended · ${esc(t.sessionEnd)}</div>` : ''}
      </div>`;
    }).join('');
    return `<section><h3>Transcript${va ? ` · ${esc(va.name)} v${esc(va.version)}` : ''}</h3><div class="transcript">${html}</div></section>`;
  }

  // ---------- Events ----------
  function setFilter(key, value) {
    state.filters[key] = value;
    state.page = 1;
    render();
  }

  async function loadOrgs() {
    const sel = $('f-org');
    if (SNAPSHOT) {
      const label = SNAPSHOT.dataset.org?.label || 'Snapshot';
      sel.innerHTML = `<option>${esc(label)}</option>`;
      sel.disabled = true;
      return;
    }
    try {
      const res = await fetch('api/orgs');
      const body = await res.json();
      state.orgs = body.orgs || [];
    } catch {
      state.orgs = [];
    }
    if (!state.orgs.some((o) => o.key === state.org)) state.org = state.orgs[0]?.key || '';
    sel.innerHTML = state.orgs.map((o) => `<option value="${esc(o.key)}">${esc(o.label)}${o.error ? ` (${esc(o.error.toLowerCase())})` : ''}</option>`).join('');
    sel.value = state.org;
    sel.disabled = state.orgs.length < 2;
  }

  async function init() {
    readHash();
    $('f-range').value = state.range;
    $('f-from').value = state.from || '';
    $('f-to').value = state.to || '';
    document.querySelectorAll('.custom-range').forEach((el) => { el.hidden = state.range !== 'custom'; });
    if (SNAPSHOT) {
      $('f-range').disabled = true;
      $('f-range').innerHTML = '<option>Snapshot range</option>';
      $('refresh').hidden = true;
      $('verify').hidden = true; // needs the live server
      $('export').hidden = true; // a static snapshot can't always start downloads
    }
    await loadOrgs();
    $('f-org').addEventListener('change', (e) => {
      // Bots, intents and queues differ between orgs, so start the new org unfiltered.
      state.org = e.target.value;
      for (const k of Object.keys(state.filters)) state.filters[k] = '';
      state.detailCache.clear();
      state.page = 1;
      load();
    });

    $('f-range').addEventListener('change', (e) => {
      state.range = e.target.value;
      document.querySelectorAll('.custom-range').forEach((el) => { el.hidden = state.range !== 'custom'; });
      if (state.range === 'custom') {
        const iv = currentInterval();
        state.from = state.from || M.localDay(iv.start);
        state.to = state.to || M.localDay(new Date());
        $('f-from').value = state.from;
        $('f-to').value = state.to;
      }
      load();
    });
    for (const id of ['f-from', 'f-to']) $(id).addEventListener('change', () => {
      state.from = $('f-from').value;
      state.to = $('f-to').value;
      if (state.from && state.to && state.from <= state.to) load();
    });
    for (const [k, id] of Object.entries(FILTER_IDS)) $(id).addEventListener('change', (e) => setFilter(k, e.target.value));
    let searchTimer;
    $('f-search').addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => setFilter('search', e.target.value), 150);
    });
    $('f-reset').addEventListener('click', () => {
      for (const k of Object.keys(state.filters)) state.filters[k] = '';
      state.page = 1;
      render();
    });
    $('refresh').addEventListener('click', load);
    $('export').addEventListener('click', exportCsv);
    $('verify').addEventListener('click', openVerify);
    $('drawer-close').addEventListener('click', closeDrawer);
    $('drawer').addEventListener('click', (e) => { if (e.target === $('drawer')) closeDrawer(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('drawer').classList.contains('open')) closeDrawer(); });
    load();
  }

  init();
})();
