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

  const FILTER_IDS = { agent: 'f-agent', media: 'f-media', intent: 'f-intent', verdict: 'f-verdict', intentVerdict: 'f-intentverdict', issues: 'f-issues', preview: 'f-preview' };
  const ISSUE_LABEL = { error: 'Error', guardrail: 'Guardrail block', tool_failed: 'Tool failed', no_reply: 'No reply' };

  const state = {
    org: '',
    orgs: [],
    range: '7',
    from: null,
    to: null,
    filters: { agent: '', media: '', intent: '', verdict: '', intentVerdict: '', issues: '', preview: '', search: '' },
    data: null,
    filtered: [],
    page: 1,
    sort: { key: 'start', dir: -1 },
    detailCache: new Map(),
    expanded: { intents: false, agents: false },
    tab: 'overview',
    journey: { steps: 4, per: 8, focus: [], intents: [], match: 'any', allChips: false }, // focus: [{ id, label }] from clicks on the graph
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
    if (p.get('tab') === 'journey') state.tab = 'journey';
    if (Number(p.get('steps'))) state.journey.steps = Number(p.get('steps'));
    if (Number(p.get('per'))) state.journey.per = Number(p.get('per'));
    if (p.get('jintents')) state.journey.intents = p.get('jintents').split('|');
    if (p.get('jmatch') === 'all') state.journey.match = 'all';
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
    if (state.tab === 'journey') {
      p.set('tab', 'journey');
      p.set('steps', state.journey.steps);
      p.set('per', state.journey.per);
      if (state.journey.intents.length) p.set('jintents', state.journey.intents.join('|'));
      if (state.journey.match === 'all') p.set('jmatch', 'all');
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
    renderAgents(M.agentTable(state.filtered));
    renderSessions();
    renderDefinitions();
    if (state.tab === 'journey') {
      // Don't redraw the graph under the pointer while new analyses stream in; catch up on leave.
      if (journeyHover) journeyStale = true;
      else renderJourney();
    }
  }

  function renderKpis(s) {
    const tiles = [
      { label: 'AVA sessions', value: num(s.sessions), sub: `${num(s.analyzed)} read by Claude` },
      { label: 'Valid response to all intents', value: pct(s.allValidRate, 1), meter: s.allValidRate, sub: s.scored ? `${num(s.allValid)} of ${num(s.scored)} sessions` : 'No analyzed sessions yet' },
      { label: 'Intents with a valid response', value: pct(s.validIntentRate, 1), meter: s.validIntentRate, sub: `${num(s.intentVerdicts.valid)} of ${num(s.judgedIntents)} intents` },
      { label: 'Intents detected', value: num(s.intents), sub: s.intentsPerSession != null ? `${num(s.intentsPerSession, 1)} per session · ${num(s.multiIntent)} with more than one` : '–' },
      { label: 'Tool call success', value: pct(s.toolSuccessRate, 1), meter: s.toolSuccessRate, sub: `${num(s.toolCalls)} calls · ${num(s.toolFailures)} failed` },
      { label: 'Guardrail blocks', value: num(s.guardrails), sub: `${num(s.errors)} errors or missing replies` },
      { label: 'Asked for a person', value: num(s.agentRequested), sub: 'Sessions where the customer asked the AVA for an agent' },
      { label: 'AVA reply time', value: fmtMs(s.medianResponseMs), sub: s.responseTurns ? `Median of ${num(s.responseTurns)} turns` : 'No turn timing reported' },
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
        <td class="num">${num(s.customerTurns)}</td>
        <td class="num">${num(s.toolCalls)}</td>
        <td class="num">${M.issueCount(s) ? `<span class="v-not_valid" title="${esc(issuesText(s))}">${num(M.issueCount(s))}</span>` : '<span class="muted">0</span>'}</td></tr>`).join('')
        : '<tr class="empty"><td colspan="8">No AVA sessions match these filters.</td></tr>') + '</tbody>';
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
    const header = ['Started', 'AVA', 'AVA versions', 'Bot flow', 'Channel', 'Intents (in order)', 'Intent verdicts', 'Valid response to all intents', 'Customer turns', 'Tool calls', 'Genesys flags', 'Conversation ID', 'Bot session ID', 'Preview'];
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [header.map(cell).join(',')].concat(rows.map((s) => [
      s.start, s.agentName, (s.agents || []).map((a) => a.version).join(' '), s.botName, s.media,
      M.intents(s).map((i) => i.name).join(' > '), M.intents(s).map((i) => `${i.name}: ${verdictLabel(i.verdict)}`).join('; '),
      M.SESSION_VERDICT_LABEL[M.sessionVerdict(s)], s.customerTurns, s.toolCalls, issuesText(s), s.conversationId, s.id, s.preview ? 'yes' : 'no',
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
    body.innerHTML = factsHtml(s) + intentsHtml(s) + '<section><h3>AVA transcript</h3><div class="empty-state">Loading…</div></section>';
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
      body.innerHTML = factsHtml(s) + intentsHtml(s) + transcriptHtml(detail);
    } catch (err) {
      if (drawer.dataset.session !== s.id) return;
      body.innerHTML = factsHtml(s) + intentsHtml(s) + `<section><div class="empty-state">Couldn’t load the transcript: ${esc(err.message)}</div></section>`;
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

  function intentsHtml(s) {
    const list = M.intents(s);
    let inner;
    if (s.customerTurns === 0) inner = '<div class="empty-state">The customer never said anything to the AVA.</div>';
    else if (!s.analysis) inner = `<div class="empty-state">${s.pending ? 'Claude is reading this session now.' : state.data.analysis.enabled ? 'Not analyzed yet. Refresh to continue the analysis.' : 'Turn on Claude analysis to list intents.'}</div>`;
    else if (s.analysis.refused) inner = '<div class="empty-state">Claude declined to analyze this conversation.</div>';
    else if (!list.length) inner = '<div class="empty-state">Claude found no customer request in this session.</div>';
    else inner = `<ol class="intent-list">${list.map((i) => `<li><div class="intent-head"><span class="cell-strong">${esc(i.name)}</span><span class="chip v-${esc(i.verdict)}">${esc(verdictLabel(i.verdict))}</span></div><div class="cell-sub">Customer: ${esc(i.customerAsked)}</div><div class="why-text">${esc(i.why)}</div></li>`).join('')}</ol>`;
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
    writeHash();
    if (tab === 'journey' && state.data) renderJourney();
  }

  let journeyHover = false;
  let journeyStale = false;

  function focusJourney(id, label) {
    if (!state.journey.focus.some((f) => f.id === id)) state.journey.focus.push({ id, label });
    renderJourney();
  }

  function renderJourney() {
    const j = state.journey;
    $('j-steps').value = String(j.steps);
    $('j-per').value = String(j.per);
    const opts = { maxSteps: j.steps, maxPerStep: j.per };
    renderIntentPicker();
    // The intent picker narrows the sessions first; colors still come from all of them,
    // so an intent keeps its color whichever intents are picked.
    const base = M.withIntents(state.filtered, j.intents, j.match);
    const colors = window.AvaJourney.colorMap(M.journeyGraph(state.filtered, opts));
    const full = M.journeyGraph(base, opts);
    const graph = M.journeyGraph(base, { ...opts, focus: j.focus.map((f) => f.id) });
    const allWithIntents = j.intents.length ? M.journeyGraph(state.filtered, opts).total : full.total;
    $('journey-count').textContent = graph.total === allWithIntents ? `(${num(graph.total)} sessions)` : `(${num(graph.total)} of ${num(allWithIntents)} sessions)`;
    const crumbs = $('journey-focus');
    crumbs.hidden = !j.focus.length;
    crumbs.innerHTML = j.focus.length ? `<span class="muted small">Focused on</span>${j.focus.map((f, i) => `<span class="crumb">${esc(f.label)}<button type="button" data-i="${i}" aria-label="Remove ${esc(f.label)}">✕</button></span>`).join('')}<button type="button" class="btn btn-ghost" id="j-clear">Show all</button>` : '';
    crumbs.querySelectorAll('button[data-i]').forEach((b) => b.addEventListener('click', () => { j.focus.splice(Number(b.dataset.i), 1); renderJourney(); }));
    if (j.focus.length) $('j-clear').addEventListener('click', () => { j.focus = []; renderJourney(); });
    const stepLabel = (i, cols) => (i === 0 ? 'Start' : i === cols - 1 ? 'Outcome' : i > j.steps ? 'Later' : `Intent ${i}`);
    window.AvaJourney.render($('journey'), graph, { colors, onFocus: focusJourney, tooltip: showTooltip, hideTooltip, columnLabels: stepLabel });
    renderTopPaths(graph);
    writeHash();
  }

  // Toggle chips for every intent in the filtered sessions, most common first.
  const CHIP_PREVIEW = 16;
  function renderIntentPicker() {
    const j = state.journey;
    const rows = M.intentTable(state.filtered);
    const host = $('journey-intents');
    if (!rows.length) {
      host.innerHTML = '';
      return;
    }
    const shown = j.allChips ? rows : rows.filter((r, i) => i < CHIP_PREVIEW || j.intents.includes(r.intent));
    host.innerHTML = `<div class="ji-head"><span class="small cell-strong">Intents</span>
        <span class="muted small">${j.intents.length ? `Showing sessions with ${j.intents.length > 1 ? `${j.match === 'all' ? 'all' : 'any'} of these ${j.intents.length} intents` : 'this intent'}` : 'Select intents to show only the sessions that include them'}</span>
        ${j.intents.length > 1 ? `<select id="ji-match" aria-label="Match"><option value="any">Any selected</option><option value="all">All selected</option></select>` : ''}
        ${j.intents.length ? '<button type="button" class="btn btn-ghost" id="ji-clear">Clear</button>' : ''}</div>
      <div class="ji-chips" role="group" aria-label="Filter the journeys by intent">${shown.map((r) => `<button type="button" class="ji-chip" aria-pressed="${j.intents.includes(r.intent)}" data-intent="${esc(r.intent)}">${esc(r.intent)} <span class="muted">${num(r.sessions)}</span></button>`).join('')}
      ${rows.length > CHIP_PREVIEW ? `<button type="button" class="btn btn-ghost" id="ji-more">${j.allChips ? 'Show fewer' : `Show all ${rows.length}`}</button>` : ''}</div>`;
    host.querySelectorAll('.ji-chip').forEach((b) => b.addEventListener('click', () => {
      const name = b.dataset.intent;
      j.intents = j.intents.includes(name) ? j.intents.filter((n) => n !== name) : [...j.intents, name];
      j.focus = [];
      renderJourney();
    }));
    if ($('ji-match')) {
      $('ji-match').value = j.match;
      $('ji-match').addEventListener('change', (e) => { j.match = e.target.value; j.focus = []; renderJourney(); });
    }
    if ($('ji-clear')) $('ji-clear').addEventListener('click', () => { j.intents = []; j.focus = []; renderJourney(); });
    if ($('ji-more')) $('ji-more').addEventListener('click', () => { j.allChips = !j.allChips; renderJourney(); });
  }

  function renderTopPaths(graph) {
    const ids = new Set(graph.paths.map((p) => p.sessionId));
    const rows = M.topPaths(state.filtered.filter((s) => ids.has(s.id)));
    const el = $('journey-paths');
    el.innerHTML = '<thead><tr><th>Intents in order</th><th class="num">Sessions</th><th class="num">Share of all</th><th class="num">Valid to all intents</th></tr></thead><tbody>' +
      (rows.length ? rows.map((r, i) => `<tr data-i="${i}" tabindex="0"><td><div class="path-cell">${r.path.map((n) => `<span class="chip">${esc(n)}</span>`).join('<span class="path-arrow" aria-hidden="true">→</span>')}</div></td><td class="num">${num(r.sessions)}</td><td class="num">${pct(r.sessions / graph.allTotal, 1)}</td>${rateCell(r.allValidRate)}</tr>`).join('')
        : '<tr class="empty"><td colspan="4">No journeys match.</td></tr>') + '</tbody>';
    // Selecting a row focuses the graph on the sessions with exactly that sequence of intents.
    el.querySelectorAll('tbody tr[data-i]').forEach((tr) => {
      const r = rows[Number(tr.dataset.i)];
      const act = () => {
        state.journey.focus = [{ id: M.sequenceFocus(r.path), label: r.path.join(' → ') }];
        renderJourney();
        $('journey').scrollIntoView({ block: 'start', behavior: 'smooth' });
      };
      tr.addEventListener('click', act);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') act(); });
    });
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

  async function init() {
    readHash();
    if (![...$('f-range').options].some((o) => o.value === state.range)) state.range = '7';
    $('f-range').value = state.range;
    $('f-from').value = state.from || '';
    $('f-to').value = state.to || '';
    document.querySelectorAll('.custom-range').forEach((el) => { el.hidden = state.range !== 'custom'; });
    document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
    $('j-steps').addEventListener('change', (e) => { state.journey.steps = Number(e.target.value); state.journey.focus = []; writeHash(); renderJourney(); });
    $('j-per').addEventListener('change', (e) => { state.journey.per = Number(e.target.value); state.journey.focus = []; writeHash(); renderJourney(); });
    let resizeTimer;
    window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.tab === 'journey' && state.data) renderJourney(); }, 150); });
    $('journey').addEventListener('pointerenter', () => { journeyHover = true; });
    $('journey').addEventListener('pointerleave', () => {
      journeyHover = false;
      if (journeyStale) { journeyStale = false; renderJourney(); }
    });
    setTab(state.tab);
    await loadOrgs();
    $('f-org').addEventListener('change', (e) => {
      // AVAs and intents differ between orgs, so start the new org unfiltered.
      state.org = e.target.value;
      for (const k of Object.keys(state.filters)) state.filters[k] = '';
      state.journey.focus = [];
      state.journey.intents = [];
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
      state.journey.focus = [];
      state.journey.intents = [];
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
