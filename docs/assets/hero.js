// The moving web behind the landing page's headline. It's a real org's dependency graph
// (data/hero.json, written by scripts/demos.ts). Every few seconds one repo "changes" and the
// ripple runs through every repo that depends on it, the way the report shows it.
(() => {
  'use strict';
  const canvas = document.getElementById('web');
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const css = getComputedStyle(document.documentElement);
  const color = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  const GREEN = color('--green', '#3dff8f');
  const DIRECT = color('--direct', '#ff5f4a');
  const INDIRECT = color('--indirect', '#ffb340');
  const FONT = '12px "JetBrains Mono", ui-monospace, Menlo, monospace';

  let nodes = [];
  let edges = [];
  let consumers = [];
  let width = 0;
  let height = 0;
  let ripple = null;
  let visible = true;
  let start = performance.now();

  function layout() {
    // Fruchterman–Reingold on a unit square, run once. A few hundred nodes take a few milliseconds.
    const n = nodes.length;
    const k = Math.sqrt(1 / n) * 0.9;
    for (let iter = 0, t = 0.1; iter < 260; iter++, t *= 0.985) {
      for (const a of nodes) (a.dx = 0), (a.dy = 0);
      for (let i = 0; i < n; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < n; j++) {
          const b = nodes[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          const d2 = dx * dx + dy * dy || 1e-6;
          const f = (k * k) / d2;
          dx *= f;
          dy *= f;
          a.dx += dx;
          a.dy += dy;
          b.dx -= dx;
          b.dy -= dy;
        }
      }
      for (const [i, j] of edges) {
        const a = nodes[i];
        const b = nodes[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1e-6;
        const f = d / k;
        a.dx -= dx * f;
        a.dy -= dy * f;
        b.dx += dx * f;
        b.dy += dy * f;
      }
      for (const a of nodes) {
        // Gravity keeps unconnected clusters on screen.
        a.dx -= (a.x - 0.5) * 0.6;
        a.dy -= (a.y - 0.5) * 0.6;
        const d = Math.sqrt(a.dx * a.dx + a.dy * a.dy) || 1e-6;
        const step = Math.min(d, t);
        a.x += (a.dx / d) * step;
        a.y += (a.dy / d) * step;
      }
    }
    // Normalize to 0..1, trimming outliers.
    const xs = nodes.map((a) => a.x).sort((a, b) => a - b);
    const ys = nodes.map((a) => a.y).sort((a, b) => a - b);
    const q = (arr, p) => arr[Math.floor(p * (arr.length - 1))];
    const [x0, x1, y0, y1] = [q(xs, 0.02), q(xs, 0.98), q(ys, 0.02), q(ys, 0.98)];
    for (const a of nodes) {
      a.ux = (a.x - x0) / (x1 - x0 || 1);
      a.uy = (a.y - y0) / (y1 - y0 || 1);
    }
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = rect.width;
    height = rect.height;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // On wide screens the web fills the right side, behind and beside the text. On phones, all of it.
    const wide = width > 900;
    const box = wide
      ? { x: width * 0.36, y: height * 0.1, w: width * 0.6, h: height * 0.8 }
      : { x: width * 0.04, y: height * 0.06, w: width * 0.92, h: height * 0.88 };
    for (const a of nodes) {
      a.bx = box.x + a.ux * box.w;
      a.by = box.y + a.uy * box.h;
    }
    if (reduced) draw(performance.now());
  }

  /** Breadth-first through the repos that depend on `source`: [{ node, parent, depth }]. */
  function spread(source) {
    const seen = new Set([source]);
    const out = [];
    let frontier = [source];
    for (let depth = 1; frontier.length && depth < 8; depth++) {
      const next = [];
      for (const p of frontier) {
        for (const c of consumers[p]) {
          if (seen.has(c)) continue;
          seen.add(c);
          out.push({ node: c, parent: p, depth });
          next.push(c);
        }
      }
      frontier = next;
    }
    return out;
  }

  const candidates = () => nodes.map((_, i) => i).filter((i) => consumers[i].length >= 3);
  let lastSource = -1;
  function newRipple(now) {
    const pool = candidates();
    if (!pool.length) return null;
    let source = pool[Math.floor(Math.random() * pool.length)];
    if (source === lastSource && pool.length > 1) source = pool[(pool.indexOf(source) + 1) % pool.length];
    lastSource = source;
    return { source, hits: spread(source), t0: now };
  }

  const STEP = 420; // ms per hop
  const HOLD = 1800;

  function draw(now) {
    ctx.clearRect(0, 0, width, height);
    const t = (now - start) / 1000;
    for (const a of nodes) {
      // A slow drift so the web feels alive.
      a.px = a.bx + Math.sin(t * 0.35 + a.phase) * 4;
      a.py = a.by + Math.cos(t * 0.3 + a.phase * 1.3) * 4;
    }

    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(61, 255, 143, 0.11)';
    ctx.beginPath();
    for (const [i, j] of edges) {
      ctx.moveTo(nodes[i].px, nodes[i].py);
      ctx.lineTo(nodes[j].px, nodes[j].py);
    }
    ctx.stroke();

    ctx.fillStyle = 'rgba(61, 255, 143, 0.45)';
    ctx.beginPath();
    for (const a of nodes) {
      ctx.moveTo(a.px + a.r, a.py);
      ctx.arc(a.px, a.py, a.r, 0, Math.PI * 2);
    }
    ctx.fill();

    if (!ripple) return;
    const age = now - ripple.t0;
    const maxDepth = ripple.hits.reduce((m, h) => Math.max(m, h.depth), 0);
    const end = maxDepth * STEP + HOLD;
    const fade = age > end ? Math.max(0, 1 - (age - end) / 700) : 1;
    if (fade <= 0) {
      ripple = null;
      return;
    }
    const src = nodes[ripple.source];
    ctx.globalAlpha = fade;

    // Expanding rings around the changed repo.
    for (let ring = 0; ring < 2; ring++) {
      const p = ((age / 1600 + ring * 0.5) % 1);
      ctx.strokeStyle = `rgba(61, 255, 143, ${0.55 * (1 - p)})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(src.px, src.py, src.r + 4 + p * 46, 0, Math.PI * 2);
      ctx.stroke();
    }

    let lit = 0;
    for (const hit of ripple.hits) {
      const begin = (hit.depth - 1) * STEP;
      const p = Math.min(1, Math.max(0, (age - begin) / STEP));
      if (p <= 0) continue;
      const a = nodes[hit.parent];
      const b = nodes[hit.node];
      const hot = hit.depth === 1 ? DIRECT : INDIRECT;
      ctx.strokeStyle = hot;
      ctx.globalAlpha = fade * 0.75;
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(a.px, a.py);
      ctx.lineTo(a.px + (b.px - a.px) * p, a.py + (b.py - a.py) * p);
      ctx.stroke();
      if (p >= 1) {
        lit++;
        ctx.globalAlpha = fade;
        ctx.fillStyle = hot;
        ctx.shadowColor = hot;
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(b.px, b.py, b.r + 1.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    }

    ctx.globalAlpha = fade;
    ctx.fillStyle = GREEN;
    ctx.shadowColor = GREEN;
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.arc(src.px, src.py, src.r + 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Label: what changed, and how far it has spread so far.
    ctx.font = FONT;
    const label = `~ ${src.name}`;
    const count = `${lit} repo${lit === 1 ? '' : 's'} affected`;
    const w = Math.max(ctx.measureText(label).width, ctx.measureText(count).width) + 20;
    let lx = src.px + 14;
    let ly = src.py - 44;
    if (lx + w > width - 8) lx = src.px - 14 - w;
    if (ly < 8) ly = src.py + 14;
    ctx.fillStyle = 'rgba(5, 11, 8, 0.88)';
    ctx.strokeStyle = 'rgba(61, 255, 143, 0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(lx, ly, w, 40, 6) : ctx.rect(lx, ly, w, 40);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = GREEN;
    ctx.fillText(label, lx + 10, ly + 16);
    ctx.fillStyle = DIRECT;
    ctx.fillText(count, lx + 10, ly + 32);
    ctx.globalAlpha = 1;
  }

  function frame(now) {
    if (!visible) return;
    if (!ripple) ripple = newRipple(now + 400);
    draw(now);
    requestAnimationFrame(frame);
  }

  fetch(new URL('../data/hero.json', document.currentScript ? document.currentScript.src : location.href))
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((hero) => {
      nodes = hero.nodes.map((name, i) => ({ name, i, x: Math.random(), y: Math.random(), phase: Math.random() * Math.PI * 2, r: 1.6 }));
      edges = hero.edges.filter(([a, b]) => nodes[a] && nodes[b]);
      consumers = nodes.map(() => []);
      // Each edge is [user, used]: a ripple runs from the used repo to its users.
      for (const [from, to] of edges) consumers[to].push(from);
      for (const a of nodes) a.r = 1.4 + Math.min(4.5, Math.sqrt(consumers[a.i].length) * 0.75);
      layout();
      resize();
      window.addEventListener('resize', resize);
      if (reduced) {
        // No animation: one ripple, already spread, standing still.
        ripple = newRipple(performance.now() - 8 * STEP);
        draw(performance.now());
        return;
      }
      new IntersectionObserver(([entry]) => {
        const was = visible;
        visible = entry.isIntersecting && !document.hidden;
        if (visible && !was) requestAnimationFrame(frame);
      }).observe(canvas);
      document.addEventListener('visibilitychange', () => {
        const was = visible;
        visible = !document.hidden;
        if (visible && !was) requestAnimationFrame(frame);
      });
      requestAnimationFrame(frame);
    })
    .catch(() => {});
})();
