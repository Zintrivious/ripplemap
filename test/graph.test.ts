import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { drift, findRepo, impact } from '../src/graph.ts';
import { scan } from '../src/scan.ts';

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
      '@acme/utils: ^2.1.0 / ^1.9.0',
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
