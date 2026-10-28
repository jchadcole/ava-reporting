// Journey Flows: an interactive flow graph of the intents in each AVA session, from Start
// through each intent in the order raised to the session's outcome. Hover a node or line to
// trace the sessions through it; click to focus the graph on them (it re-lays itself out).
(function () {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const NODE_W = 12;
  const GAP = 14;
  const PAD_Y = 12;
  const LABEL_W = 240; // room for the outcome labels right of the last column
  const CAT = ['var(--cat-1)', 'var(--cat-2)', 'var(--cat-3)', 'var(--cat-4)', 'var(--cat-5)', 'var(--cat-6)'];
  const OUTCOME_COLOR = {
    all_valid: 'var(--good)', not_all_valid: 'var(--critical)', customer_left: 'var(--series-unknown)',
    // Agent Escalation ends each path in the reason for the hand-off.
    unsupported_intent: 'var(--accent)', user_frustration: 'var(--critical)', system_error: 'var(--warning)', customer_preference: 'var(--text-2)', unknown: 'var(--series-unknown)',
    // Agent Escalation, intents before the hand-off: how the AVA answered the one right before it.
    not_valid: 'var(--critical)', partial: 'var(--cat-4)', valid: 'var(--good)', no_chance: 'var(--series-unknown)',
  };

  const el = (name, attrs = {}) => {
    const n = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  const pct = (v) => (v == null ? '–' : `${(v * 100).toFixed(v < 0.1 && v > 0 ? 1 : 0)}%`);

  // Intent colors follow the intent, not its rank in a focused view: the caller passes a map
  // built from the unfocused data. Only the six most common intents get a hue; the rest are gray
  // and every node carries a text label, so identity never rests on color alone.
  function colorMap(graph) {
    const totals = new Map();
    for (const n of graph.nodes) if (n.kind === 'intent') totals.set(n.key, (totals.get(n.key) || 0) + n.count);
    const map = new Map();
    [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, CAT.length).forEach(([k], i) => map.set(k, CAT[i]));
    return map;
  }

  function nodeColor(n, colors) {
    if (n.kind === 'start') return 'var(--text-2)';
    if (n.kind === 'outcome') return OUTCOME_COLOR[n.key] || 'var(--series-unknown)';
    return colors.get(n.key) || 'var(--series-unknown)';
  }

  function layout(graph, width, height) {
    const lastFinite = Math.max(0, ...graph.nodes.filter((n) => n.kind !== 'outcome').map((n) => n.step));
    const cols = lastFinite + 2;
    const colOf = (n) => (n.kind === 'outcome' ? cols - 1 : n.step);
    const columns = Array.from({ length: cols }, () => []);
    for (const n of graph.nodes) columns[colOf(n)].push(n);
    const rank = (n) => (n.kind === 'other' || n.kind === 'more' ? 1 : 0);
    const outcomeOrder = graph.outcomeOrder || ['all_valid', 'not_all_valid', 'customer_left'];
    for (const c of columns) c.sort((a, b) => (a.kind === 'outcome' ? outcomeOrder.indexOf(a.key) - outcomeOrder.indexOf(b.key) : rank(a) - rank(b) || b.count - a.count || a.label.localeCompare(b.label)));
    const maxNodes = Math.max(...columns.map((c) => c.length));
    const innerH = height - PAD_Y * 2;
    const scale = graph.total ? Math.max(0.01, (innerH - (maxNodes - 1) * GAP - maxNodes * 3) / graph.total) : 1;
    const x0 = 4;
    const x1 = width - LABEL_W;
    const step = cols > 1 ? (x1 - x0 - NODE_W) / (cols - 1) : 0;
    for (const [ci, c] of columns.entries()) {
      const hs = c.map((n) => Math.max(3, n.count * scale));
      const used = hs.reduce((a, b) => a + b, 0) + (c.length - 1) * GAP;
      let y = PAD_Y + Math.max(0, (innerH - used) / 2);
      c.forEach((n, i) => {
        Object.assign(n, { x: x0 + ci * step, y, h: hs[i], col: ci });
        y += hs[i] + GAP;
      });
    }
    // Stack each node's links in the order of the node at their other end, so lines don't cross needlessly.
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const links = graph.links.map((l) => ({ ...l, s: byId.get(l.source), t: byId.get(l.target), w: Math.max(1, l.count * scale) }));
    for (const n of graph.nodes) {
      let off = 0;
      for (const l of links.filter((l) => l.s === n).sort((a, b) => a.t.y - b.t.y)) { l.sy = n.y + off; off += l.count * scale; }
      off = 0;
      for (const l of links.filter((l) => l.t === n).sort((a, b) => a.s.y - b.s.y)) { l.ty = n.y + off; off += l.count * scale; }
    }
    return { columns, links, scale, cols };
  }

  // A band from the right edge of the source to the left edge of the target.
  function bandPath(l, from = 0, width = l.w) {
    const xs = l.s.x + NODE_W;
    const xt = l.t.x;
    const mx = (xs + xt) / 2;
    const a = l.sy + from;
    const b = l.ty + from;
    return `M${xs},${a} C${mx},${a} ${mx},${b} ${xt},${b} L${xt},${b + width} C${mx},${b + width} ${mx},${a + width} ${xs},${a + width} Z`;
  }

  function defaultNodeExtra(sub) {
    const valid = sub.filter((p) => p.outcome === 'all_valid').length;
    const scored = sub.filter((p) => p.outcome === 'all_valid' || p.outcome === 'not_all_valid').length;
    return [['Valid response to all intents', scored ? pct(valid / scored) : '–']];
  }

  function render(host, graph, opts) {
    const { colors, onFocus, tooltip, hideTooltip, columnLabels } = opts;
    const nodeExtra = opts.nodeExtra || defaultNodeExtra;
    const startTitle = opts.startTitle || 'All sessions with intents';
    host.innerHTML = '';
    if (!graph.total) {
      host.innerHTML = `<div class="empty-state">${opts.emptyText || 'No analyzed sessions with intents match these filters.'}</div>`;
      return;
    }
    const width = Math.max(host.clientWidth || 900, 640);
    const maxNodes = Math.max(...Object.values(graph.nodes.reduce((a, n) => ((a[n.kind === 'outcome' ? 'end' : n.step] = (a[n.kind === 'outcome' ? 'end' : n.step] || 0) + 1), a), {})));
    const height = Math.max(420, maxNodes * 46);
    const { links, columns, scale } = layout(graph, width, height + 24);
    const svg = el('svg', { viewBox: `0 0 ${width} ${height + 48}`, width, height: height + 48, class: 'journey-svg', role: 'img', 'aria-label': 'Flow of intents through AVA sessions' });

    // Column headings
    const heads = el('g', { class: 'j-heads' });
    columns.forEach((c, i) => {
      if (!c.length) return;
      const t = el('text', { x: c[0].x, y: 12, class: 'j-head' });
      t.textContent = columnLabels(i, columns.length);
      heads.appendChild(t);
    });
    svg.appendChild(heads);
    const plot = el('g', { transform: 'translate(0,24)' });
    svg.appendChild(plot);

    const linkLayer = el('g', { class: 'j-links' });
    const hiLayer = el('g', { class: 'j-hi' });
    const nodeLayer = el('g', { class: 'j-nodes' });
    plot.append(linkLayer, hiLayer, nodeLayer);

    const linkEls = new Map();
    for (const l of links) {
      const color = l.s.kind === 'start' ? nodeColor(l.t, colors) : nodeColor(l.s, colors);
      const p = el('path', { d: bandPath(l), fill: color, class: 'j-link', tabindex: 0, 'aria-label': `${l.s.label} to ${l.t.label}: ${l.count} sessions` });
      linkLayer.appendChild(p);
      linkEls.set(l.id, p);
    }

    const nodeEls = new Map();
    for (const c of columns) for (const n of c) {
      const g = el('g', { class: `j-node j-${n.kind}`, tabindex: 0, role: 'button', 'aria-label': `${n.label}: ${n.count} sessions. Click to focus.` });
      g.appendChild(el('rect', { x: n.x - 6, y: n.y - 4, width: NODE_W + 12, height: n.h + 8, fill: 'transparent' })); // larger hit target
      g.appendChild(el('rect', { x: n.x, y: n.y, width: NODE_W, height: n.h, rx: 3, fill: nodeColor(n, colors), class: 'j-bar' }));
      const last = n.col === columns.length - 1;
      const label = el('text', { x: last ? n.x + NODE_W + 8 : n.x + NODE_W + 6, y: n.y + n.h / 2, class: 'j-label', 'dominant-baseline': 'middle' });
      const name = el('tspan', { class: 'j-name' });
      name.textContent = n.label.length > 26 && !last ? `${n.label.slice(0, 25)}…` : n.label; // full name in the tooltip
      const val = el('tspan', { class: 'j-val', dx: 6 });
      val.textContent = pct(n.count / graph.allTotal);
      label.append(name, val);
      g.appendChild(label);
      nodeLayer.appendChild(g);
      nodeEls.set(n.id, g);
    }

    // ---------- Hover: trace the sessions through what's under the pointer ----------
    function highlight(subset, key) {
      hiLayer.innerHTML = '';
      svg.classList.toggle('tracing', !!subset);
      if (!subset) return;
      const counts = window.AvaMetrics.linkCounts(subset);
      const touched = new Set();
      for (const l of links) {
        const n = counts.get(l.id);
        if (!n) continue;
        touched.add(l.source).add(l.target);
        const color = l.s.kind === 'start' ? nodeColor(l.t, colors) : nodeColor(l.s, colors);
        hiLayer.appendChild(el('path', { d: bandPath(l, 0, Math.max(1, n * scale)), fill: color, class: `j-link-hi${l.id === key ? ' exact' : ''}` }));
      }
      for (const [id, g] of nodeEls) g.classList.toggle('dim', !touched.has(id));
    }

    const pathsThroughNode = (id) => graph.paths.filter((p) => p.nodes.includes(id));
    const pathsThroughLink = (l) => graph.paths.filter((p) => { const i = p.nodes.indexOf(l.source); return i >= 0 && p.nodes[i + 1] === l.target; });

    function nodeTip(e, n) {
      const sub = pathsThroughNode(n.id);
      const rows = [['Sessions', n.count.toLocaleString()], ['Share of all sessions', pct(n.count / graph.allTotal)]];
      if (graph.total !== graph.allTotal) rows.push(['Share of focused sessions', pct(n.count / graph.total)]);
      if (n.kind !== 'outcome') rows.push(...nodeExtra(sub));
      tooltip(e, n.kind === 'start' ? startTitle : n.label, rows, n.kind === 'start' ? '' : 'Click to focus on these sessions');
    }

    for (const n of graph.nodes) {
      const g = nodeEls.get(n.id);
      const enter = (e) => { highlight(pathsThroughNode(n.id)); nodeTip(e, n); };
      g.addEventListener('pointerenter', enter);
      g.addEventListener('pointermove', (e) => nodeTip(e, n));
      g.addEventListener('pointerleave', () => { highlight(null); hideTooltip(); });
      g.addEventListener('focus', () => { const r = g.getBoundingClientRect(); enter({ clientX: r.right, clientY: r.top }); });
      g.addEventListener('blur', () => { highlight(null); hideTooltip(); });
      const act = () => { if (n.kind !== 'start') { hideTooltip(); onFocus(n.id, n.label); } };
      g.addEventListener('click', act);
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(); } });
    }
    for (const l of links) {
      const p = linkEls.get(l.id);
      const tip = (e) => {
        const rows = [['Sessions', l.count.toLocaleString()], ['Share of all sessions', pct(l.count / graph.allTotal)], [`Share of ${l.s.kind === 'start' ? 'all' : `“${l.s.label}”`}`, pct(l.count / l.s.count)]];
        tooltip(e, `${l.s.kind === 'start' ? 'Start' : l.s.label} → ${l.t.label}`, rows, 'Click to focus on this path');
      };
      p.addEventListener('pointerenter', (e) => { highlight(pathsThroughLink(l), l.id); tip(e); });
      p.addEventListener('pointermove', tip);
      p.addEventListener('pointerleave', () => { highlight(null); hideTooltip(); });
      p.addEventListener('focus', () => { highlight(pathsThroughLink(l), l.id); const r = p.getBoundingClientRect(); tip({ clientX: r.left + r.width / 2, clientY: r.top }); });
      p.addEventListener('blur', () => { highlight(null); hideTooltip(); });
      const act = () => { hideTooltip(); onFocus(l.id, `${l.s.kind === 'start' ? 'Start' : l.s.label} → ${l.t.label}`); };
      p.addEventListener('click', act);
      p.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(); } });
    }
    host.appendChild(svg);
  }

  window.AvaJourney = { render, colorMap };
})();
