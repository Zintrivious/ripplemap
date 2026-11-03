import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scanGitHub, type GitHubScanOptions } from '../src/github.ts';
import { scan } from '../src/scan.ts';
import type { Graph } from '../src/types.ts';

const fixture = fileURLToPath(new URL('./fixtures/acme', import.meta.url));
const API = 'https://api.test';
const RAW = 'https://raw.test';

function filesOf(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join('/'));
}

interface FakeOptions {
  /** Answer /orgs/<owner>/repos with 404, like GitHub does for user accounts. */
  isUser?: boolean;
  rateLimited?: boolean;
  pushedAt?: string;
  /** Repos whose recursive file listing comes back truncated. */
  truncate?: string[];
}

/** A stand-in for the GitHub API and raw.githubusercontent.com, serving test/fixtures/acme as the "acme" org. */
function fakeGitHub(options: FakeOptions = {}) {
  const requests: string[] = [];
  const names = readdirSync(fixture).sort();
  const repos = [
    ...names.map((name) => ({
      name,
      full_name: `acme/${name}`,
      owner: { login: 'acme' },
      default_branch: 'main',
      fork: false,
      archived: false,
      pushed_at: options.pushedAt ?? '2026-11-01T00:00:00Z',
    })),
    { name: 'forked-lib', full_name: 'acme/forked-lib', owner: { login: 'acme' }, default_branch: 'main', fork: true, archived: false },
    { name: 'old-app', full_name: 'acme/old-app', owner: { login: 'acme' }, default_branch: 'main', fork: false, archived: true },
  ];
  const json = (data: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json', ...headers } });

  const fetchFn = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requests.push(url.pathname + url.search);
    if (options.rateLimited) {
      return new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000000' } });
    }

    if (url.origin === API) {
      const list = url.pathname === (options.isUser ? '/users/acme/repos' : '/orgs/acme/repos');
      if (list) {
        // Two pages, to exercise Link-header pagination.
        const page = Number(url.searchParams.get('page') ?? 1);
        const next: Record<string, string> = page === 1 ? { link: `<${API}${url.pathname}?per_page=100&page=2>; rel="next"` } : {};
        return json(page === 1 ? repos.slice(0, 4) : repos.slice(4), next);
      }
      // Trees are addressed by "main" for the repo root and by "dir:<path>" for subfolders.
      const tree = /^\/repos\/acme\/([^/]+)\/git\/trees\/(.+)$/.exec(url.pathname);
      if (tree && names.includes(tree[1]!)) {
        const ref = decodeURIComponent(tree[2]!);
        const sub = ref === 'main' ? '' : ref.replace(/^dir:/, '');
        const dir = join(fixture, tree[1]!, sub);
        const blob = (path: string) => {
          const content = readFileSync(join(dir, path));
          return { path, type: 'blob', size: content.length, sha: createHash('sha1').update(content).digest('hex') };
        };
        if (url.searchParams.get('recursive') === '1') {
          // GitHub truncates recursive listings of huge repos; pretend these repos are huge.
          if (ref === 'main' && options.truncate?.includes(tree[1]!)) return json({ truncated: true, tree: [] });
          return json({ truncated: false, tree: filesOf(dir).map(blob) });
        }
        const entries = readdirSync(dir, { withFileTypes: true }).map((e) =>
          e.isDirectory() ? { path: e.name, type: 'tree', sha: `dir:${sub ? `${sub}/` : ''}${e.name}` } : blob(e.name),
        );
        return json({ truncated: false, tree: entries });
      }
      return new Response('{"message":"Not Found"}', { status: 404 });
    }

    const raw = /^\/acme\/([^/]+)\/refs\/heads\/main\/(.+)$/.exec(url.pathname);
    if (url.origin === RAW && raw) return new Response(readFileSync(join(fixture, raw[1]!, decodeURIComponent(raw[2]!))));
    return new Response('Not Found', { status: 404 });
  }) as typeof fetch;

  return { fetchFn, requests };
}

