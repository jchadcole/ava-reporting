// AVA dashboard (v2) UI. Loads the AVA sessions for a date range from the server and
// recomputes every panel locally whenever a filter changes. While Claude is still reading
// sessions, the page polls and fills in intents as they arrive.
(function () {
  'use strict';
  const M = window.AvaMetrics;
  const PAGE_SIZE = 25;
  const POLL_MS = 5000;

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
    return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  }

  const FILTER_IDS = { agent: 'f-agent', media: 'f-media', intent: 'f-intent', verdict: 'f-verdict', intentVerdict: 'f-intentverdict', issues: 'f-issues', preview: 'f-preview', containment: 'f-containment', abandon: 'f-abandon' };
  const ISSUE_LABEL = { error: 'Error', guardrail: 'Guardrail block', tool_failed: 'Tool failed', no_reply: 'No reply' };

  const state = {
    org: '',
    orgs: [],
    range: '7',
    from: null,
    to: null,
    filters: { agent: '', media: '', intent: '', verdict: '', intentVerdict: '', issues: '', preview: '', containment: '', abandon: '', search: '' },
    data: null,
    filtered: [],
    page: 1,
    sort: { key: 'start', dir: -1 },
    detailCache: new Map(),
    expanded: { intents: false, agents: false },
    tab: 'overview',
    journey: { steps: 4, per: 8, focus: [], intents: [], match: 'any', allChips: false }, // focus: [{ id, label }] from clicks on the graph
    escalation: { mode: 'request', steps: 4, per: 8, focus: [], intents: [], match: 'any', allChips: false, allNotes: false },
  };
  const TABLE_PREVIEW_ROWS = 10;
  const verdictLabel = (key) => state.data?.verdicts.find((v) => v.key === key)?.label || key;

  function visibleRows(table, rows, isActive) {
    if (state.expanded[table] || rows.length <= TABLE_PREVIEW_ROWS) return rows;
    return rows.filter((r, i) => i < TABLE_PREVIEW_ROWS || isActive(r));
  }

  function renderShowMore(table, total) {
    const card = $(table).closest('.card');
    let el = card.querySelector('.show-more');
    if (!el) {
      el = document.createElement('button');
      el.type = 'button';
      el.className = 'btn btn-ghost show-more';
      card.appendChild(el);
      el.addEventListener('click', () => {
        state.expanded[table] = !state.expanded[table];
        render();
      });
    }
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
    if (['journey', 'escalation'].includes(p.get('tab'))) state.tab = p.get('tab');
    const flow = state.tab === 'escalation' ? state.escalation : state.journey;
    if (Number(p.get('steps'))) flow.steps = Number(p.get('steps'));
    if (Number(p.get('per'))) flow.per = Number(p.get('per'));
    if (p.get('jintents')) flow.intents = p.get('jintents').split('|');
    if (p.get('jmatch') === 'all') flow.match = 'all';
    if (p.get('emode') === 'all') state.escalation.mode = 'escalated';
  }
  function writeHash() {
    const p = new URLSearchParams();
    if (state.org) p.set('org', state.org);
    p.set('range', state.range);
    if (state.range === 'custom') {
      if (state.from) p.set('from', state.from);
      if (state.to) p.set('to', state.to);
    }
    for (const [k, v] of Object.entries(state.filters)) if (v) p.set(k, v);
    if (state.tab in FLOWS) {
      const flow = state[state.tab];
      p.set('tab', state.tab);
      p.set('steps', flow.steps);
      p.set('per', flow.per);
      if (flow.intents.length) p.set('jintents', flow.intents.join('|'));
      if (flow.match === 'all') p.set('jmatch', 'all');
      if (state.tab === 'escalation' && state.escalation.mode === 'escalated') p.set('emode', 'all');
    }
    history.replaceState(null, '', `#${p.toString()}`);
  }

  function currentInterval() {
    if (state.range === 'custom' && state.from && state.to) {
      const start = new Date(`${state.from}T00:00:00`);
      const end = new Date(`${state.to}T00:00:00`);
      end.setDate(end.getDate() + 1);
      return { start: start.toISOString(), end: end.toISOString() };
    }
    const days = Number(state.range) || 7;
    const end = new Date();
    const start = new Date(end.getTime() - days * 86_400_000);
    return { start: start.toISOString(), end: end.toISOString() };
  }

  // ---------- Data loading ----------
  let loadSeq = 0;
  let loadAbort = null;
  let pollTimer = null;
  let interval = null; // the range being shown, reused by polls so they hit the server's cache

  async function load({ poll = false } = {}) {
    // Only the latest request may update the page, so a slow earlier load can't land last.
    const seq = ++loadSeq;
    clearTimeout(pollTimer);
    if (loadAbort) loadAbort.abort();
    loadAbort = new AbortController();
    const main = $('main');
    if (!poll) {
      interval = currentInterval();
      main.classList.add('loading');
      showBanner('');
    }
    try {
      const qs = new URLSearchParams(interval);
      if (state.org) qs.set('org', state.org);
      const res = await fetch(`api/ava?${qs}`, { signal: loadAbort.signal });
      const body = await res.json();
      if (seq !== loadSeq) return;
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
      state.data = body;
      if (body.meta?.turnsTruncated) showBanner('Some virtual agents had more turns than the page limit, so their oldest sessions in this range are missing. Narrow the date range to see them all.');
      $('updated').textContent = `Updated ${fmtDateTime(body.generatedAt)}`;
      const iv = body.interval;
      const endShown = new Date(new Date(iv.end).getTime() - 1);
      $('subtitle').textContent = `${new Date(iv.start).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} – ${endShown.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
      main.hidden = false;
      render();
      renderProgress();
      if (body.analysis.pending) pollTimer = setTimeout(() => load({ poll: true }), POLL_MS);
    } catch (err) {
      if (seq !== loadSeq || err.name === 'AbortError') return;
      if (poll) {
        pollTimer = setTimeout(() => load({ poll: true }), POLL_MS * 2);
        return;
      }
      state.data = null;
      main.hidden = true;
      $('updated').textContent = '';
      $('progress').hidden = true;
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

  function renderProgress() {
    const a = state.data.analysis;
    const el = $('progress');
    let text = '';
    if (!a.enabled) text = 'Intents and response verdicts need Claude: add ANTHROPIC_API_KEY to .env and restart the server. Until then the sessions show only Genesys’s own flags.';
    else if (a.error) text = `Claude analysis stopped: ${a.error}`;
    else if (a.pending) text = `Claude is reading AVA transcripts: ${num(a.analyzed)} of ${num(a.withRequests)} sessions done. The page updates as they finish.`;
    else if (a.analyzed < a.withRequests) text = `Claude has read ${num(a.analyzed)} of ${num(a.withRequests)} sessions with a customer request (up to ${num(a.limit)} per load, newest first). Refresh to continue.`;
    el.hidden = !text;
    el.textContent = text;
    el.classList.toggle('error', !!a.error);
  }

  function fillSelect(id, allLabel, items, selected) {
    const sel = $(id);
    const values = items.slice();
    if (selected && !values.includes(selected)) values.unshift(selected);
    sel.innerHTML = `<option value="">${esc(allLabel)}</option>` + values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    sel.value = selected || '';
  }

  function filterSpec(except) {
    const f = { ...state.filters };
    if (except) f[except] = '';
    return { ...f, preview: f.preview || 'exclude' };
  }

  function populateOptions() {
    const optionsWithout = (key) => M.options(M.applyFilters(state.data.sessions, filterSpec(key)));
    fillSelect('f-agent', 'All AVAs', optionsWithout('agent').agents, state.filters.agent);
    fillSelect('f-media', 'All channels', optionsWithout('media').media, state.filters.media);
    fillSelect('f-intent', 'All intents', optionsWithout('intent').intents, state.filters.intent);
  }

  // ---------- Rendering ----------
  function render() {
    if (!state.data) return;
    populateOptions();
    state.filtered = M.applyFilters(state.data.sessions, filterSpec());
    for (const [k, id] of Object.entries(FILTER_IDS)) $(id).value = state.filters[k];
    $('f-search').value = state.filters.search;
    writeHash();
    renderKpis(M.summarize(state.filtered));
    renderIntents(M.intentTable(state.filtered));
    renderVerdicts(M.summarize(state.filtered).intentVerdicts);
    renderContainment();
    renderAgents(M.agentTable(state.filtered));
    renderSessions();
    renderDefinitions();
    // Don't redraw a graph under the pointer while new analyses stream in; catch up on leave.
    if (state.tab in FLOWS) refreshFlow(state.tab);
  }

  function renderKpis(s) {
    const tiles = [
      { label: 'AVA sessions', value: num(s.sessions), sub: `${num(s.analyzed)} read by Claude` },
      (() => {
        const c = M.containmentSummary(state.filtered);
        return { label: 'Contained', value: pct(c.rate, 1), meter: c.rate, sub: c.scored ? `${num(c.contained)} of ${num(c.scored)} sessions with intents` : 'Waiting for Claude’s analysis' };
      })(),
      (() => {
        const c = M.abandonmentSummary(state.filtered);
        return { label: 'Abandoned', value: pct(c.rate, 1), meter: c.rate, sub: c.scored ? `${num(c.abandoned)} of ${num(c.scored)} sessions with intents` : 'Waiting for Claude’s analysis' };
      })(),
      { label: 'Intents detected', value: num(s.intents), sub: s.intentsPerSession != null ? `${num(s.intentsPerSession, 1)} per session · ${num(s.multiIntent)} with more than one` : '–' },
      { label: 'Tool call success', value: pct(s.toolSuccessRate, 1), meter: s.toolSuccessRate, sub: `${num(s.toolCalls)} calls · ${num(s.toolFailures)} failed` },
      { label: 'Guardrail blocks', value: num(s.guardrails), sub: `${num(s.errors)} errors or missing replies` },
    ];
    $('kpis').innerHTML = tiles
      .map((t) => `<div class="kpi"><div class="kpi-label">${esc(t.label)}</div><div class="kpi-value">${esc(t.value)}</div>` +
        (t.meter != null ? `<div class="kpi-meter"><span style="width:${Math.min(100, t.meter * 100).toFixed(1)}%"></span></div>` : '') +
        `<div class="kpi-sub">${esc(t.sub)}</div></div>`)
      .join('');
  }

  const rateCell = (v) => `<td class="num"><span class="rate">${pct(v)}<span class="rate-bar"><span style="width:${v == null ? 0 : (v * 100).toFixed(1)}%"></span></span></span></td>`;

  function renderIntents(rows) {
    const el = $('intents');
    el.innerHTML = `<thead><tr><th>Intent</th><th class="num">Sessions</th><th class="num">Valid response</th><th class="num">Valid</th><th class="num">Partly valid</th><th class="num">Not valid</th><th class="num" title="The customer left before the AVA could respond">Customer left</th></tr></thead><tbody>` +
      (rows.length ? visibleRows('intents', rows, (r) => r.intent === state.filters.intent).map((r) => `<tr data-key="${esc(r.intent)}" class="${state.filters.intent === r.intent ? 'active' : ''}" tabindex="0">
        <td class="cell-strong">${esc(r.intent)}</td><td class="num">${num(r.sessions)}</td>${rateCell(r.validRate)}
        <td class="num">${num(r.valid)}</td><td class="num">${r.partial ? `<span class="v-partial">${num(r.partial)}</span>` : '0'}</td><td class="num">${r.not_valid ? `<span class="v-not_valid">${num(r.not_valid)}</span>` : '0'}</td><td class="num">${num(r.no_chance)}</td></tr>`).join('')
        : `<tr class="empty"><td colspan="7">${state.data.analysis.enabled ? 'No intents in these sessions yet.' : 'Intents appear once Claude analysis is turned on.'}</td></tr>`) + '</tbody>';
    bindRowFilter(el, 'intent');
    renderShowMore('intents', rows.length);
  }

  // Sessions by the rule that decided them; `good` rows are drawn green, the rest red.
  function renderRuleBars(id, summary, filterKey, rowKey, good) {
    const el = $(id);
    if (!summary.scored) {
      el.innerHTML = `<div class="empty-state">${state.data.analysis.enabled ? 'Appears as Claude finishes analyzing sessions with the newest fields.' : 'Needs Claude analysis.'}</div>`;
      return;
    }
    const max = Math.max(...summary.rows.map((r) => r.count), 1);
    el.innerHTML = summary.rows.map((r) => {
      const key = rowKey(r);
      return `<div class="bar-row${state.filters[filterKey] === key ? ' active' : ''}" data-key="${key}" tabindex="0" role="button">
          <span class="bar-label">${good(r) ? '✓' : '✕'} ${esc(r.label)}</span>
          <span class="bar-value">${num(r.count)} · ${pct(r.count / summary.scored)}</span>
          <div class="bar-track"><div class="bar-fill ${good(r) ? 'v-bg-valid' : 'v-bg-not_valid'}" style="width:${((r.count / max) * 100).toFixed(1)}%"></div></div>
        </div>`;
    }).join('');
    el.querySelectorAll('.bar-row').forEach((row) => {
      const toggle = () => setFilter(filterKey, state.filters[filterKey] === row.dataset.key ? '' : row.dataset.key);
      row.addEventListener('click', toggle);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    });
  }

  // Containment and abandons by the rule that decided them, plus why transferred sessions went to a person.
  function renderContainment() {
    renderRuleBars('containment', M.containmentSummary(state.filtered), 'containment', (r) => (r.contained ? 'contained' : 'not_contained'), (r) => r.contained);
    renderRuleBars('abandons', M.abandonmentSummary(state.filtered), 'abandon', (r) => (r.abandoned ? 'abandoned' : 'not_abandoned'), (r) => !r.abandoned);
    const reasons = new Map();
    for (const s of state.filtered) {
      const r = s.analysis?.transferReason;
      if (s.transferred && r && r !== 'none') reasons.set(r, (reasons.get(r) || 0) + 1);
    }
    const rows = state.data.transferReasons.filter((r) => reasons.has(r.key)).map((r) => ({ label: r.label, count: reasons.get(r.key) })).sort((a, b) => b.count - a.count);
    const total = rows.reduce((a, r) => a + r.count, 0);
    const max = Math.max(...rows.map((r) => r.count), 1);
    const transferred = state.filtered.filter((s) => s.transferred).length;
    $('transfer-reasons').innerHTML = rows.length ? `<p class="muted small">${num(transferred)} sessions were transferred to a person after the AVA (Genesys). Reasons from Claude:</p>` + rows.map((r) => `<div class="bar-row" style="cursor:default">
        <span class="bar-label">${esc(r.label)}</span><span class="bar-value">${num(r.count)} · ${pct(r.count / total)}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${((r.count / max) * 100).toFixed(1)}%"></div></div></div>`).join('')
      : `<div class="empty-state">${transferred ? `${num(transferred)} sessions were transferred; reasons appear as Claude analyzes them.` : 'No transfers to a person in these sessions.'}</div>`;
  }

  function containmentBadge(s) {
    const c = M.containment(s);
    if (!c.status) return '<span class="muted">–</span>';
    return `<span class="badge ${c.status === 'contained' ? 'yes' : 'no'}" title="${esc(c.reason)}">${c.status === 'contained' ? 'Contained' : 'Not contained'}</span>`;
  }

  function abandonBadge(s) {
    const c = M.abandonment(s);
    if (!c.status) return '<span class="muted">–</span>';
    return `<span class="badge ${c.status === 'abandoned' ? 'no' : 'yes'}" title="${esc(c.reason)}">${c.status === 'abandoned' ? 'Abandoned' : 'Not abandoned'}</span>`;
  }

  function renderVerdicts(t) {
    const rows = state.data.verdicts.map((v) => ({ key: v.key, label: v.label, count: t[v.key] || 0 }));
    const total = rows.reduce((a, r) => a + r.count, 0);
    const el = $('verdicts');
    if (!total) {
      el.innerHTML = '<div class="empty-state">No analyzed intents for these filters.</div>';
      return;
    }
    const max = Math.max(...rows.map((r) => r.count));
    el.innerHTML = rows.map((r) => {
      const active = state.filters.intentVerdict === r.key;
      const clickable = r.key !== 'no_chance';
      return `<div class="bar-row${active ? ' active' : ''}" data-key="${esc(r.key)}" ${clickable ? 'tabindex="0" role="button"' : 'style="cursor:default"'}>
        <span class="bar-label">${esc(r.label)}</span>
        <span class="bar-value">${num(r.count)} · ${pct(r.count / total)}</span>
        <div class="bar-track"><div class="bar-fill v-bg-${esc(r.key)}" style="width:${((r.count / max) * 100).toFixed(1)}%"></div></div>
      </div>`;
    }).join('');
    el.querySelectorAll('.bar-row[role=button]').forEach((row) => {
      const toggle = () => setFilter('intentVerdict', state.filters.intentVerdict === row.dataset.key ? '' : row.dataset.key);
      row.addEventListener('click', toggle);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    });
  }

  function renderAgents(rows) {
    const el = $('agents');
    el.innerHTML = `<thead><tr><th>AVA</th><th>Versions</th><th>Channel</th><th class="num">Sessions</th><th class="num">Valid to all intents</th><th class="num">Intents valid</th><th class="num">Intents / session</th><th class="num">Tool calls</th><th class="num">Tool failures</th><th class="num">Guardrail blocks</th><th class="num">Median reply</th></tr></thead><tbody>` +
      (rows.length ? visibleRows('agents', rows, (r) => r.agentName === state.filters.agent).map((r) => `<tr data-key="${esc(r.agentName)}" class="${state.filters.agent === r.agentName ? 'active' : ''}" tabindex="0">
        <td class="cell-strong">${esc(r.agentName)}</td><td>${esc(r.versions.map((v) => `v${v}`).join(', '))}</td><td>${esc(r.media)}</td><td class="num">${num(r.sessions)}</td>${rateCell(r.allValidRate)}<td class="num">${pct(r.validIntentRate)}</td>
        <td class="num">${num(r.intentsPerSession, 1)}</td><td class="num">${num(r.toolCalls)}</td><td class="num">${num(r.toolFailures)}</td><td class="num">${num(r.guardrails)}</td><td class="num">${fmtMs(r.medianResponseMs)}</td></tr>`).join('')
        : '<tr class="empty"><td colspan="11">No AVA sessions match these filters.</td></tr>') + '</tbody>';
    bindRowFilter(el, 'agent');
    renderShowMore('agents', rows.length);
  }

  function bindRowFilter(table, key) {
    table.querySelectorAll('tbody tr[data-key]').forEach((tr) => {
      const toggle = () => setFilter(key, state.filters[key] === tr.dataset.key ? '' : tr.dataset.key);
      tr.addEventListener('click', toggle);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') toggle(); });
    });
  }

  const VERDICT_ORDER = ['not_all_valid', 'all_valid', 'customer_left', 'no_request', 'pending', 'not_analyzed'];
  const SESSION_COLUMNS = [
    { key: 'start', label: 'Started', value: (s) => s.start || '' },
    { key: 'agentName', label: 'AVA', value: (s) => s.agentName || '' },
    { key: 'media', label: 'Channel', value: (s) => s.media || '' },
    { key: 'intents', label: 'Intents detected', value: (s) => M.intents(s).map((i) => i.name).join(' > ') },
    { key: 'verdict', label: 'Valid response to all?', value: (s) => VERDICT_ORDER.indexOf(M.sessionVerdict(s)), num: true },
    { key: 'containment', label: 'Containment / abandon', value: (s) => ({ contained: 0, not_contained: 1 })[M.containment(s).status] ?? 2, num: true },
    { key: 'customerTurns', label: 'Customer turns', value: (s) => s.customerTurns, num: true },
    { key: 'toolCalls', label: 'Tools', value: (s) => s.toolCalls, num: true },
    { key: 'issues', label: 'Genesys flags', value: (s) => M.issueCount(s), num: true },
  ];

  function sortedSessions() {
    const rows = state.filtered.slice();
    const col = SESSION_COLUMNS.find((c) => c.key === state.sort.key) || SESSION_COLUMNS[0];
    rows.sort((a, b) => {
      const va = col.value(a), vb = col.value(b);
      return (typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb))) * state.sort.dir;
    });
    return rows;
  }

  const verdictChip = (i) => `<span class="chip v-${esc(i.verdict)}" title="${esc(`${verdictLabel(i.verdict)}: ${i.why}`)}">${esc(i.name)}</span>`;

  function intentChips(s) {
    const list = M.intents(s);
    if (!list.length) return '<span class="muted">–</span>';
    return `<div class="chips">${list.map(verdictChip).join('')}</div>`;
  }

  function verdictBadge(s) {
    const v = M.sessionVerdict(s);
    const cls = v === 'all_valid' ? 'yes' : v === 'not_all_valid' ? 'no' : 'unknown';
    return `<span class="badge ${cls}">${esc(M.SESSION_VERDICT_LABEL[v])}</span>`;
  }

  function issuesText(s) {
    return Object.entries(s.issues || {}).filter(([, n]) => n).map(([k, n]) => `${ISSUE_LABEL[k]}${n > 1 ? ` ×${n}` : ''}`).join(', ');
  }

  function renderSessions() {
    const rows = sortedSessions();
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    state.page = Math.min(state.page, pages);
    const pageRows = rows.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
    $('session-count').textContent = `(${num(rows.length)})`;
    const arrow = (k) => (state.sort.key === k ? (state.sort.dir < 0 ? ' ↓' : ' ↑') : '');
    const el = $('sessions');
    el.innerHTML = `<thead><tr>${SESSION_COLUMNS.map((c) => `<th data-sort="${c.key}" class="${c.num ? 'num' : ''}">${c.label}${arrow(c.key)}</th>`).join('')}</tr></thead><tbody>` +
      (pageRows.length ? pageRows.map((s) => `<tr data-id="${esc(s.id)}" tabindex="0">
        <td>${esc(fmtDateTime(s.start))}</td>
        <td><div class="cell-strong">${esc(s.agentName)}</div><div class="cell-sub">${esc(s.botName)}${s.preview ? ' · Preview test' : ''}</div></td>
        <td>${esc(s.media || '')}</td>
        <td>${intentChips(s)}</td>
        <td class="num">${verdictBadge(s)}</td>
        <td class="num">${containmentBadge(s)}<div>${M.abandonment(s).status === 'abandoned' ? abandonBadge(s) : ''}</div></td>
        <td class="num">${num(s.customerTurns)}</td>
        <td class="num">${num(s.toolCalls)}</td>
        <td class="num">${M.issueCount(s) ? `<span class="v-not_valid" title="${esc(issuesText(s))}">${num(M.issueCount(s))}</span>` : '<span class="muted">0</span>'}</td></tr>`).join('')
        : '<tr class="empty"><td colspan="9">No AVA sessions match these filters.</td></tr>') + '</tbody>';
    el.querySelectorAll('th[data-sort]').forEach((th) => th.addEventListener('click', () => {
      const k = th.dataset.sort;
      state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : ['start', 'customerTurns', 'toolCalls', 'issues'].includes(k) ? -1 : 1 };
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

  function renderDefinitions() {
    $('verdict-defs').innerHTML = `Claude judges the AVA’s handling of each intent from the transcript and the signals Genesys recorded on each turn (tool calls and their status, guardrail blocks, errors):<ul>${state.data.verdicts.map((v) => `<li><b>${esc(v.label)}</b>: ${esc(v.description)}</li>`).join('')}</ul>Hover over an intent in the session list to see why it got its verdict.`;
  }

  function exportCsv() {
    const rows = sortedSessions();
    const header = ['Started', 'AVA', 'AVA versions', 'Bot flow', 'Channel', 'Intents (in order)', 'Intent verdicts', 'Valid response to all intents', 'Containment', 'Containment rule', 'Abandoned', 'Abandon rule', 'Exit type (Genesys)', 'Last AVA state (Claude)', 'Silent after a failure (Claude)', 'Transferred (Genesys)', 'Transfer reason', 'Misunderstandings', 'Customer turns', 'Tool calls', 'Genesys flags', 'Conversation ID', 'Bot session ID', 'Preview'];
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [header.map(cell).join(',')].concat(rows.map((s) => [
      s.start, s.agentName, (s.agents || []).map((a) => a.version).join(' '), s.botName, s.media,
      M.intents(s).map((i) => i.name).join(' > '), M.intents(s).map((i) => `${i.name}: ${verdictLabel(i.verdict)}`).join('; '),
      M.SESSION_VERDICT_LABEL[M.sessionVerdict(s)], M.containment(s).status || '', M.containment(s).reason || '', M.abandonment(s).status || '', M.abandonment(s).reason || '', M.EXIT_LABEL[s.exitType] || '', s.analysis?.lastBotState || '', s.analysis?.midSessionSilence == null ? '' : s.analysis.midSessionSilence ? 'yes' : 'no', s.transferred == null ? '' : s.transferred ? 'yes' : 'no', s.analysis?.transferReason || '', s.analysis?.misunderstandings ?? '', s.customerTurns, s.toolCalls, issuesText(s), s.conversationId, s.id, s.preview ? 'yes' : 'no',
    ].map(cell).join(',')));
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
    drawer.dataset.session = s.id;
    $('drawer-title').textContent = s.agentName || 'AVA session';
    $('drawer-sub').textContent = `${fmtDateTime(s.start)} · ${s.media || ''} · ${s.botName}`;
    $('drawer-close').focus();
    const body = $('drawer-body');
    body.innerHTML = factsHtml(s) + notContainedHtml(s) + intentsHtml(s) + '<section><h3>AVA transcript</h3><div class="empty-state">Loading…</div></section>';
    try {
      let detail = state.detailCache.get(s.id);
      if (!detail) {
        const qs = new URLSearchParams({ botId: s.botId, sessionId: s.id });
        if (state.org) qs.set('org', state.org);
        const res = await fetch(`api/ava/session?${qs}`);
        detail = await res.json();
        if (!res.ok) throw new Error(detail.error || `Request failed (${res.status})`);
        state.detailCache.set(s.id, detail);
      }
      if (drawer.dataset.session !== s.id) return;
      body.innerHTML = factsHtml(s) + notContainedHtml(s) + intentsHtml(s) + transcriptHtml(detail);
    } catch (err) {
      if (drawer.dataset.session !== s.id) return;
      body.innerHTML = factsHtml(s) + notContainedHtml(s) + intentsHtml(s) + `<section><div class="empty-state">Couldn’t load the transcript: ${esc(err.message)}</div></section>`;
    }
  }

  function closeDrawer() {
    const drawer = $('drawer');
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    delete drawer.dataset.session;
    if (lastFocus) lastFocus.focus();
  }

  function factsHtml(s) {
    const facts = [
      ['Valid response to all intents', verdictBadge(s)],
      ['Containment', M.containment(s).status ? `${containmentBadge(s)}<div class="cell-sub">${esc(M.containment(s).reason)}</div>` : '–'],
      ['Abandoned', M.abandonment(s).status ? `${abandonBadge(s)}<div class="cell-sub">${esc(M.abandonment(s).reason)}</div>` : '–'],
      ['How the session ended (Genesys)', esc(M.EXIT_LABEL[s.exitType] || 'Unknown')],
      ['Last AVA message (Claude)', esc(({ prompting_input: 'Asking for input', providing_answer: 'Giving an answer', fallback_prompt: 'Fallback', error_message: 'Error message' })[s.lastResult === 'Error' ? 'error_message' : s.analysis?.lastBotState] || '–')],
      ['Silent after a failure (Claude)', s.analysis?.midSessionSilence == null ? '–' : s.analysis.midSessionSilence ? 'Yes' : 'No'],
      ['Transferred to a person', s.transferred == null ? 'Unknown' : s.transferred ? esc(`Yes${s.handoff === 'agent' ? ', reached an agent' : s.handoff === 'queue' ? ', sent to a queue' : ''}${s.queueName ? ` (${s.queueName})` : ''}`) : 'No'],
      ['Transfer reason (Claude)', esc(state.data.transferReasons.find((r) => r.key === s.analysis?.transferReason)?.label || '–')],
      ['Misunderstandings (Claude)', num(s.analysis?.misunderstandings ?? null)],
      ['AVA versions', esc((s.agents || []).map((a) => `v${a.version}`).join(', ') || '–')],
      ['Customer turns', num(s.customerTurns)],
      ['AVA session length', fmtDuration(s.start && s.end ? Date.parse(s.end) - Date.parse(s.start) : null)],
      ['Tool calls', `${num(s.toolCalls)}${s.issues?.tool_failed ? ` (${num(s.issues.tool_failed)} failed)` : ''}`],
      ['Median reply time', fmtMs(M.median(s.responseTimesMs || []))],
      ['Genesys flags', esc(issuesText(s) || 'None'), true],
      ['How the AVA ended', esc(s.endReason || 'Still in the AVA at the last turn, or ended by the flow'), true],
      ['Conversation ID', `<span class="mono">${esc(s.conversationId || '–')}</span>`, true],
    ];
    return `<section class="facts">${facts.map(([k, v, wide]) => `<div class="fact${wide ? ' wide' : ''}"><div class="k">${esc(k)}</div><div class="v">${v}</div></div>`).join('')}</section>`;
  }

  // Why a not-contained session failed containment, from the same rules the Overview uses.
  function notContainedHtml(s) {
    const x = M.containmentExplanation(s);
    if (!x) return '';
    return `<section class="not-contained"><h3>Not Contained Reason</h3>
      <p class="nc-title"><span class="badge no">${esc(x.title)}</span></p>
      <p class="nc-summary">${esc(x.summary)}</p>
      ${x.facts.map((f) => `<p class="cell-sub">${esc(f)}</p>`).join('')}
      <ul class="nc-rules">${x.rules.map((r) => `<li><b>${esc(r.rule)}</b>: ${esc(r.why)}</li>`).join('')}</ul>
    </section>`;
  }

  function intentsHtml(s) {
    const list = M.intents(s);
    let inner;
    if (s.customerTurns === 0) inner = '<div class="empty-state">The customer never said anything to the AVA.</div>';
    else if (!s.analysis) inner = `<div class="empty-state">${s.pending ? 'Claude is reading this session now.' : state.data.analysis.enabled ? 'Not analyzed yet. Refresh to continue the analysis.' : 'Turn on Claude analysis to list intents.'}</div>`;
    else if (s.analysis.refused) inner = '<div class="empty-state">Claude declined to analyze this conversation.</div>';
    else if (!list.length) inner = '<div class="empty-state">Claude found no customer request in this session.</div>';
    else inner = `<ol class="intent-list">${list.map((i) => `<li><div class="intent-head"><span class="cell-strong">${esc(i.name)}</span><span class="chip v-${esc(i.verdict)}">${esc(verdictLabel(i.verdict))}</span>${typeof i.supported === 'boolean' ? `<span class="chip">${i.supported ? 'Supported' : 'Not supported'}</span><span class="chip ${i.resolved ? 'v-valid' : 'v-not_valid'}">${i.resolved ? 'Resolved' : 'Not resolved'}</span>` : ''}</div><div class="cell-sub">Customer: ${esc(i.customerAsked)}</div><div class="why-text">${esc(i.why)}</div></li>`).join('')}</ol>`;
    return `<section><h3>Intents detected${list.length ? ` (${list.length})` : ''}</h3>${inner}</section>`;
  }

  function transcriptHtml(d) {
    if (!d.turns.length) return '<section><h3>AVA transcript</h3><div class="empty-state">Genesys no longer has turn data for this session.</div></section>';
    const html = d.turns.map((t) => {
      const userMeta = [];
      if (t.result && t.result !== 'SuccessCollection') userMeta.push(`<span class="chip ${/Error|Guardrail/.test(t.result) ? 'fail' : ''}">${esc(t.result.replace(/([a-z])([A-Z])/g, '$1 $2'))}</span>`);
      const botMeta = [];
      if (t.responseMs != null) botMeta.push(`<span class="chip">Replied in ${esc(fmtMs(t.responseMs))}</span>`);
      for (const c of t.toolCalls) botMeta.push(`<span class="chip ${c.status === 'Success' ? 'ok' : 'fail'}">Tool ${esc(c.name)} · ${esc(c.status)}${c.latencyMs != null ? ` · ${c.latencyMs} ms` : ''}</span>`);
      if (t.guardrailEvents) botMeta.push(`<span class="chip fail">${t.guardrailEvents} guardrail event${t.guardrailEvents > 1 ? 's' : ''}</span>`);
      return `<div class="turn">
        ${t.userInput ? `<div class="bubble user">${esc(t.userInput)}</div>` : ''}
        ${userMeta.length ? `<div class="turn-meta user">${userMeta.join('')}</div>` : ''}
        ${t.botPrompts.map((p) => `<div class="bubble bot">${esc(p)}</div>`).join('')}
        <div class="turn-meta"><span>${esc(fmtTime(t.time))}</span>${botMeta.join('')}</div>
        ${t.sessionEnd ? `<div class="session-end">AVA session ended · ${esc(t.sessionEnd)}</div>` : ''}
      </div>`;
    }).join('');
    return `<section><h3>AVA transcript</h3><div class="transcript">${html}</div></section>`;
  }

  // ---------- Journey Flows ----------
  function showTooltip(e, title, rows, foot) {
    const tt = $('tooltip');
    tt.innerHTML = `<div class="tt-title">${esc(title)}</div>` + rows.map(([k, v]) => `<div class="tt-row"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('') + (foot ? `<div class="tt-foot">${esc(foot)}</div>` : '');
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

  function setTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    $('view-overview').hidden = tab !== 'overview';
    $('view-journey').hidden = tab !== 'journey';
    $('view-escalation').hidden = tab !== 'escalation';
    writeHash();
    if (tab in FLOWS && state.data) renderFlow(tab);
  }

  // Journey Flows and Agent Escalation share one flow graph renderer. Each flow has its own
  // controls, intent chips, focus and table, keyed by `name` in state and in FLOWS.
  const FLOWS = {
    journey: {
      ids: { graph: 'journey', steps: 'j-steps', per: 'j-per', intents: 'journey-intents', focus: 'journey-focus', count: 'journey-count', paths: 'journey-paths' },
      sessions: () => state.filtered,
      graphOpts: {},
      lastColumn: 'Outcome',
      pathCols: {
        head: '<th class="num">Valid to all intents</th>',
        cells: (r) => rateCell(r.allValidRate),
      },
    },
    get escalation() { return ESC_MODES[state.escalation.mode] || ESC_MODES.request; },
  };
  const ESC_IDS = { graph: 'escalation', steps: 'esc-steps', per: 'esc-per', intents: 'esc-intents', focus: 'esc-focus', count: 'esc-count', paths: 'esc-paths' };
  // Agent Escalation has two views: the intents customers raised before asking for a person
  // (the default), and every session that was handed to a person.
  const ESC_MODES = {
    request: {
      ids: ESC_IDS,
      sessions: () => state.filtered.filter(M.askedForPerson),
      names: M.namesBeforeRequest,
      graphOpts: { names: M.namesBeforeRequest, outcome: M.requestOutcome, outcomes: M.REQUEST_OUTCOMES },
      lastColumn: 'AVA answer before the request',
      stepName: 'Before request',
      startTitle: 'Sessions that asked for a person after other intents',
      emptyText: 'No sessions in these filters asked for a person after raising another intent. Requests appear here once Claude has read the sessions.',
      nodeExtra: (sub) => {
        const failed = sub.filter((p) => p.outcome === 'not_valid' || p.outcome === 'partial').length;
        const judged = sub.filter((p) => p.outcome !== 'no_chance').length;
        return [['Asked right after a not valid or partial answer', judged ? `${pct(failed / judged)} of ${num(judged)}` : '–']];
      },
      pathCols: {
        head: '<th class="num">Not valid or partial right before</th><th class="num">Escalated</th>',
        cells: (r, list) => {
          const judged = list.filter((s) => ['valid', 'partial', 'not_valid'].includes(M.requestOutcome(s)));
          const failed = judged.filter((s) => M.requestOutcome(s) !== 'valid').length;
          return `${rateCell(judged.length ? failed / judged.length : null)}${rateCell(list.length ? list.filter(M.isEscalated).length / list.length : null)}`;
        },
      },
      before: () => { renderRequestKpis(); renderRequestIntents(); },
    },
    escalated: {
      ids: ESC_IDS,
      sessions: () => state.filtered.filter(M.isEscalated),
      graphOpts: { outcome: M.escalationOutcome, outcomes: M.ESCALATION_OUTCOMES },
      lastColumn: 'Escalation reason',
      startTitle: 'All escalated sessions with intents',
      emptyText: 'No escalated sessions with intents match these filters. Escalations appear here once Claude has read them.',
      nodeExtra: (sub) => {
        const counts = new Map();
        for (const p of sub) if (p.outcome !== 'unknown') counts.set(p.outcome, (counts.get(p.outcome) || 0) + 1);
        const top = [...counts].sort((x, y) => y[1] - x[1])[0];
        return top ? [['Main escalation reason', `${M.escalationLabel(top[0])} (${pct(top[1] / sub.length)})`]] : [];
      },
      pathCols: {
        head: '<th>Main reason</th><th class="num">Reached an agent</th>',
        cells: (r, list) => {
          const counts = new Map();
          for (const s of list) { const o = M.escalationOutcome(s); if (o !== 'unknown') counts.set(o, (counts.get(o) || 0) + 1); }
          const top = [...counts].sort((x, y) => y[1] - x[1])[0];
          const agent = list.filter((s) => s.handoff === 'agent').length;
          return `<td>${top ? esc(M.escalationLabel(top[0])) : '<span class="muted">–</span>'}</td>${rateCell(list.length ? agent / list.length : null)}`;
        },
      },
      before: () => { renderEscalationKpis(); renderEscalationIntents(); },
    },
  };
  const flowHover = { journey: false, escalation: false };
  const flowStale = { journey: false, escalation: false };

  // Redraw a flow unless the pointer is on its graph; then catch up when the pointer leaves.
  function refreshFlow(name) {
    if (flowHover[name]) flowStale[name] = true;
    else renderFlow(name);
  }

  function renderFlow(name) {
    const f = FLOWS[name];
    const j = state[name];
    if (name === 'escalation') renderEscalationMode();
    if (f.before) f.before();
    $(f.ids.steps).value = String(j.steps);
    $(f.ids.per).value = String(j.per);
    const opts = { ...f.graphOpts, maxSteps: j.steps, maxPerStep: j.per };
    const all = f.sessions();
    renderIntentPicker(name, all, f.names);
    // The intent picker narrows the sessions first; colors still come from all of them,
    // so an intent keeps its color whichever intents are picked.
    const base = M.withIntents(all, j.intents, j.match, f.names);
    const allGraph = M.journeyGraph(all, opts);
    const colors = window.AvaJourney.colorMap(allGraph);
    const graph = M.journeyGraph(base, { ...opts, focus: j.focus.map((x) => x.id) });
    $(f.ids.count).textContent = graph.total === allGraph.total ? `(${num(graph.total)} sessions)` : `(${num(graph.total)} of ${num(allGraph.total)} sessions)`;
    const crumbs = $(f.ids.focus);
    crumbs.hidden = !j.focus.length;
    crumbs.innerHTML = j.focus.length ? `<span class="muted small">Focused on</span>${j.focus.map((x, i) => `<span class="crumb">${esc(x.label)}<button type="button" data-i="${i}" aria-label="Remove ${esc(x.label)}">✕</button></span>`).join('')}<button type="button" class="btn btn-ghost" data-clear>Show all</button>` : '';
    crumbs.querySelectorAll('button[data-i]').forEach((b) => b.addEventListener('click', () => { j.focus.splice(Number(b.dataset.i), 1); renderFlow(name); }));
    if (j.focus.length) crumbs.querySelector('[data-clear]').addEventListener('click', () => { j.focus = []; renderFlow(name); });
    const stepLabel = (i, cols) => (i === 0 ? 'Start' : i === cols - 1 ? f.lastColumn : i > j.steps ? 'Later' : `${f.stepName || 'Intent'} ${i}`);
    const onFocus = (id, label) => {
      if (!j.focus.some((x) => x.id === id)) j.focus.push({ id, label });
      renderFlow(name);
    };
    window.AvaJourney.render($(f.ids.graph), graph, { colors, onFocus, tooltip: showTooltip, hideTooltip, columnLabels: stepLabel, nodeExtra: f.nodeExtra, startTitle: f.startTitle, emptyText: f.emptyText });
    renderTopPaths(name, graph, all);
    if (name === 'escalation') renderRequestWhy();
    writeHash();
  }

  // Toggle chips for every intent in the flow's sessions, most common first.
  const CHIP_PREVIEW = 16;
  function renderIntentPicker(name, sessions, namesOf) {
    const j = state[name];
    let rows;
    if (namesOf) {
      const counts = new Map();
      for (const s of sessions) for (const n of new Set(namesOf(s))) counts.set(n, (counts.get(n) || 0) + 1);
      rows = [...counts].map(([intent, n]) => ({ intent, sessions: n })).sort((a, b) => b.sessions - a.sessions || a.intent.localeCompare(b.intent));
    } else rows = M.intentTable(sessions);
    const host = $(FLOWS[name].ids.intents);
    if (!rows.length) {
      host.innerHTML = '';
      return;
    }
    const shown = j.allChips ? rows : rows.filter((r, i) => i < CHIP_PREVIEW || j.intents.includes(r.intent));
    host.innerHTML = `<div class="ji-head"><span class="small cell-strong">Intents</span>
        <span class="muted small">${j.intents.length ? `Showing sessions with ${j.intents.length > 1 ? `${j.match === 'all' ? 'all' : 'any'} of these ${j.intents.length} intents` : 'this intent'}` : 'Select intents to show only the sessions that include them'}</span>
        ${j.intents.length > 1 ? `<select data-match aria-label="Match"><option value="any">Any selected</option><option value="all">All selected</option></select>` : ''}
        ${j.intents.length ? '<button type="button" class="btn btn-ghost" data-clear>Clear</button>' : ''}</div>
      <div class="ji-chips" role="group" aria-label="Filter the journeys by intent">${shown.map((r) => `<button type="button" class="ji-chip" aria-pressed="${j.intents.includes(r.intent)}" data-intent="${esc(r.intent)}">${esc(r.intent)} <span class="muted">${num(r.sessions)}</span></button>`).join('')}
      ${rows.length > CHIP_PREVIEW ? `<button type="button" class="btn btn-ghost" data-more>${j.allChips ? 'Show fewer' : `Show all ${rows.length}`}</button>` : ''}</div>`;
    host.querySelectorAll('.ji-chip').forEach((b) => b.addEventListener('click', () => {
      const n = b.dataset.intent;
      j.intents = j.intents.includes(n) ? j.intents.filter((x) => x !== n) : [...j.intents, n];
      j.focus = [];
      renderFlow(name);
    }));
    const match = host.querySelector('[data-match]');
    if (match) {
      match.value = j.match;
      match.addEventListener('change', (e) => { j.match = e.target.value; j.focus = []; renderFlow(name); });
    }
    host.querySelector('[data-clear]')?.addEventListener('click', () => { j.intents = []; j.focus = []; renderFlow(name); });
    host.querySelector('[data-more]')?.addEventListener('click', () => { j.allChips = !j.allChips; renderFlow(name); });
  }

  function renderTopPaths(name, graph, sessions) {
    const f = FLOWS[name];
    const ids = new Set(graph.paths.map((p) => p.sessionId));
    const inGraph = sessions.filter((s) => ids.has(s.id));
    const namesOf = f.names || ((s) => M.intents(s).map((i) => i.name));
    const rows = M.topPaths(inGraph, 15, namesOf);
    const bySeq = new Map();
    for (const s of inGraph) {
      const key = M.sequenceFocus(namesOf(s));
      if (!bySeq.has(key)) bySeq.set(key, []);
      bySeq.get(key).push(s);
    }
    const el = $(f.ids.paths);
    const cols = 3 + (f.pathCols.head.match(/<th/g) || []).length;
    el.innerHTML = `<thead><tr><th>Intents in order</th><th class="num">Sessions</th><th class="num">Share of all</th>${f.pathCols.head}</tr></thead><tbody>` +
      (rows.length ? rows.map((r, i) => `<tr data-i="${i}" tabindex="0"><td><div class="path-cell">${r.path.map((n) => `<span class="chip">${esc(n)}</span>`).join('<span class="path-arrow" aria-hidden="true">→</span>')}</div></td><td class="num">${num(r.sessions)}</td><td class="num">${pct(r.sessions / graph.allTotal, 1)}</td>${f.pathCols.cells(r, bySeq.get(M.sequenceFocus(r.path)) || [])}</tr>`).join('')
        : `<tr class="empty"><td colspan="${cols}">No journeys match.</td></tr>`) + '</tbody>';
    // Selecting a row focuses the graph on the sessions with exactly that sequence of intents.
    el.querySelectorAll('tbody tr[data-i]').forEach((tr) => {
      const r = rows[Number(tr.dataset.i)];
      const act = () => {
        state[name].focus = [{ id: M.sequenceFocus(r.path), label: r.path.join(' → ') }];
        renderFlow(name);
        $(f.ids.graph).scrollIntoView({ block: 'start', behavior: 'smooth' });
      };
      tr.addEventListener('click', act);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') act(); });
    });
  }

  // ---------- Agent Escalation ----------
  function renderEscalationKpis() {
    const e = M.escalationSummary(state.filtered);
    const tiles = [
      { label: 'Escalated to a person', value: pct(e.rate, 1), meter: e.rate, sub: `${num(e.escalated)} of ${num(e.sessions)} AVA sessions` },
      { label: 'Reached an agent', value: pct(e.escalated ? e.reachedAgent / e.escalated : null, 1), meter: e.escalated ? e.reachedAgent / e.escalated : null, sub: `${num(e.reachedAgent)} reached an agent · ${num(e.queueOnly)} queue only` },
      { label: 'Top intent before hand-off', value: e.topLastIntent || '–', sub: e.topLastIntent ? `Last intent in ${num(e.topLastCount)} of ${num(e.withIntents)} escalations with intents` : 'Waiting for Claude’s analysis', small: true },
      { label: 'Top escalation reason', value: e.topReasonLabel || '–', sub: e.topReasonLabel ? `${num(e.topReasonCount)} of ${num(e.reasonsKnown)} escalations with a reason (${pct(e.topReasonCount / e.reasonsKnown)})` : 'Waiting for Claude’s analysis', small: true },
    ];
    $('esc-kpis').innerHTML = tiles
      .map((t) => `<div class="kpi"><div class="kpi-label">${esc(t.label)}</div><div class="kpi-value${t.small ? ' kpi-text' : ''}" title="${esc(t.value)}">${esc(t.value)}</div>` +
        (t.meter != null ? `<div class="kpi-meter"><span style="width:${Math.min(100, t.meter * 100).toFixed(1)}%"></span></div>` : '') +
        `<div class="kpi-sub">${esc(t.sub)}</div></div>`)
      .join('');
  }

  function renderEscalationIntents() {
    const rows = M.escalationIntentTable(state.filtered);
    const j = state.escalation;
    const active = (r) => j.intents.length === 1 && j.intents[0] === r.intent;
    const el = $('esc-intent-table');
    el.innerHTML = '<thead><tr><th>Intent</th><th class="num">Escalated sessions</th><th class="num">Share of escalations</th><th class="num">Escalation rate</th><th class="num">Last intent before hand-off</th><th class="num">Resolved by the AVA</th><th>Main reason</th></tr></thead><tbody>' +
      (rows.length ? visibleRows('esc-intent-table', rows, active).map((r) => `<tr data-key="${esc(r.intent)}" class="${active(r) ? 'active' : ''}" tabindex="0">
          <td class="cell-strong">${esc(r.intent)}</td>
          <td class="num">${num(r.escalated)}</td>
          ${rateCell(r.shareOfEscalated)}
          <td class="num" title="${num(r.escalated)} of ${num(r.sessions)} sessions with this intent">${pct(r.escalationRate)} <span class="muted small">of ${num(r.sessions)}</span></td>
          <td class="num">${num(r.lastBefore)}</td>
          ${rateCell(r.resolvedRate)}
          <td>${r.topReasonLabel ? esc(r.topReasonLabel) : '<span class="muted">–</span>'}</td>
        </tr>`).join('')
        : '<tr class="empty"><td colspan="7">No escalated sessions with intents yet.</td></tr>') + '</tbody>';
    renderShowMore('esc-intent-table', rows.length);
    el.querySelectorAll('tbody tr[data-key]').forEach((tr) => {
      const act = () => {
        const n = tr.dataset.key;
        j.intents = j.intents.length === 1 && j.intents[0] === n ? [] : [n];
        j.focus = [];
        renderFlow('escalation');
        if (j.intents.length) $('escalation').scrollIntoView({ block: 'start', behavior: 'smooth' });
      };
      tr.addEventListener('click', act);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') act(); });
    });
  }

  // ---------- Agent Escalation: asked for a person ----------
  function renderEscalationMode() {
    const mode = state.escalation.mode;
    document.querySelectorAll('#esc-mode button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    const request = mode === 'request';
    $('esc-title').firstChild.textContent = request ? 'Intents before asking for a person ' : 'Escalation journeys ';
    $('esc-hint').textContent = request
      ? 'Sessions where the customer asked to speak to a person after raising other intents. Each path runs through those intents in order and ends in how the AVA answered the one right before the request. Hover a node or line to trace its sessions; click it to focus on just those sessions.'
      : 'Only sessions handed to a person after the AVA. Each path runs through the customer’s intents in order and ends in why the session escalated. Hover a node or line to trace its sessions; click it to focus on just those sessions.';
    $('esc-table-title').textContent = request ? 'Intents leading to “speak to a person”' : 'Intents driving escalations';
    $('esc-table-hint').textContent = request ? 'Select a row to see how the AVA answered it and why' : 'Select a row to show only escalations with that intent';
    $('esc-paths-title').textContent = request ? 'Most common journeys before asking for a person' : 'Most common escalation journeys';
    document.querySelectorAll('[data-esc-mode]').forEach((el) => { el.hidden = el.dataset.escMode !== mode; });
  }

  function renderRequestKpis() {
    const r = M.requestSummary(state.filtered);
    const tiles = [
      { label: 'Asked for a person', value: pct(r.rate, 1), meter: r.rate, sub: `${num(r.asked)} of ${num(r.sessions)} sessions with intents` },
      { label: 'After other intents', value: num(r.afterIntents), sub: `${num(r.rightAway)} asked for a person straight away` },
      { label: 'Intent most often right before', value: r.topLastIntent || '–', sub: r.topLastIntent ? `Right before the request in ${num(r.topLastCount)} of ${num(r.afterIntents)} sessions` : 'Waiting for Claude’s analysis', small: true },
      { label: 'Asked after a poor answer', value: pct(r.failedRate, 1), meter: r.failedRate, sub: r.judged ? `${num(r.failed)} of ${num(r.judged)}: the AVA’s answer right before was not valid or partial` : 'Waiting for Claude’s analysis' },
    ];
    $('esc-kpis').innerHTML = tiles
      .map((t) => `<div class="kpi"><div class="kpi-label">${esc(t.label)}</div><div class="kpi-value${t.small ? ' kpi-text' : ''}" title="${esc(t.value)}">${esc(t.value)}</div>` +
        (t.meter != null ? `<div class="kpi-meter"><span style="width:${Math.min(100, t.meter * 100).toFixed(1)}%"></span></div>` : '') +
        `<div class="kpi-sub">${esc(t.sub)}</div></div>`)
      .join('');
  }

  // A stacked bar of how the AVA answered an intent before the customer asked for a person.
  const ANSWER_ORDER = ['not_valid', 'partial', 'valid', 'no_chance'];
  function verdictMix(v) {
    const total = ANSWER_ORDER.reduce((a, k) => a + v[k], 0);
    if (!total) return '<span class="muted">–</span>';
    const title = ANSWER_ORDER.filter((k) => v[k]).map((k) => `${verdictLabel(k)}: ${v[k]}`).join(' · ');
    return `<span class="mix" title="${esc(title)}">${ANSWER_ORDER.filter((k) => v[k]).map((k) => `<span class="mix-${k}" style="width:${((v[k] / total) * 100).toFixed(1)}%"></span>`).join('')}</span>`;
  }

  function renderRequestIntents() {
    const rows = M.requestIntentTable(state.filtered);
    const j = state.escalation;
    const active = (r) => j.intents.length === 1 && j.intents[0] === r.intent;
    const el = $('esc-intent-table');
    el.innerHTML = '<thead><tr><th>Intent before the request</th><th class="num">Sessions</th><th class="num">Share of requests</th><th class="num">Request rate</th><th class="num">Right before the request</th><th>How the AVA answered</th><th class="num">Not valid or partial</th><th class="num">Not resolved</th></tr></thead><tbody>' +
      (rows.length ? visibleRows('esc-intent-table', rows, active).map((r) => `<tr data-key="${esc(r.intent)}" class="${active(r) ? 'active' : ''}" tabindex="0">
          <td class="cell-strong">${esc(r.intent)}</td>
          <td class="num">${num(r.before)}</td>
          ${rateCell(r.shareOfRequests)}
          <td class="num" title="${num(r.before)} of ${num(r.sessions)} sessions with this intent went on to ask for a person">${pct(r.requestRate)} <span class="muted small">of ${num(r.sessions)}</span></td>
          <td class="num">${num(r.rightBefore)}</td>
          <td>${verdictMix(r.verdicts)}</td>
          ${rateCell(r.notValidRate)}
          ${rateCell(r.unresolvedRate)}
        </tr>`).join('')
        : '<tr class="empty"><td colspan="8">No sessions asked for a person after another intent yet.</td></tr>') + '</tbody>';
    renderShowMore('esc-intent-table', rows.length);
    el.querySelectorAll('tbody tr[data-key]').forEach((tr) => {
      const act = () => {
        const n = tr.dataset.key;
        j.intents = j.intents.length === 1 && j.intents[0] === n ? [] : [n];
        j.focus = [];
        j.allNotes = false;
        renderFlow('escalation');
        if (j.intents.length) $('esc-why').scrollIntoView({ block: 'start', behavior: 'smooth' });
      };
      tr.addEventListener('click', act);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') act(); });
    });
  }

  // For one selected intent: how the AVA answered it before each request, in Claude's words.
  const NOTE_PREVIEW = 8;
  function renderRequestWhy() {
    const j = state.escalation;
    const card = $('esc-why');
    const name = j.mode === 'request' && j.intents.length === 1 ? j.intents[0] : null;
    const row = name && M.requestIntentTable(state.filtered).find((r) => r.intent === name);
    card.hidden = !row;
    if (!row) return;
    const v = row.verdicts;
    const notes = j.allNotes ? row.notes : row.notes.slice(0, NOTE_PREVIEW);
    const reasons = new Map();
    for (const n of row.notes) if (n.transferReason && n.transferReason !== 'none') reasons.set(n.transferReason, (reasons.get(n.transferReason) || 0) + 1);
    const reasonText = [...reasons].sort((a, b) => b[1] - a[1]).map(([k, c]) => `${state.data.transferReasons.find((r) => r.key === k)?.label || k} ${num(c)}`).join(' · ');
    $('esc-why-title').textContent = `Why customers asked for a person after “${name}”`;
    $('esc-why-body').innerHTML = `<p class="why-summary">In <b>${num(row.before)}</b> sessions the customer raised this intent and then asked for a person (${pct(row.requestRate)} of the ${num(row.sessions)} sessions with it). Before the request, the AVA’s answer was
        <span class="chip v-not_valid">not valid ${num(v.not_valid)}</span> <span class="chip v-partial">partial ${num(v.partial)}</span> <span class="chip v-valid">valid ${num(v.valid)}</span> <span class="chip v-no_chance">no chance to answer ${num(v.no_chance)}</span>.
        ${row.unresolvedRate != null ? `Claude judged it not resolved in ${pct(row.unresolvedRate)} of the sessions where the AVA answered.` : ''} ${reasonText ? `Claude’s transfer reasons: ${esc(reasonText)}.` : ''}</p>
      <ol class="why-list">${notes.map((n, i) => `<li><div class="intent-head"><span class="chip v-${esc(n.verdict)}">${esc(verdictLabel(n.verdict))}</span><span class="muted small">${esc(fmtDateTime(n.start))}${n.escalated ? ' · escalated' : ' · not escalated'}</span><button type="button" class="btn btn-ghost" data-open="${esc(n.sessionId)}">Open session</button></div>
        ${n.customerAsked ? `<div class="cell-sub">Customer: ${esc(n.customerAsked)}</div>` : ''}<div class="why-text">${esc(n.why || 'No note from Claude.')}</div></li>`).join('')}</ol>
      ${row.notes.length > NOTE_PREVIEW ? `<button type="button" class="btn btn-ghost" id="esc-why-more">${j.allNotes ? 'Show fewer' : `Show all ${num(row.notes.length)}`}</button>` : ''}`;
    card.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => {
      const s = state.filtered.find((x) => x.id === b.dataset.open);
      if (s) openSession(s);
    }));
    $('esc-why-more')?.addEventListener('click', () => { j.allNotes = !j.allNotes; renderRequestWhy(); });
  }

  // ---------- Events ----------
  function setFilter(key, value) {
    state.filters[key] = value;
    state.page = 1;
    render();
  }

  async function loadOrgs() {
    const sel = $('f-org');
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

  // Every panel under the Overview tiles can be collapsed from its heading; the choice is
  // remembered per browser.
  const COLLAPSE_KEY = 'ava-collapsed-panels';
  function readCollapsed() {
    try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]')); } catch { return new Set(); }
  }
  function setupCollapsible() {
    const collapsed = readCollapsed();
    document.querySelectorAll('#view-overview .card').forEach((card) => {
      const h2 = card.querySelector('h2');
      if (!h2) return;
      const id = h2.firstChild.textContent.trim();
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'collapse-toggle';
      btn.innerHTML = '<span class="chev" aria-hidden="true">▾</span>';
      btn.append(...h2.childNodes);
      h2.appendChild(btn);
      const apply = (on) => {
        card.classList.toggle('collapsed', on);
        btn.setAttribute('aria-expanded', String(!on));
      };
      apply(collapsed.has(id));
      btn.addEventListener('click', () => {
        const on = !card.classList.contains('collapsed');
        apply(on);
        const now = readCollapsed();
        if (on) now.add(id); else now.delete(id);
        try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...now])); } catch { /* collapse still works for this visit */ }
      });
    });
  }

  async function init() {
    readHash();
    setupCollapsible();
    if (![...$('f-range').options].some((o) => o.value === state.range)) state.range = '7';
    $('f-range').value = state.range;
    $('f-from').value = state.from || '';
    $('f-to').value = state.to || '';
    document.querySelectorAll('.custom-range').forEach((el) => { el.hidden = state.range !== 'custom'; });
    document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
    for (const [name, f] of Object.entries(FLOWS)) {
      $(f.ids.steps).addEventListener('change', (e) => { state[name].steps = Number(e.target.value); state[name].focus = []; renderFlow(name); });
      $(f.ids.per).addEventListener('change', (e) => { state[name].per = Number(e.target.value); state[name].focus = []; renderFlow(name); });
      $(f.ids.graph).addEventListener('pointerenter', () => { flowHover[name] = true; });
      $(f.ids.graph).addEventListener('pointerleave', () => {
        flowHover[name] = false;
        if (flowStale[name]) { flowStale[name] = false; renderFlow(name); }
      });
    }
    document.querySelectorAll('#esc-mode button').forEach((b) => b.addEventListener('click', () => {
      Object.assign(state.escalation, { mode: b.dataset.mode, focus: [], intents: [], allNotes: false });
      renderFlow('escalation');
    }));
    let resizeTimer;
    window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.tab in FLOWS && state.data) renderFlow(state.tab); }, 150); });
    setTab(state.tab);
    await loadOrgs();
    $('f-org').addEventListener('change', (e) => {
      // AVAs and intents differ between orgs, so start the new org unfiltered.
      state.org = e.target.value;
      for (const k of Object.keys(state.filters)) state.filters[k] = '';
      for (const name of Object.keys(FLOWS)) Object.assign(state[name], { focus: [], intents: [] });
      state.detailCache.clear();
      state.page = 1;
      load();
    });
    $('f-range').addEventListener('change', (e) => {
      state.range = e.target.value;
      document.querySelectorAll('.custom-range').forEach((el) => { el.hidden = state.range !== 'custom'; });
      if (state.range === 'custom') {
        state.from = state.from || M.localDay(currentInterval().start);
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
      for (const name of Object.keys(FLOWS)) Object.assign(state[name], { focus: [], intents: [] });
      state.page = 1;
      render();
    });
    $('refresh').addEventListener('click', () => load());
    $('export').addEventListener('click', exportCsv);
    $('drawer-close').addEventListener('click', closeDrawer);
    $('drawer').addEventListener('click', (e) => { if (e.target === $('drawer')) closeDrawer(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('drawer').classList.contains('open')) closeDrawer(); });
    load();
  }

  init();
})();
