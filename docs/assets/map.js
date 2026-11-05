// Map page: opens a pre-scanned org from data/, or scans any public org live in the browser,
// then hands the result to the same report script the CLI's `ripplemap report` uses.
import { RateLimitError, scanOrg } from './scanner.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const org = (params.get('org') || '').trim().toLowerCase();
const match = params.getAll('match').filter(Boolean);
const forceLive = params.has('live');
const TOKEN_KEY = 'ripplemap-token';

const store = {
  get(key) {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      if (value === null) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, value);
    } catch {
      // Private windows and full storage: the page works without it.
    }
  },
};

if (!/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/.test(org)) location.replace('../');

const command = `ripplemap scan --org ${org}${match.map((m) => ` --match '${m}'`).join('')}`;
document.title = `ripplemap · ${org}`;

// ---------------------------------------------------------------------------
// The terminal-style scan screen

const log = $('log');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function line(html, cls = '') {
  const el = document.createElement('div');
  if (cls) el.className = cls;
  el.innerHTML = html;
  log.querySelector('.cursor')?.remove();
  log.append(el);
  return el;
}
const cursor = () => log.lastElementChild?.insertAdjacentHTML('beforeend', ' <span class="cursor"></span>');
const bar = (done, total, width = 24) => {
  const filled = total ? Math.round((done / total) * width) : 0;
  return `<span class="bar">[${'█'.repeat(filled)}${'░'.repeat(width - filled)}]</span>`;
};

line(`<span class="ok">$</span> ${esc(command)}`);

class NeedsToken extends Error {}

function askForToken(message) {
  const box = $('token');
  box.hidden = false;
  $('token-why').innerHTML = message;
  const input = $('token-input');
  input.value = '';
  input.focus();
  return new Promise((resolve) => {
    $('token-form').onsubmit = (event) => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value) return;
      box.hidden = true;
      store.set(TOKEN_KEY, value);
      resolve(value);
    };
  });
}

async function liveScan() {
  let token = store.get(TOKEN_KEY) || '';
  for (;;) {
    const started = performance.now();
    line(token ? 'listing public repos (with your token)…' : 'listing public repos…');
    cursor();
    let progress;
    try {
      const result = await scanOrg({
        org,
        token,
        match,
        onListed({ repos, rateRemaining, authenticated }) {
          line(`<span class="ok">✓</span> found ${repos} public repo${repos === 1 ? '' : 's'}`);
          // Each repo costs one API request for its file list; file contents don't count.
          if (!authenticated && rateRemaining !== undefined && repos + 1 > rateRemaining) {
            throw new NeedsToken(
              rateRemaining === 0
                ? `You've used the <b>60 requests an hour</b> GitHub gives a browser without a token.`
                : `<b>${esc(org)}</b> has ${repos} public repos, so the scan needs about ${repos} GitHub API requests. Without a token, GitHub lets your browser make <b>${rateRemaining} more</b> this hour.`,
            );
          }
          if (repos) progress = line(`reading files ${bar(0, repos)} 0/${repos}`);
        },
        onProgress(done, total) {
          if (progress) progress.innerHTML = `reading files ${bar(done, total)} ${done}/${total}`;
        },
      });
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      const { data, stats } = result;
      line(`<span class="ok">✓</span> ${data.repos.length} repos · ${data.links.length} cross-repo links · ${stats.downloads + stats.cacheHits} files in ${seconds}s`);
      if (data.problems) line(`<span class="warn">!</span> ${data.problems} file${data.problems === 1 ? '' : 's'} or repos couldn't be read`, 'warn');
      return data;
    } catch (error) {
      if (error instanceof NeedsToken || error instanceof RateLimitError) {
        if (token && error instanceof RateLimitError) store.set(TOKEN_KEY, null);
        line(`<span class="warn">!</span> needs a GitHub token to go on`, 'warn');
        // The scanner's own rate-limit message is written for the CLI (GITHUB_TOKEN, gh auth login).
        const reset = /resets at ([^.]+)\./.exec(error.message)?.[1];
        const message =
          error instanceof NeedsToken
            ? error.message
            : token
              ? `GitHub's rate limit for this token was reached${reset ? `. It resets at <b>${esc(reset)}</b>` : ''}.`
              : `You've used the <b>60 requests an hour</b> GitHub gives a browser without a token${reset ? `. They reset at <b>${esc(reset)}</b>` : ''}.`;
        token = await askForToken(message);
        continue;
      }
      const message = /401|Bad credentials/.test(error.message) ? 'GitHub rejected the token. Check it and try again.' : error.message;
      if (/401|Bad credentials/.test(error.message)) store.set(TOKEN_KEY, null);
      line(`<span class="bad">✗ ${esc(message)}</span>`, 'bad');
      line(`<a href="../">← try another org</a>`);
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Showing the report

function show(data, prescanned) {
  $('scan').remove();
  $('report-shell').replaceWith($('report-shell').content);
  const home = document.querySelector('.brand .home');
  home.href = '../';
  home.removeAttribute('target');
  home.title = 'ripplemap home';

  const source = document.querySelector('.brand .source');
  source.textContent = `github.com/${org}`;
  const mode = document.createElement('span');
  mode.className = 'mode';
  if (prescanned) {
    const when = new Date(prescanned.scannedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    mode.innerHTML = `pre-scanned ${esc(when)} · <a href="?org=${encodeURIComponent(org)}&live${location.hash}">rescan live</a>`;
  } else {
    mode.textContent = 'scanned in your browser';
  }
  source.append(mode);

  if (data.problems) {
    const notice = document.createElement('div');
    notice.className = 'notice-web';
    notice.innerHTML = `<b>Incomplete scan.</b> ${data.problems} ${data.problems === 1 ? 'file or repo' : 'files or repos'} couldn't be read or parsed, so some dependencies may be missing. <code>npx ${esc(command)} --verbose</code> lists them.`;
    document.querySelector('header.top').after(notice);
  }

  const script = document.createElement('script');
  script.type = 'application/json';
  script.id = 'ripplemap-data';
  // Not innerHTML: textContent can't close the tag early, whatever the data holds.
  script.textContent = JSON.stringify(data);
  document.body.append(script);
  const report = document.createElement('script');
  report.src = '../assets/report.js';
  document.body.append(report);
}

async function main() {
  if (!forceLive && !match.length) {
    const index = await fetch('../data/index.json')
      .then((r) => (r.ok ? r.json() : { orgs: [] }))
      .catch(() => ({ orgs: [] }));
    const entry = index.orgs.find((o) => o.org === org);
    if (entry) {
      line('loading pre-scanned results…');
      const data = await fetch(`../data/${org}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (data) return show(data, entry);
    }
  }
  const cacheKey = `ripplemap-scan:${org}:${match.join(',')}`;
  const cached = !forceLive && store.get(cacheKey);
  if (cached) {
    try {
      return show(JSON.parse(cached), null);
    } catch {
      store.set(cacheKey, null);
    }
  }
  const data = await liveScan();
  if (!data) return;
  store.set(cacheKey, JSON.stringify(data));
  // A beat so the last line can be read before the map replaces it.
  setTimeout(() => show(data, null), 450);
}

$('forget-token').addEventListener('click', (event) => {
  event.preventDefault();
  store.set(TOKEN_KEY, null);
  $('token-input').value = '';
});

main();
