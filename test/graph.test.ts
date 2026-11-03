import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildLinks, drift, findRepo, imageRelease, impact, isUnpinned, npmRelease, unpinned } from '../src/graph.ts';
import { scan, scanRepos } from '../src/scan.ts';

const fixture = fileURLToPath(new URL('./fixtures/acme', import.meta.url));
const { graph, warnings } = scan(fixture, { owner: 'acme' });

const edges = (from?: string) =>
  graph.links
    .filter((l) => !from || l.from === from)
    .map((l) => `${l.from} -> ${l.to} (${l.kind}, ${l.confidence})`)
    .sort();

test('scan finds every repo and parses without warnings', () => {
  assert.deepEqual(warnings, []);
  assert.deepEqual(
    graph.repos.map((r) => r.id),
    ['acme/api', 'acme/base-images', 'acme/ci', 'acme/frontend', 'acme/infra-modules', 'acme/utils', 'acme/web'],
  );
});

test('links each reference to the repo that produces it', () => {
  assert.deepEqual(edges('acme/api'), [
    'acme/api -> acme/base-images (image, declared)',
    'acme/api -> acme/ci (workflow, exact)',
    'acme/api -> acme/infra-modules (terraform-module, exact)',
    'acme/api -> acme/utils (npm, declared)',
  ]);
  assert.deepEqual(edges('acme/frontend'), ['acme/frontend -> acme/api (image, declared)']);
  // Third-party references (node, postgres, actions/checkout, cloudposse/label/null) never become links.
  assert.equal(graph.links.length, 9);
});

test('impact follows dependencies transitively', () => {
  const entries = impact(graph, 'acme/base-images');
  assert.deepEqual(
    entries.map((e) => `${e.repo} depth=${e.depth} via=${e.parent}`),
    ['acme/api depth=1 via=acme/base-images', 'acme/web depth=1 via=acme/base-images', 'acme/frontend depth=2 via=acme/api'],
  );
  assert.deepEqual(impact(graph, 'acme/frontend'), []);
});

test('drift reports shared artifacts used at several versions', () => {
  const entries = drift(graph);
  assert.deepEqual(
    entries.map((e) => `${e.name}: ${e.versions.map((v) => v.version).join(' / ')}`),
    [
      '@acme/utils: 2.x / 1.x',
      'acme/ci/.github/workflows/build.yml: v2 / v1',
      'ghcr.io/acme/base: 1.4 / 1.2',
      'github.com/acme/infra-modules//vpc: v1.3.0 / v1.1.0',
      'actions/checkout: v4 / v3',
    ],
  );
  assert.equal(drift(graph, { internalOnly: true }).length, 4);
  assert.deepEqual(drift(graph, { kinds: ['image'] }).map((e) => e.name), ['ghcr.io/acme/base']);
});

test('findRepo accepts short names and explains unknown ones', () => {
  assert.equal(findRepo(graph, 'api').id, 'acme/api');
  assert.equal(findRepo(graph, 'ACME/Web').id, 'acme/web');
  assert.throws(() => findRepo(graph, 'base'), /Did you mean: acme\/base-images/);
});

test('scan --exclude skips folder names and path prefixes', () => {
  const { graph: excluded } = scan(fixture, { owner: 'acme', exclude: ['infra', '.github/workflows'] });
  assert.ok(!excluded.usages.some((u) => u.location.file.startsWith('infra/') || u.location.file.startsWith('.github/workflows/')));
  assert.ok(excluded.usages.some((u) => u.location.file === 'main.tf'));
});

test('repos without an owner still link by name', () => {
  const { graph: unowned } = scan(fixture);
  assert.equal(unowned.repos[0]?.id, 'api');
  assert.ok(unowned.links.some((l) => l.from === 'web' && l.to === 'ci' && l.kind === 'workflow'));
});

