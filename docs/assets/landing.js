// Landing page: the scan box and the suggested orgs.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);

  /** "acme", "github.com/acme", "https://github.com/acme/api.git", "acme/api" → { org, repo }. */
  function parseTarget(text) {
    const path = text
      .trim()
      .replace(/^git@github\.com:/i, '')
      .replace(/^(https?:\/\/)?(www\.)?github\.com\//i, '')
      .replace(/^@/, '')
      .replace(/[?#].*$/, '')
      .replace(/\.git$/i, '')
      .replace(/\/+$/, '');
    const [owner, repo] = path.split('/').filter(Boolean);
    if (!owner || !/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/i.test(owner)) return null;
    return { org: owner.toLowerCase(), repo: repo && /^[\w.-]+$/.test(repo) ? `${owner}/${repo}`.toLowerCase() : null };
  }

  const mapUrl = (org, repo) => `map/?org=${encodeURIComponent(org)}${repo ? `#repo=${encodeURIComponent(repo)}` : ''}`;

  const form = $('scan-form');
  const input = $('target');
  const hint = $('hint');
  const hintText = hint.innerHTML;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const target = parseTarget(input.value);
    if (!target) {
      hint.innerHTML = '<span class="err">That doesn\'t look like a GitHub org or repo.</span> Try <code>your-org</code> or <code>github.com/owner/repo</code>.';
      input.focus();
      return;
    }
    location.href = mapUrl(target.org, target.repo);
  });
  input.addEventListener('input', () => (hint.innerHTML = hintText));
  if (matchMedia('(max-width: 640px)').matches) input.placeholder = 'org or repo URL';
  for (const button of document.querySelectorAll('.examples button')) {
    button.addEventListener('click', () => {
      input.value = button.dataset.target;
      form.requestSubmit();
    });
  }

  // Suggested orgs, from data/index.json (written weekly by scripts/demos.ts).
  const KIND = { image: 'docker', 'terraform-module': 'terraform', workflow: 'workflows', action: 'actions', npm: 'npm', 'helm-chart': 'helm', go: 'go', python: 'python', pipeline: 'azure pipelines' };
  const n = (x) => x.toLocaleString('en-US');

  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, value);
    for (const child of children.flat()) if (child != null && child !== false) node.append(child);
    return node;
  }

  function card(entry) {
    const short = entry.top ? entry.top.repo.split('/')[1] : '';
    return h(
      'a',
      { class: 'org', href: mapUrl(entry.org, entry.top && entry.top.repo) },
      h('div', { class: 'org-head' }, h('span', { class: 'org-name' }, entry.org), h('span', { class: 'org-size' }, `${n(entry.repos)} repos · ${n(entry.links)} links`)),
      h('p', { class: 'org-about' }, entry.about),
      entry.top && entry.top.affected
        ? h(
            'div',
            { class: 'org-hit' },
            h('span', { class: 'cmd' }, '$ ripplemap impact ', h('b', {}, short)),
            h('span', { class: 'big' }, n(entry.top.affected), ' ', h('span', {}, `repos affected · ${n(entry.top.direct)} directly`)),
          )
        : null,
      h('div', { class: 'tags' }, entry.kinds.map((k) => h('span', { class: 'tag' }, KIND[k] || k))),
      h('span', { class: 'go' }, 'open map ▸'),
    );
  }

  fetch('data/index.json')
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((index) => $('orgs').replaceChildren(...index.orgs.map(card)))
    .catch(() => {
      $('orgs').replaceChildren(h('p', { class: 'loading' }, 'Couldn\'t load the suggested orgs. Type one above instead.'));
    });
})();
