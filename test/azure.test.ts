import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scanAzure } from '../src/azure.ts';
import { unpinned } from '../src/graph.ts';
import { pipelinesParser } from '../src/parsers/pipelines.ts';
import { parseModuleSource, parseRepoUrl } from '../src/refs.ts';
import { scan } from '../src/scan.ts';
import type { Graph } from '../src/types.ts';
import { fileUrl } from '../src/util.ts';

const fixture = fileURLToPath(new URL('./fixtures/contoso', import.meta.url));
const BASE = 'https://ado.test/contoso';

test('every way of writing an Azure DevOps repo URL resolves to the same repo', () => {
  const expected = { host: 'dev.azure.com', owner: 'contoso/platform', name: 'terraform-modules' };
  for (const url of [
    'https://dev.azure.com/contoso/Platform/_git/terraform-modules',
    'https://contoso@dev.azure.com/contoso/Platform/_git/terraform-modules',
    'git@ssh.dev.azure.com:v3/contoso/Platform/terraform-modules',
    'ssh://git@ssh.dev.azure.com/v3/contoso/Platform/terraform-modules',
    'https://contoso.visualstudio.com/Platform/_git/terraform-modules',
    'https://contoso.visualstudio.com/DefaultCollection/Platform/_git/terraform-modules',
    'contoso@vs-ssh.visualstudio.com:v3/contoso/Platform/terraform-modules',
  ]) {
    assert.deepEqual(parseRepoUrl(url), expected, url);
  }
  assert.deepEqual(parseRepoUrl('https://dev.azure.com/contoso/My%20Project/_git/Infra%20Modules'), { host: 'dev.azure.com', owner: 'contoso/my project', name: 'infra modules' });
  const https = parseModuleSource('git::https://dev.azure.com/contoso/Platform/_git/terraform-modules//vpc?ref=v1.2.0');
  const ssh = parseModuleSource('git::git@ssh.dev.azure.com:v3/contoso/Platform/terraform-modules//vpc?ref=v1.1.0');
  assert.equal(https?.name, ssh?.name);
  assert.equal(https?.repoHint, 'contoso/platform/terraform-modules');
});

test('file links use each host’s URL style', () => {
  assert.equal(fileUrl('https://github.com/acme/api', 'main.tf', 3), 'https://github.com/acme/api/blob/HEAD/main.tf#L3');
  assert.equal(fileUrl('https://gitlab.com/acme/api', 'main.tf', 3), 'https://gitlab.com/acme/api/-/blob/HEAD/main.tf#L3');
  assert.match(fileUrl('https://dev.azure.com/contoso/Platform/_git/api', 'infra/main.tf', 3), /_git\/api\?path=\/infra\/main\.tf&line=3&lineEnd=3/);
});

test('pipelines: templates from other repos, by alias, with project defaults and refs', () => {
  const repo = { id: 'contoso/platform/api', owner: 'contoso/platform', name: 'api', path: 'api' };
  const content = readFileSync(join(fixture, 'api/.azure-pipelines/ci.yml'), 'utf8');
  const { uses } = pipelinesParser.parse({ repo, file: '.azure-pipelines/ci.yml', content });
  assert.deepEqual(
    uses.map((u) => `${u.kind} ${u.name} ${u.version} ${u.repoHint ?? ''} L${u.location.line}`),
    [
      'image contoso.azurecr.io/builder 4  L16',
      'pipeline contoso/platform/pipeline-templates//templates/build.yml v2.1.0 contoso/platform/pipeline-templates L23',
    ],
  );
  // Not a pipeline with repository resources: nothing to do, and no parse attempt.
  assert.deepEqual(pipelinesParser.parse({ repo, file: 'k8s/app.yaml', content: 'apiVersion: v1\nkind: Pod\n' }).uses, []);
  assert.ok(!pipelinesParser.matches('.github/workflows/ci.yml'));
});

const links = (graph: Graph) => graph.links.map((l) => `${l.from} -> ${l.to} ${l.kind} ${l.version}`).sort();

test('a cloned Azure DevOps org links Terraform modules (HTTPS and SSH sources) and pipeline templates', () => {
  const { graph, warnings } = scan(fixture, { owner: 'contoso/platform' });
  assert.deepEqual(warnings, []);
  assert.deepEqual(links(graph), [
    'contoso/platform/api -> contoso/platform/pipeline-templates pipeline v2.1.0',
    'contoso/platform/api -> contoso/platform/terraform-modules terraform-module v1.2.0',
    'contoso/platform/web -> contoso/platform/pipeline-templates pipeline default branch',
    'contoso/platform/web -> contoso/platform/terraform-modules terraform-module v1.1.0',
  ]);
  // web pulls the template from the default branch, so it picks up every change.
  assert.deepEqual(unpinned(graph).map((e) => e.usages.map((u) => u.repo)), [['contoso/platform/web']]);
});