test('a file that cannot be read becomes a warning instead of stopping the scan', () => {
  const repo = { id: 'acme/broken', owner: 'acme', name: 'broken', path: 'broken' };
  const result = scanRepos([
    {
      repo,
      files: [
        { path: 'Dockerfile', read: () => { throw new Error('EACCES: permission denied'); } },
        { path: 'compose.yml', read: () => 'services:\n  app:\n    image: ghcr.io/acme/api:1\n' },
      ],
    },
  ]);
  assert.equal(result.graph.warnings?.length, 1);
  assert.match(result.graph.warnings![0]!.message, /could not read: EACCES/);
  assert.equal(result.graph.usages.length, 1);
});

test('new parsers link across repos: Go modules, Python packages, Helm charts, Kubernetes and Helm images', () => {
  const platform = fileURLToPath(new URL('./fixtures/platform', import.meta.url));
  const { graph: g, warnings: w } = scan(platform, { owner: 'acme' });
  assert.deepEqual(w, []);
  assert.deepEqual(
    g.links.map((l) => `${l.from} -> ${l.to} (${l.kind}, ${l.confidence})`).sort(),
    [
      'acme/billing -> acme/go-utils (go, exact)',
      'acme/billing -> acme/migrator (image, convention)',
      'acme/reports -> acme/helm-charts (helm-chart, declared)',
      'acme/reports -> acme/migrator (image, convention)',
      'acme/reports -> acme/py-common (python, declared)',
    ],
  );
  assert.deepEqual(
    impact(g, 'acme/migrator').map((e) => e.repo),
    ['acme/billing', 'acme/reports'],
  );
  assert.deepEqual(
    drift(g, { internalOnly: true }).map((e) => `${e.name}: ${e.versions.map((v) => v.version).join(' / ')}`),
    ['ghcr.io/acme/migrator: 3.1 / 3'],
  );
});

test('unpinned lists floating references to things built in the scanned repos', () => {
  const entries = unpinned(graph);
  assert.deepEqual(
    entries.map((e) => `${e.name} ${e.usages.map((u) => `${u.repo}@${u.version}`).join(',')}`),
    ['ghcr.io/acme/api acme/frontend@latest'],
  );
  // With --all, third-party ones too (postgres:16 is pinned, so it stays out).
  const all = unpinned(graph, { all: true }).map((e) => e.name);
  assert.ok(all.includes('ghcr.io/acme/api'));
  assert.ok(!all.includes('postgres'));
  assert.ok(isUnpinned('main') && isUnpinned('default branch') && !isUnpinned('v1') && !isUnpinned('^2.1.0'));
});

test('images link to repos named docker-<image> or <image>-docker', () => {
  const repos = ['docker-baseimage-alpine', 'nginx-docker', 'app'].map((name) => ({ id: `lsio/${name}`, owner: 'lsio', name, path: name }));
  const use = (name: string) => ({ repo: 'lsio/app', kind: 'image' as const, name, version: '3.20', location: { file: 'Dockerfile', line: 1 } });
  const links = buildLinks(repos, [use('ghcr.io/lsio/baseimage-alpine'), use('ghcr.io/lsio/nginx'), use('ghcr.io/lsio/unknown')], []);
  assert.deepEqual(links.map((l) => `${l.to} ${l.confidence}`), ['lsio/docker-baseimage-alpine convention', 'lsio/nginx-docker convention']);
});

test('drift treats per-architecture image tags as one release', () => {
  assert.equal(imageRelease('arm64v8-3.24'), '3.24');
  assert.equal(imageRelease('3.24-amd64'), '3.24');
  assert.equal(imageRelease('amd64'), 'amd64');
  assert.equal(imageRelease('debiantrixie'), 'debiantrixie');
});

test('drift treats npm ranges that install the same releases as one version', () => {
  assert.equal(npmRelease('^9.6.0'), '9.x');
  assert.equal(npmRelease('^9.6.1'), '9.x');
  assert.equal(npmRelease('~1.4.2'), '1.4.x');
  assert.equal(npmRelease('^0.5.1'), '0.5.x');
  assert.equal(npmRelease('9.6.0'), '9.6.0');
  assert.equal(npmRelease('>=2 <3'), '>=2 <3');
  assert.equal(npmRelease('workspace:*'), 'workspace:*');
});
