(() => {
  'use strict';

  const data = JSON.parse(document.getElementById('ripplemap-data').textContent);
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const KIND_LABEL = { image: 'image', 'terraform-module': 'module', workflow: 'workflow', action: 'action', npm: 'npm' };
  const MAX_REFS = 3;

  const $ = (id) => document.getElementById(id);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const short = (id) => (data.owner && id.startsWith(data.owner + '/') ? id.slice(data.owner.length + 1) : id);
  const shortVersion = (v) => (/^[0-9a-f]{40}$/.test(v) ? v.slice(0, 12) : v);
  const repoUrl = new Map(data.repos.map((r) => [r.id, r.url]));

  /** Tiny DOM builder: h('div', { class: 'x', onclick }, child, 'text'). */
  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === false) continue;
      if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child);
    return node;
  }

  function svg(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, value);
    return node;
  }

  // ---------------------------------------------------------------------------
  // Graph data

  const kinds = [...new Set(data.links.map((l) => l.kind))].sort();
  const enabledKinds = new Set(kinds);
  let selected = null;

  /** producer → consumer → links, and consumer → producer → links, for the enabled kinds. */
  let consumers = new Map();
  let dependencies = new Map();

  function add(map, a, b, link) {
    let inner = map.get(a);
    if (!inner) map.set(a, (inner = new Map()));
    let links = inner.get(b);
    if (!links) inner.set(b, (links = []));
    links.push(link);
  }

  function indexLinks() {
    consumers = new Map();
    dependencies = new Map();
    for (const link of data.links) {
      if (!enabledKinds.has(link.kind)) continue;
      add(consumers, link.to, link.from, link);
      add(dependencies, link.from, link.to, link);
    }
  }

  /** Every repo that depends on `target`, breadth-first: repo → { depth, parent, links }. */
  function impactOf(target) {
    const result = new Map();
    const seen = new Set([target]);
    let frontier = [target];
    for (let depth = 1; frontier.length; depth++) {
      const next = [];
      for (const producer of frontier) {
        for (const [repo, links] of consumers.get(producer) || []) {
          if (seen.has(repo)) continue;
          seen.add(repo);
          result.set(repo, { depth, parent: producer, links });
          next.push(repo);
        }
      }
      frontier = next.sort();
    }
    return result;
  }

  // One drawn edge per (consumer, producer) pair, whatever the number of references.
  const pairsByKey = new Map();
  for (const link of data.links) {
    const key = `${link.from}\n${link.to}`;
    let pair = pairsByKey.get(key);
    if (!pair) pairsByKey.set(key, (pair = { from: link.from, to: link.to, kinds: new Set() }));
    pair.kinds.add(link.kind);
  }
  const pairs = [...pairsByKey.values()];

  const linked = new Set(pairs.flatMap((p) => [p.from, p.to]));
  const nodes = data.repos.filter((r) => linked.has(r.id)).map((r, i) => ({ id: r.id, i, x: 0, y: 0, consumers: 0 }));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  for (const pair of pairs) nodeById.get(pair.to).consumers++;

  // ---------------------------------------------------------------------------
  // Layout: Fruchterman–Reingold, run once up front. Fine for a few hundred repos.

  function layout() {
    const n = nodes.length;
    if (!n) return;
    const golden = Math.PI * (3 - Math.sqrt(5));
    // Start hubs near the middle so the layout settles faster.
    [...nodes]
      .sort((a, b) => b.consumers - a.consumers)
      .forEach((node, i) => {
        const r = 18 * Math.sqrt(i + 0.5);
        node.x = r * Math.cos(i * golden);
        node.y = r * Math.sin(i * golden);
      });

    const k = 44;
    // Without a cutoff, a big cluster pushes small separate groups far off screen.
    const cutoff2 = (k * 8) ** 2;
    const iterations = n > 600 ? 120 : n > 250 ? 200 : 300;
    const edges = pairs.map((p) => [nodeById.get(p.from), nodeById.get(p.to)]);
    const dx = new Float64Array(n);
    const dy = new Float64Array(n);

    for (let it = 0; it < iterations; it++) {
      dx.fill(0);
      dy.fill(0);
      for (let a = 0; a < n; a++) {
        const A = nodes[a];
        for (let b = a + 1; b < n; b++) {
          const B = nodes[b];
          let x = A.x - B.x;
          let y = A.y - B.y;
          let d2 = x * x + y * y;
          if (d2 > cutoff2) continue;
          if (d2 < 0.01) {
            x = (a - b) * 0.1;
            y = 0.1;
            d2 = x * x + y * y;
          }
          const f = (k * k) / d2;
          dx[a] += x * f;
          dy[a] += y * f;
          dx[b] -= x * f;
          dy[b] -= y * f;
        }
      }
      for (const [A, B] of edges) {
        const x = A.x - B.x;
        const y = A.y - B.y;
        const f = Math.sqrt(x * x + y * y) / k;
        dx[A.i] -= x * f;
        dy[A.i] -= y * f;
        dx[B.i] += x * f;
        dy[B.i] += y * f;
      }
      const t = k * 3 * (1 - it / iterations) + 1;
      for (let a = 0; a < n; a++) {
        // A little gravity keeps separate clusters on screen.
        dx[a] -= nodes[a].x * 0.04;
        dy[a] -= nodes[a].y * 0.04;
        const len = Math.hypot(dx[a], dy[a]) || 1;
        const step = Math.min(len, t);
        nodes[a].x += (dx[a] / len) * step;
        nodes[a].y += (dy[a] / len) * step;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Drawing

  const graph = $('graph');
  const viewport = $('viewport');
  const tooltip = $('tooltip');
  const view = { x: 0, y: 0, k: 1 };

  const radius = (node) => 4 + Math.sqrt(node.consumers) * 2.2;

  function draw() {
    for (const pair of pairs) {
      pair.el = svg('line', { class: 'edge' });
      $('edges').append(pair.el);
    }
    for (const node of nodes) {
      node.el = svg('g', { class: 'node' });
      node.el.append(svg('circle', { r: radius(node) }));
      node.el.addEventListener('pointerenter', () => showTooltip(node));
      node.el.addEventListener('pointerleave', () => (tooltip.hidden = true));
      $('nodes').append(node.el);
      // Labels live in their own layer above every circle, so no node can cover text.
      node.label = svg('text', { class: 'label' });
      node.label.textContent = short(node.id);
      $('labels').append(node.label);
    }
    position();
  }

  function position() {
    for (const node of nodes) node.el.setAttribute('transform', `translate(${node.x},${node.y})`);
    for (const pair of pairs) {
      const a = nodeById.get(pair.from);
      const b = nodeById.get(pair.to);
      pair.el.setAttribute('x1', a.x);
      pair.el.setAttribute('y1', a.y);
      pair.el.setAttribute('x2', b.x);
      pair.el.setAttribute('y2', b.y);
    }
    scheduleLabels();
  }

  function applyView() {
    viewport.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
    // Labels and outlines keep the same on-screen size at any zoom.
    graph.style.setProperty('--k', String(view.k));
    scheduleLabels();
  }

  /** Zooms so `list` fills the graph. `trim` ignores that share of outliers on each side. */
  function fitNodes(list, { trim = 0, maxZoom = 2.5, pad = 70 } = {}) {
    if (!list.length) return;
    const range = (values) => {
      const sorted = [...values].sort((a, b) => a - b);
      const at = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
      return [at(trim), at(1 - trim)];
    };
    const [minX, maxX] = range(list.map((n) => n.x));
    const [minY, maxY] = range(list.map((n) => n.y));
    const w = graph.clientWidth;
    const hgt = graph.clientHeight;
    view.k = Math.min((w - pad * 2) / Math.max(maxX - minX, 1), (hgt - pad * 2) / Math.max(maxY - minY, 1), maxZoom);
    view.x = w / 2 - ((minX + maxX) / 2) * view.k;
    view.y = hgt / 2 - ((minY + maxY) / 2) * view.k;
    applyView();
  }

  // The bulk of the graph; a few small separate groups shouldn't shrink everything else.
  const fit = () => fitNodes(nodes, { trim: nodes.length >= 40 ? 0.03 : 0 });

  /** Zooms to the selected repo and everything lit up with it, leaving room for their labels. */
  function focusSelection() {
    const lit = nodes.filter((n) => n.el.classList.contains('lit'));
    if (lit.length === 1) {
      view.k = Math.max(view.k, 1.5);
      view.x = graph.clientWidth / 2 - lit[0].x * view.k;
      view.y = graph.clientHeight / 2 - lit[0].y * view.k;
      applyView();
    } else {
      fitNodes(lit, { maxZoom: 4, pad: 110 });
    }
  }

  // ---------------------------------------------------------------------------
  // Labels: show as many as fit without overlapping each other or any node, most important first.

  const measure = document.createElement('canvas').getContext('2d');
  const labelFont = getComputedStyle(document.body).fontFamily;
  const LABEL = { normal: { size: 11, weight: 400, h: 13 }, strong: { size: 12.5, weight: 650, h: 15 } };

  function textWidth(node, style) {
    const key = style === LABEL.strong ? 'wStrong' : 'w';
    if (node[key] === undefined) {
      measure.font = `${style.weight} ${style.size}px ${labelFont}`;
      // Canvas measures a little narrower than SVG renders; pad so labels never touch a dot.
      node[key] = measure.measureText(short(node.id)).width * 1.06 + 2;
    }
    return node[key];
  }

  let labelFrame = 0;
  function scheduleLabels() {
    if (!labelFrame) labelFrame = requestAnimationFrame(placeLabels);
  }

  function placeLabels() {
    labelFrame = 0;
    const width = graph.clientWidth;
    const height = graph.clientHeight;
    const onScreen = (n) => ({ x: n.x * view.k + view.x, y: n.y * view.k + view.y, r: radius(n) * view.k });
    const has = (n, cls) => n.el.classList.contains(cls);

    let wanted;
    let obstacles;
    if (selected) {
      const rank = (n) => (n.id === selected ? 0 : has(n, 'direct') ? 1 : has(n, 'dependency') ? 2 : 3);
      wanted = nodes.filter((n) => has(n, 'lit')).sort((a, b) => rank(a) - rank(b) || b.consumers - a.consumers);
      obstacles = wanted; // faded nodes may sit under a label
    } else {
      wanted = nodes.filter((n) => n.consumers > 0).sort((a, b) => b.consumers - a.consumers).slice(0, 40);
      // Only the hubs block labels; small leaves can sit under the text, which has an outline.
      obstacles = wanted;
    }
    const mustShow = selected ? nodeById.get(selected) : wanted[0];
    const circles = obstacles.map((n) => ({ node: n, ...onScreen(n) }));
    // The legend and the Fit button float over the graph, so labels avoid them too.
    const box = graph.getBoundingClientRect();
    const placed = [...document.querySelectorAll('.legend, #fit')].map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left - box.left - 4, y: r.top - box.top - 4, w: r.width + 8, h: r.height + 8 };
    });

    const hitsLabel = (a) => placed.some((b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h);
    const hitsNode = (rect) =>
      circles.some((c) => {
        const cx = Math.max(rect.x, Math.min(c.x, rect.x + rect.w));
        const cy = Math.max(rect.y, Math.min(c.y, rect.y + rect.h));
        return (c.x - cx) ** 2 + (c.y - cy) ** 2 < (c.r + 1.5) ** 2;
      });
    const inView = (rect) => rect.x >= 4 && rect.y >= 4 && rect.x + rect.w <= width - 4 && rect.y + rect.h <= height - 4;

    const shown = new Set();
    for (const node of wanted) {
      const c = onScreen(node);
      const style = node.id === selected ? LABEL.strong : LABEL.normal;
      const w = textWidth(node, style);
      const h = style.h;
      const gap = 3;
      const candidates = [
        { x: c.x + c.r + gap, y: c.y - h / 2 },
        { x: c.x - c.r - gap - w, y: c.y - h / 2 },
        { x: c.x - w / 2, y: c.y - c.r - gap - h },
        { x: c.x - w / 2, y: c.y + c.r + gap },
      ].map((p) => ({ ...p, w, h }));
      let spot = candidates.find((r) => inView(r) && !hitsLabel(r) && !hitsNode(r));
      // The selected repo (or the biggest hub) is always named, even if it has to overlap something.
      if (!spot && node === mustShow) spot = candidates.find((r) => !hitsLabel(r)) || candidates[0];
      if (!spot) continue;
      placed.push(spot);
      shown.add(node);
      node.label.setAttribute('x', (spot.x - view.x) / view.k);
      node.label.setAttribute('y', (spot.y + h * 0.78 - view.y) / view.k);
    }
    for (const node of nodes) {
      node.label.classList.toggle('placed', shown.has(node));
      node.label.classList.toggle('strong', node.id === selected);
    }
  }

  function showTooltip(node) {
    const r = graph.getBoundingClientRect();
    const wrap = graph.parentElement.getBoundingClientRect();
    tooltip.textContent = `${short(node.id)} · used by ${plural(consumers.get(node.id)?.size ?? 0, 'repo')}`;
    tooltip.style.left = `${node.x * view.k + view.x + r.left - wrap.left}px`;
    tooltip.style.top = `${node.y * view.k + view.y - radius(node) * view.k + r.top - wrap.top}px`;
    tooltip.hidden = false;
  }

  // Pan with the background, drag nodes, zoom with the wheel or a trackpad pinch.
  function setUpInteraction() {
    let drag = null;
    const point = (e) => {
      const r = graph.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    graph.addEventListener('pointerdown', (e) => {
      const nodeEl = e.target.closest('.node');
      const node = nodeEl && nodes.find((n) => n.el === nodeEl);
      drag = { node, start: point(e), last: point(e), moved: false };
      graph.setPointerCapture(e.pointerId);
      if (!node) graph.classList.add('panning');
    });

    graph.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const p = point(e);
      if (Math.hypot(p.x - drag.start.x, p.y - drag.start.y) > 4) drag.moved = true;
      if (drag.node) {
        drag.node.x += (p.x - drag.last.x) / view.k;
        drag.node.y += (p.y - drag.last.y) / view.k;
        position();
        tooltip.hidden = true;
      } else {
        view.x += p.x - drag.last.x;
        view.y += p.y - drag.last.y;
        applyView();
      }
      drag.last = p;
    });

    graph.addEventListener('pointerup', () => {
      if (drag && !drag.moved) select(drag.node ? drag.node.id : null);
      drag = null;
      graph.classList.remove('panning');
    });

    graph.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const p = point(e);
        const k = Math.min(8, Math.max(0.08, view.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))));
        view.x = p.x - (p.x - view.x) * (k / view.k);
        view.y = p.y - (p.y - view.y) * (k / view.k);
        view.k = k;
        applyView();
        tooltip.hidden = true;
      },
      { passive: false },
    );

    $('fit').addEventListener('click', fit);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.activeElement !== $('search')) select(null);
    });
  }

  function highlight() {
    graph.classList.toggle('focus', Boolean(selected));
    for (const node of nodes) node.el.classList.remove('selected', 'direct', 'indirect', 'dependency', 'lit');
    for (const pair of pairs) {
      pair.el.classList.remove('hot', 'indirect', 'dep');
      pair.el.style.display = [...pair.kinds].some((k) => enabledKinds.has(k)) ? '' : 'none';
    }
    scheduleLabels();
    if (!selected) return;

    const affected = impactOf(selected);
    const deps = dependencies.get(selected) || new Map();
    const mark = (id, ...classes) => nodeById.get(id)?.el.classList.add('lit', ...classes);
    mark(selected, 'selected');
    for (const [id, info] of affected) mark(id, info.depth === 1 ? 'direct' : 'indirect');
    for (const id of deps.keys()) if (!affected.has(id)) mark(id, 'dependency');

    for (const pair of pairs) {
      if (pair.el.style.display === 'none') continue;
      const from = affected.get(pair.from);
      if (from && (pair.to === selected || affected.has(pair.to))) pair.el.classList.add('hot', ...(from.depth > 1 ? ['indirect'] : []));
      else if (pair.from === selected && deps.has(pair.to)) pair.el.classList.add('dep');
    }
  }

  // ---------------------------------------------------------------------------
  // Side panel

  function refLine(link) {
    const url = repoUrl.get(link.from);
    const where = `${link.file}:${link.line}`;
    return h(
      'span',
      { class: 'ref' },
      h('span', { class: 'kind' }, KIND_LABEL[link.kind] || link.kind),
      `${link.name}${link.kind === 'image' ? ':' : '@'}${shortVersion(link.version)} · `,
      url ? h('a', { href: `${url}/blob/HEAD/${link.file}#L${link.line}`, target: '_blank', rel: 'noopener' }, where) : where,
      link.confidence === 'convention' ? h('span', { class: 'guess', title: 'Linked by naming convention' }, ' (guessed)') : null,
    );
  }

  function refLines(links) {
    const shown = links.slice(0, MAX_REFS).map(refLine);
    if (links.length > MAX_REFS) shown.push(h('span', { class: 'ref' }, `+${links.length - MAX_REFS} more`));
    return shown;
  }

  function repoButton(id, dotClass, ...extra) {
    return h(
      'button',
      { class: 'repo-link', onclick: () => select(id, { focus: true }) },
      dotClass ? h('i', { class: `dot ${dotClass}` }) : null,
      short(id),
      ...extra,
    );
  }

  function renderOverview(box) {
    const ranked = [...consumers]
      .map(([id, users]) => ({ id, count: users.size }))
      .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
      .slice(0, 15);
    box.append(
      h('h2', {}, 'Most depended-on'),
      h('p', { class: 'sub' }, 'Click a repo in the graph or the list to see everything a change to it would affect.'),
      ranked.length
        ? h('ul', { class: 'list top-list' }, ranked.map((r) => h('li', {}, repoButton(r.id, null, h('span', { class: 'uses-count' }, `used by ${r.count}`)))))
        : h('p', { class: 'hint' }, 'No cross-repo links found in this scan.'),
    );
    const unlinked = data.repos.length - nodes.length;
    if (unlinked > 0) box.append(h('p', { class: 'hint' }, `${plural(unlinked, 'repo')} have no cross-repo links and aren't drawn. You can still search for them.`));
  }

  function renderRepo(box, id) {
    const affected = impactOf(id);
    const deps = dependencies.get(id) || new Map();
    const direct = [...affected].filter(([, info]) => info.depth === 1);
    const indirect = [...affected].filter(([, info]) => info.depth > 1);
    const url = repoUrl.get(id);

    box.append(
      h('h2', {}, short(id)),
      url ? h('p', { class: 'sub' }, h('a', { href: url, target: '_blank', rel: 'noopener' }, url.replace(/^https:\/\//, ''))) : null,
      h(
        'p',
        { class: 'headline' },
        affected.size
          ? ['Changing it affects ', h('b', {}, plural(affected.size, 'repo')), `: ${direct.length} direct, ${indirect.length} indirect.`]
          : 'Nothing in this scan depends on it.',
      ),
    );

    if (direct.length) {
      box.append(
        h('h3', {}, `Directly affected (${direct.length})`),
        h('ul', { class: 'list' }, direct.map(([repo, info]) => h('li', {}, repoButton(repo, 'direct'), refLines(info.links)))),
      );
    }
    if (indirect.length) {
      box.append(
        h('h3', {}, `Indirectly affected (${indirect.length})`),
        h(
          'ul',
          { class: 'list' },
          indirect.map(([repo, info]) =>
            h('li', {}, repoButton(repo, 'indirect', h('span', { class: 'via' }, `via ${short(info.parent)}`)), refLines(info.links.slice(0, 1))),
          ),
        ),
      );
    }
    if (deps.size) {
      box.append(
        h('h3', {}, `Depends on (${deps.size})`),
        h('ul', { class: 'list' }, [...deps].sort(([a], [b]) => a.localeCompare(b)).map(([repo, links]) => h('li', {}, repoButton(repo, 'dependency'), refLines(links)))),
      );
    }
  }

  function renderDetails() {
    const box = $('details');
    box.replaceChildren();
    if (selected) renderRepo(box, selected);
    else renderOverview(box);
  }

  function select(id, options = {}) {
    selected = id;
    if (id) showTab('impact');
    highlight();
    renderDetails();
    $('search').value = id ? short(id) : '';
    history.replaceState(null, '', id ? `#repo=${encodeURIComponent(id)}` : location.pathname + location.search);
    if (id && options.focus) focusSelection();
  }

  function setUpSearch() {
    const input = $('search');
    $('repo-names').replaceChildren(...data.repos.map((r) => h('option', { value: short(r.id) })));
    const find = (text) => {
      const q = text.trim().toLowerCase();
      if (!q) return null;
      return (
        data.repos.find((r) => r.id === q || short(r.id) === q) ||
        data.repos.find((r) => short(r.id).startsWith(q)) ||
        data.repos.find((r) => r.id.includes(q))
      );
    };
    const go = () => {
      const repo = find(input.value);
      if (repo) select(repo.id, { focus: true });
    };
    input.addEventListener('change', go);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') go();
      if (e.key === 'Escape') select(null);
    });
  }

  function setUpKinds() {
    const box = $('kinds');
    if (kinds.length < 2) return;
    for (const kind of kinds) {
      const count = data.links.filter((l) => l.kind === kind).length;
      const chip = h('button', { class: 'chip', 'aria-pressed': 'true', title: `Show ${KIND_LABEL[kind]} links` }, KIND_LABEL[kind] || kind, h('span', { class: 'n' }, count));
      chip.addEventListener('click', () => {
        const on = !enabledKinds.has(kind);
        if (on) enabledKinds.add(kind);
        else if (enabledKinds.size > 1) enabledKinds.delete(kind);
        else return;
        chip.setAttribute('aria-pressed', String(on));
        indexLinks();
        highlight();
        renderDetails();
      });
      box.append(chip);
    }
  }

  // ---------------------------------------------------------------------------
  // Drift tab

  /** Long lists collapse so the outliers on other versions stay visible. */
  function repoChips(repos) {
    const COLLAPSED = 6;
    const box = h('div', { class: 'repos' });
    const chip = (repo) => h('button', { class: 'repo-chip', onclick: () => select(repo, { focus: true }) }, short(repo));
    const show = (all) => {
      const visible = all || repos.length <= COLLAPSED + 2 ? repos : repos.slice(0, COLLAPSED);
      box.replaceChildren(...visible.map(chip));
      if (visible.length < repos.length) {
        box.append(h('button', { class: 'repo-chip more', onclick: () => show(true) }, `+${repos.length - visible.length} more`));
      }
    };
    show(false);
    return box;
  }

  function renderDrift() {
    const includeThirdParty = $('third-party').checked;
    const entries = data.drift.filter((e) => includeThirdParty || e.producers.length);
    $('drift-count').textContent = String(data.drift.filter((e) => e.producers.length).length);

    const list = $('drift-list');
    list.replaceChildren();
    if (!entries.length) {
      list.append(h('p', { class: 'empty' }, includeThirdParty ? 'No version drift found.' : 'Nothing built in these repos is used at more than one version.'));
      return;
    }
    for (const entry of entries) {
      const repoCount = new Set(entry.versions.flatMap((v) => v.repos)).size;
      list.append(
        h(
          'article',
          { class: 'artifact' },
          h(
            'div',
            { class: 'artifact-head' },
            h('span', { class: 'name' }, entry.name),
            entry.producers.length
              ? h('span', { class: 'badge internal' }, `built in ${entry.producers.map(short).join(', ')}`)
              : h('span', { class: 'badge' }, 'third-party'),
            h('span', { class: 'meta' }, `${KIND_LABEL[entry.kind] || entry.kind} · ${plural(entry.versions.length, 'version')} across ${plural(repoCount, 'repo')}`),
          ),
          h(
            'div',
            { class: 'versions' },
            entry.versions.flatMap((v, i) => [
              h('span', { class: `v${i === 0 ? ' newest' : ''}`, title: i === 0 ? 'Newest' : undefined }, shortVersion(v.version)),
              repoChips(v.repos),
            ]),
          ),
        ),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Tabs and startup

  let fitted = false;
  function showTab(name) {
    for (const button of document.querySelectorAll('.tabs button')) button.setAttribute('aria-selected', String(button.dataset.tab === name));
    $('tab-impact').hidden = name !== 'impact';
    $('tab-drift').hidden = name !== 'drift';
    if (name === 'impact' && !fitted) {
      fitted = true;
      requestAnimationFrame(() => (selected ? focusSelection() : fit()));
    }
  }

  for (const button of document.querySelectorAll('.tabs button')) button.addEventListener('click', () => showTab(button.dataset.tab));
  $('third-party').addEventListener('change', renderDrift);

  const generated = new Date(data.generatedAt);
  $('stats').replaceChildren(
    h('b', {}, String(data.repos.length)),
    ' repos · ',
    h('b', {}, String(data.links.length)),
    ' links · ',
    Number.isNaN(generated.getTime()) ? '' : `scanned ${generated.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`,
  );

  indexLinks();
  layout();
  draw();
  setUpInteraction();
  setUpSearch();
  setUpKinds();
  renderDrift();

  if (!nodes.length) {
    graph.parentElement.append(h('p', { class: 'empty', style: 'position:absolute;inset:40% 0 auto' }, 'No cross-repo links found in this scan.'));
  }

  /** Links like report.html#repo=acme/api open with that repo selected. */
  function selectFromHash() {
    const id = decodeURIComponent((location.hash.match(/^#repo=(.+)$/) || [])[1] || '');
    select(data.repos.some((r) => r.id === id) ? id : null, { focus: true });
  }

  showTab('impact');
  selectFromHash();
  window.addEventListener('hashchange', selectFromHash);
  window.addEventListener('resize', fit);
})();