const cacheDirs: string[] = [];
after(() => cacheDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function run(fake: ReturnType<typeof fakeGitHub>, extra: Partial<GitHubScanOptions> = {}) {
  return scanGitHub({ org: 'acme', token: 'test-token', cacheDir: false, apiUrl: API, rawUrl: RAW, fetch: fake.fetchFn, ...extra });
}

const linkList = (graph: Graph) => graph.links.map((l) => `${l.from} -> ${l.to} ${l.kind} ${l.name}@${l.version} ${l.location.file}:${l.location.line}`).sort();

test('scanning the org through the API gives the same graph as scanning clones', async () => {
  const remote = await run(fakeGitHub());
  const local = scan(fixture, { owner: 'acme' });
  assert.deepEqual(remote.warnings, []);
  assert.deepEqual(remote.graph.repos.map((r) => r.id), local.graph.repos.map((r) => r.id));
  assert.deepEqual(linkList(remote.graph), linkList(local.graph));
});

test('skips forks and archived repos unless asked, and filters with --match', async () => {
  const fake = fakeGitHub();
  const defaults = await run(fake);
  assert.equal(defaults.stats.skipped, 2);
  assert.ok(!fake.requests.some((r) => r.includes('forked-lib') || r.includes('old-app')));

  const everything = await run(fakeGitHub(), { includeForks: true, includeArchived: true });
  assert.equal(everything.stats.repos, 9);
  // Their trees 404 in the fake, which is reported but doesn't stop the scan.
  assert.equal(everything.warnings.length, 2);

  const matched = await run(fakeGitHub(), { match: ['base-*', 'API'] });
  assert.deepEqual(matched.graph.repos.map((r) => r.name), ['api', 'base-images']);
});

test('only downloads files a parser reads, and reuses the cache on the next scan', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'ripplemap-cache-'));
  cacheDirs.push(cacheDir);

  const first = fakeGitHub();
  const cold = await run(first, { cacheDir });
  assert.equal(cold.stats.downloads, cold.filesParsed);
  assert.equal(cold.stats.cacheHits, 0);
  assert.ok(first.requests.every((r) => !r.endsWith('README.md')));

  const second = fakeGitHub();
  const warm = await run(second, { cacheDir });
  assert.equal(warm.stats.downloads, 0);
  assert.equal(warm.stats.cacheHits, cold.stats.downloads);
  assert.deepEqual(linkList(warm.graph), linkList(cold.graph));
  // Nothing was pushed, so only the two repo-list pages are requested.
  assert.equal(warm.stats.apiRequests, 2);

  const pushed = await run(fakeGitHub({ pushedAt: '2026-11-02T00:00:00Z' }), { cacheDir });
  assert.equal(pushed.stats.apiRequests, 2 + pushed.stats.repos);
});

test('falls back to the user endpoint for personal accounts', async () => {
  const result = await run(fakeGitHub({ isUser: true }));
  assert.equal(result.stats.repos, 7);
});

test('explains rate limiting instead of failing with a bare 403', async () => {
  await assert.rejects(run(fakeGitHub({ rateLimited: true })), /rate limit reached/);
  await assert.rejects(run(fakeGitHub({ rateLimited: true }), { token: '' }), /Set GITHUB_TOKEN/);
});

test('lists truncated repos folder by folder instead of scanning part of them', async () => {
  const fake = fakeGitHub({ truncate: ['api', 'base-images'] });
  const result = await run(fake);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(linkList(result.graph), linkList(scan(fixture, { owner: 'acme' }).graph));
  // .github is fetched as its own subtree; nothing else in those repos needed one.
  assert.ok(fake.requests.some((r) => r.startsWith('/repos/acme/api/git/trees/dir%3A.github')));
});

test('records files it could not download as warnings in the graph', async () => {
  const fake = fakeGitHub();
  const flaky = (async (input: string | URL | Request) =>
    String(input).endsWith('/api/refs/heads/main/Dockerfile') ? new Response('boom', { status: 500 }) : fake.fetchFn(input)) as typeof fetch;
  const result = await run(fake, { fetch: flaky });
  assert.equal(result.graph.warnings?.length, 1);
  assert.match(result.graph.warnings![0]!.message, /500/);
  assert.equal(result.graph.warnings![0]!.file, 'Dockerfile');
});

test('a repo that fails for any reason becomes a warning; the rest of the org is still scanned', async () => {
  const fake = fakeGitHub();
  const broken = (async (input: string | URL | Request) =>
    String(input).includes('/repos/acme/web/git/trees') ? Promise.reject(new TypeError('socket hang up')) : fake.fetchFn(input)) as typeof fetch;
  const result = await run(fake, { fetch: broken });
  assert.equal(result.graph.repos.length, 7);
  assert.deepEqual(result.graph.warnings?.map((w) => `${w.repo}: ${w.message}`), ['acme/web: socket hang up']);
});
