import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { changeImpact, isIgnoredChange } from '../src/changes.ts';
import { COMMENT_MARKER, formatChangeMarkdown } from '../src/markdown.ts';
import { scan } from '../src/scan.ts';

const fixture = fileURLToPath(new URL('./fixtures/acme', import.meta.url));
const { graph } = scan(fixture, { owner: 'acme' });
graph.source = 'github.com/acme';

test('docs, tests and examples are ignored, but requirements files are not', () => {
  for (const f of ['README.md', 'docs/setup.md', 'test/vpc_test.go', 'src/a.test.ts', 'examples/complete/main.tf', 'LICENSE', '.github/ISSUE_TEMPLATE/bug.yml']) {
    assert.ok(isIgnoredChange(f), f);
  }
  for (const f of ['main.tf', 'Dockerfile', 'src/index.ts', 'requirements.txt', '.github/workflows/build.yml']) {
    assert.ok(!isIgnoredChange(f), f);
  }
});

test('a module change affects only that module’s users', () => {
  const impact = changeImpact(graph, 'acme/infra-modules', ['vpc/main.tf', 'README.md']);
  assert.deepEqual(impact.direct, ['acme/api', 'acme/web']);
  assert.deepEqual(impact.indirect, []);
  assert.deepEqual(impact.ignored, ['README.md']);
  assert.deepEqual(impact.artifacts.map((a) => `${a.name}: ${a.files.join(',')}`), ['github.com/acme/infra-modules//vpc: vpc/main.tf']);
  // Nothing outside vpc/ is used by anyone.
  assert.deepEqual(changeImpact(graph, 'acme/infra-modules', ['rds/main.tf']).direct, []);
});

test('a base image change reaches images built on images built on it', () => {
  const impact = changeImpact(graph, 'acme/base-images', ['Dockerfile']);
  assert.deepEqual(impact.direct, ['acme/api', 'acme/web']);
  assert.deepEqual(impact.indirect, [{ repo: 'acme/frontend', depth: 2, via: 'acme/api', kind: 'image' }]);
});

test('indirect impact only follows the same kind of dependency', () => {
  // api uses the vpc module and frontend runs api's image, but a VPC change doesn't change that image.
  assert.deepEqual(changeImpact(graph, 'acme/infra-modules', ['vpc/main.tf']).indirect, []);
  assert.deepEqual(changeImpact(graph, 'acme/utils', ['index.js']).indirect, []);
});

test('a workflow change affects only callers of that workflow', () => {
  const touched = changeImpact(graph, 'acme/ci', ['.github/workflows/build.yml']);
  assert.deepEqual(touched.direct, ['acme/api', 'acme/web']);
  const other = changeImpact(graph, 'acme/ci', ['.github/workflows/lint.yml']);
  assert.deepEqual(other.direct, []);
  assert.deepEqual(other.untouched, [{ kind: 'workflow', name: 'acme/ci/.github/workflows/build.yml', consumers: 2 }]);
});

test('consumers that pin nothing are flagged as picking the change up on merge', () => {
  const impact = changeImpact(graph, 'acme/api', ['server.js']);
  const consumer = impact.artifacts.find((a) => a.kind === 'image')?.consumers[0];
  assert.equal(consumer?.repo, 'acme/frontend');
  assert.equal(consumer?.unpinned, true);
});

test('a repo outside the scan is reported as such', () => {
  const impact = changeImpact(graph, 'acme/not-scanned', ['main.tf']);
  assert.equal(impact.scanned, false);
  assert.match(formatChangeMarkdown(graph, impact, { version: '0.0.0' }), /wasn't part of the scan of github\.com\/acme/);
});

test('the pull request comment', () => {
  const withUrls = structuredClone(graph);
  for (const r of withUrls.repos) r.url = `https://github.com/${r.id}`;
  const md = formatChangeMarkdown(withUrls, changeImpact(withUrls, 'acme/api', ['server.js']), { version: '0.5.0' });
  assert.ok(md.startsWith(`${COMMENT_MARKER}\n### ripplemap: this pull request may affect 1 repo\n`));
  assert.match(md, /\*\*1 repo pins no version and will pick this up as soon as it merges\.\*\*/);
  assert.match(md, /\| \[frontend\]\(https:\/\/github\.com\/acme\/frontend\) \| `latest` \*\*on merge\*\* \| \[docker-compose\.yml:3\]\(https:\/\/github\.com\/acme\/frontend\/blob\/HEAD\/docker-compose\.yml#L3\) \|/);
  assert.match(md, /ripplemap\]\(https:\/\/github\.com\/Zintrivious\/ripplemap\) 0\.5\.0/);

  const docsOnly = formatChangeMarkdown(withUrls, changeImpact(withUrls, 'acme/api', ['README.md']), { version: '0.5.0' });
  assert.match(docsOnly, /### ripplemap: no other repos are affected\n\nThis pull request only changes docs, tests or examples/);
});

test('an incomplete scan is called out in the comment', () => {
  const incomplete = { ...graph, warnings: [{ repo: 'acme/web', file: 'Dockerfile', message: 'could not read' }] };
  assert.match(formatChangeMarkdown(incomplete, changeImpact(incomplete, 'acme/api', ['server.js']), { version: '0.5.0' }), /> \[!WARNING\]\n> Incomplete scan/);
});