/** A stand-in for the Azure DevOps REST API, serving test/fixtures/contoso as project "Platform". */
function fakeAzure() {
  const requests: string[] = [];
  const names = readdirSync(fixture).sort();
  const files = (repo: string) =>
    readdirSync(join(fixture, repo), { withFileTypes: true, recursive: true })
      .filter((e) => e.isFile())
      .map((e) => relative(join(fixture, repo), join(e.parentPath, e.name)).split(sep).join('/'));
  const sha = (repo: string, path: string) => createHash('sha1').update(readFileSync(join(fixture, repo, path))).digest('hex');
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8' } });

  const fetchFn = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requests.push(url.pathname + url.search);
    const path = decodeURIComponent(url.pathname);
    if (path === '/contoso/_apis/projects') return json({ value: [{ name: 'Platform' }] });
    if (path === '/contoso/Platform/_apis/git/repositories') {
      return json({
        value: [
          ...names.map((name) => ({ id: `id-${name}`, name, project: { name: 'Platform' }, defaultBranch: 'refs/heads/main', webUrl: `https://dev.azure.com/contoso/Platform/_git/${name}` })),
          { id: 'id-old', name: 'old', project: { name: 'Platform' }, isDisabled: true, webUrl: '' },
          { id: 'id-empty', name: 'empty', project: { name: 'Platform' }, webUrl: '' },
        ],
      });
    }
    const m = /^\/contoso\/Platform\/_apis\/git\/repositories\/id-([^/]+)\/(refs|items|blobs\/(\w+))$/.exec(path);
    if (m && names.includes(m[1]!)) {
      const repo = m[1]!;
      if (m[2] === 'refs') return json({ value: [{ objectId: `commit-${repo}` }] });
      if (m[2] === 'items') return json({ value: files(repo).map((f) => ({ objectId: sha(repo, f), gitObjectType: 'blob', path: `/${f}` })) });
      const file = files(repo).find((f) => sha(repo, f) === m[3]);
      if (file) return new Response(readFileSync(join(fixture, repo, file)), { headers: { 'content-type': 'text/plain' } });
    }
    return new Response('{"message":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetchFn, requests };
}

test('scan --azure-org gives the same graph as scanning clones, and skips disabled and empty repos', async () => {
  const fake = fakeAzure();
  const result = await scanAzure({ org: 'contoso', baseUrl: BASE, token: 'pat', fetch: fake.fetchFn, cacheDir: false });
  assert.deepEqual(result.warnings, []);
  assert.equal(result.stats.skipped, 1);
  assert.deepEqual(result.graph.repos.map((r) => r.id), ['contoso/platform/api', 'contoso/platform/pipeline-templates', 'contoso/platform/terraform-modules', 'contoso/platform/web', 'contoso/platform/empty'].sort());
  assert.deepEqual(links(result.graph), links(scan(fixture, { owner: 'contoso/platform' }).graph));
  assert.ok(fake.requests.every((r) => r.includes('api-version=7.1')));
});

test('scan --azure-org explains sign-in instead of failing on an HTML page', async () => {
  const signIn = (async () => new Response('<html>sign in</html>', { status: 203, headers: { 'content-type': 'text/html' } })) as typeof fetch;
  await assert.rejects(scanAzure({ org: 'contoso', baseUrl: BASE, fetch: signIn, cacheDir: false }), /wants you to sign in.*AZURE_DEVOPS_TOKEN/);
});

test('pipelines: leaves Kubernetes manifests and Helm templates alone, without warnings', () => {
  const repo = { id: 'contoso/platform/api', owner: 'contoso/platform', name: 'api', path: 'api' };
  const deployment = [
    'apiVersion: apps/v1',
    'kind: Deployment',
    'spec:',
    '  template:',
    '    spec:',
    '      containers:',
    '        - name: app',
    '          image: ghcr.io/acme/app:1',
    '          resources:',
    '            limits: { cpu: 1 }',
    '---',
    'apiVersion: v1',
    'kind: Service',
  ].join('\n');
  const helm = 'spec:\n  containers:\n    - name: app\n      resources:\n{{ toYaml .Values.resources | indent 12 }}\n';
  for (const content of [deployment, helm]) {
    const result = pipelinesParser.parse({ repo, file: 'deploy/app.yaml', content });
    assert.deepEqual(result.uses, []);
  }
});
