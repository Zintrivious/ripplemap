import { readFileSync } from 'node:fs';
import { reportData } from './report-data.ts';
import type { Graph } from './types.ts';

export { reportData } from './report-data.ts';

/** The page's CSS and JS live in /assets so they stay plain files, readable from both src/ and dist/. */
const asset = (name: string) => readFileSync(new URL(`../assets/${name}`, import.meta.url), 'utf8');

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/** The page's markup without its data and script. The website's map page uses it too. */
export function reportMarkup(source: string, problems: number): string {
  return `<header class="top">
  <div class="brand"><a class="home" href="https://github.com/Zintrivious/ripplemap" target="_blank" rel="noopener" title="Made with ripplemap"><span class="logo" aria-hidden="true"></span>ripplemap</a><span class="source">${escapeHtml(source)}</span></div>
  <nav class="tabs" role="tablist">
    <button role="tab" data-tab="impact" aria-selected="true">Impact</button>
    <button role="tab" data-tab="drift" aria-selected="false">Drift <span class="count" id="drift-count"></span></button>
  </nav>
  <div class="stats" id="stats"></div>
</header>
${
  problems
    ? `<div class="notice" role="status"><b>Incomplete scan.</b> ${problems} ${problems === 1 ? 'file or repo' : 'files or repos'} could not be read or parsed, so some dependencies may be missing. Run <code>ripplemap scan --verbose</code> to see which.</div>`
    : ''
}
<main>
  <section id="tab-impact" class="tab impact">
    <div class="graph-wrap">
      <svg id="graph" role="img" aria-label="Dependency graph"><g id="viewport"><g id="edges"></g><g id="nodes"></g><g id="labels"></g></g></svg>
      <div class="graph-tools">
        <div class="kinds" id="kinds"></div>
        <button id="fit" title="Fit to screen">Fit</button>
      </div>
      <div class="legend">
        <span><i class="dot selected"></i>selected</span>
        <span><i class="dot direct"></i>affected directly</span>
        <span><i class="dot indirect"></i>affected indirectly</span>
        <span><i class="dot dependency"></i>it depends on</span>
      </div>
      <div class="tooltip" id="tooltip" hidden></div>
    </div>
    <aside class="panel">
      <label class="search"><input id="search" type="search" placeholder="Find a repo…" list="repo-names" autocomplete="off"><datalist id="repo-names"></datalist></label>
      <div id="details"></div>
    </aside>
  </section>
  <section id="tab-drift" class="tab drift" hidden>
    <div class="drift-head">
      <p>Shared modules, images, workflows and packages used at more than one version.</p>
      <label class="toggle"><input type="checkbox" id="third-party"> Include third-party</label>
    </div>
    <div id="drift-list"></div>
  </section>
</main>`;
}

/** A single self-contained HTML file: no network requests, safe to attach or open offline. */
export function renderReport(graph: Graph): string {
  const data = reportData(graph);
  // "<" is escaped so no value can close the <script> tag early.
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const title = data.source ? `ripplemap · ${data.source}` : 'ripplemap';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${asset('report.css')}
</style>
</head>
<body>
${reportMarkup(data.source, data.problems)}
<script type="application/json" id="ripplemap-data">${json}</script>
<script>
${asset('report.js')}
</script>
</body>
</html>
`;
}
