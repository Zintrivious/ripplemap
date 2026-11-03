import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actionsParser } from '../src/parsers/actions.ts';
import { composeParser } from '../src/parsers/compose.ts';
import { dockerfileParser } from '../src/parsers/dockerfile.ts';
import { goModParser } from '../src/parsers/gomod.ts';
import { helmParser } from '../src/parsers/helm.ts';
import { kubernetesParser } from '../src/parsers/kubernetes.ts';
import { npmParser } from '../src/parsers/npm.ts';
import { pythonParser } from '../src/parsers/python.ts';
import { terraformParser } from '../src/parsers/terraform.ts';
import type { Parser, RepoInfo } from '../src/types.ts';

const repo: RepoInfo = { id: 'acme/api', owner: 'acme', name: 'api', path: 'api' };
const run = (parser: Parser, file: string, content: string) => parser.parse({ repo, file, content });
const brief = (uses: { name: string; version: string; location: { line: number } }[]) =>
  uses.map((u) => `${u.name} ${u.version} L${u.location.line}`);

test('dockerfile: matches common file names', () => {
  for (const file of ['Dockerfile', 'build/Dockerfile.prod', 'api.dockerfile', 'Containerfile']) {
    assert.ok(dockerfileParser.matches(file), file);
  }
  assert.ok(!dockerfileParser.matches('docs/dockerfile-guide.md'));
});

test('dockerfile: resolves ARGs, skips stages and scratch, reads COPY --from images', () => {
  const { uses } = run(
    dockerfileParser,
    'Dockerfile',
    [
      'ARG BASE=ghcr.io/acme/base',
      'ARG TAG="1.4"',
      'FROM --platform=$BUILDPLATFORM ${BASE}:${TAG} AS build',
      'RUN make \\',
      '  all',
      'FROM build AS test',
      'FROM scratch',
      'COPY --from=build /out /app',
      'COPY --from=ghcr.io/acme/tools:2 /bin/tool /bin/tool',
      '# FROM ignored:1',
      'FROM ${UNKNOWN:-alpine:3.20}',
    ].join('\n'),
  );
  assert.deepEqual(brief(uses), ['ghcr.io/acme/base 1.4 L3', 'ghcr.io/acme/tools 2 L9', 'alpine 3.20 L11']);
});

test('terraform: reads module blocks and skips local and commented-out modules', () => {
  const { uses } = run(
    terraformParser,
    'main.tf',
    [
      'module "vpc" {',
      '  source = "git::https://github.com/acme/infra-modules.git//vpc?ref=v1.3.0"',
      '  tags   = { Name = "a}b" }',
      '}',
      '# module "old" {',
      '#   source = "acme/old/aws"',
      '# }',
      'module "local" {',
      '  source = "./modules/x"',
      '}',
      '  module "label" {',
      '    version = "0.25.0"',
      '    source  = "cloudposse/label/null"',
      '  }',
    ].join('\n'),
  );
  assert.deepEqual(brief(uses), ['github.com/acme/infra-modules//vpc v1.3.0 L1', 'cloudposse/label/null 0.25.0 L11']);
});

test('actions: finds uses in workflows and composite actions', () => {
  assert.ok(actionsParser.matches('.github/workflows/ci.yml'));
  assert.ok(actionsParser.matches('actions/setup/action.yaml'));
  assert.ok(!actionsParser.matches('.github/dependabot.yml'));

  const { uses } = run(
    actionsParser,
    '.github/workflows/ci.yml',
    [
      'on: push',
      'jobs:',
      '  build:',
      '    uses: acme/ci/.github/workflows/build.yml@v2',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    container: node:22',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '      - uses: ./.github/actions/local',
      '      - uses: docker://alpine:3.20',
    ].join('\n'),
  );
  assert.deepEqual(brief(uses), ['acme/ci/.github/workflows/build.yml v2 L4', 'actions/checkout v4 L9', 'alpine 3.20 L11', 'node 22 L7']);
});

test('actions: reads job container and service images', () => {
  const { uses } = run(
    actionsParser,
    '.github/workflows/test.yml',
    [
      'on: push',
      'env:',
      '  CI_TAG: "3"',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    container:',
      '      image: ghcr.io/acme/ci-image:${{ env.CI_TAG }}',
      '      options: --cpus 2',
      '    services:',
      '      db:',
      '        image: postgres:16',
      '      cache:',
      '        image: redis',
      '      broken:',
      '        image: ${{ matrix.image }}',
      '    steps:',
      '      - run: npm test',
    ].join('\n'),
  );
  assert.deepEqual(brief(uses), ['ghcr.io/acme/ci-image 3 L8', 'postgres 16 L12', 'redis latest L14']);
});

test('actions: detects images pushed by build-push-action, metadata-action and docker push', () => {
  const { produces } = run(
    actionsParser,
    '.github/workflows/publish.yml',
    [
      'on: push',
      'env:',
      '  REGISTRY: ghcr.io',
      'jobs:',
      '  publish:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: docker/metadata-action@v5',
      '        with:',
      '          images: |',
      '            name=${{ env.REGISTRY }}/${{ github.repository }}-worker,enable=true',
      '      - uses: docker/build-push-action@v6',
      '        with:',
      '          push: true',
      '          tags: ${{ env.REGISTRY }}/${{ github.repository }}:latest,${{ env.REGISTRY }}/acme/api:1.0',
      '      - uses: docker/build-push-action@v6',
      '        with:',
      '          push: false',
      '          tags: ghcr.io/acme/not-pushed:latest',
      '      - run: docker push 123.dkr.ecr.us-east-1.amazonaws.com/api:${{ github.sha }} && docker push acme/cli:1',
    ].join('\n'),
  );
  assert.deepEqual(
    produces.map((p) => p.name),
    ['ghcr.io/acme/api-worker', 'ghcr.io/acme/api', 'ghcr.io/acme/api', 'acme/cli'],
  );
});

test('npm: produces the package name and uses every dependency field', () => {
  const content = JSON.stringify(
    { name: '@acme/web', dependencies: { '@acme/utils': '^2.1.0' }, devDependencies: { typescript: '^5.9.0' } },
    null,
    2,
  );
  const result = run(npmParser, 'package.json', content);
  assert.deepEqual(result.produces.map((p) => p.name), ['@acme/web']);
  assert.deepEqual(brief(result.uses), ['@acme/utils ^2.1.0 L4', 'typescript ^5.9.0 L7']);
});

test('compose: reads service images and ignores build-only services', () => {
  assert.ok(composeParser.matches('docker-compose.override.yml'));
  assert.ok(composeParser.matches('deploy/compose.yaml'));
  const { uses } = run(
    composeParser,
    'compose.yaml',
    ['services:', '  api:', '    image: ghcr.io/acme/api:latest', '  local:', '    build: .', '  db:', '    image: postgres:16'].join('\n'),
  );
  assert.deepEqual(brief(uses), ['ghcr.io/acme/api latest L3', 'postgres 16 L7']);
});

test('kubernetes: reads container images from every workload kind in multi-document files', () => {
  assert.ok(kubernetesParser.matches('deploy/api.yaml'));
  assert.ok(kubernetesParser.matches('k8s/overlays/prod/cronjob.yml'));
  for (const other of ['.github/workflows/ci.yml', 'docker-compose.yml', 'charts/api/Chart.yaml', 'charts/api/values.yaml', 'charts/api/templates/deployment.yaml', '.pre-commit-config.yaml']) {
    assert.ok(!kubernetesParser.matches(other), other);
  }

  const { uses } = run(
    kubernetesParser,
    'deploy/api.yaml',
    [
      'apiVersion: apps/v1',
      'kind: Deployment',
      'spec:',
      '  template:',
      '    spec:',
      '      initContainers:',
      '        - name: migrate',
      '          image: ghcr.io/acme/migrations:2.0',
      '      containers:',
      '        - name: api',
      '          image: ghcr.io/acme/api:1.4',
      '---',
      'apiVersion: batch/v1',
      'kind: CronJob',
      'spec:',
      '  jobTemplate:',
      '    spec:',
      '      template:',
      '        spec:',
      '          containers:',
      '            - name: report',
      '              image: ghcr.io/acme/reports@sha256:0123456789abcdef0123',
    ].join('\n'),
  );
  assert.deepEqual(brief(uses), ['ghcr.io/acme/migrations 2.0 L8', 'ghcr.io/acme/api 1.4 L11', 'ghcr.io/acme/reports sha256:0123456789ab L22']);
});

test('kubernetes: quietly ignores YAML that is not a manifest or is templated', () => {
  assert.deepEqual(run(kubernetesParser, 'openapi.yaml', 'openapi: 3.0.0\ninfo:\n  title: API\n').uses, []);
  const templated = 'apiVersion: v1\nkind: Pod\nspec:\n  containers:\n    - image: {{ .Values.image }}\n';
  assert.deepEqual(run(kubernetesParser, 'pod.yaml', templated).uses, []);
});

test('helm: Chart.yaml produces the chart and uses its non-local dependencies', () => {
  const result = run(
    helmParser,
    'charts/api/Chart.yaml',
    [
      'apiVersion: v2',
      'name: API',
      'version: 1.2.0',
      'dependencies:',
      '  - name: common',
      '    version: ^2.0.0',
      '    repository: oci://ghcr.io/acme/charts',
      '  - name: postgresql',
      '    version: 15.5.1',
      '    repository: https://charts.bitnami.com/bitnami',
      '  - name: local-lib',
      '    repository: file://../local-lib',
    ].join('\n'),
  );
  assert.deepEqual(result.produces.map((p) => p.name), ['api']);
  assert.deepEqual(brief(result.uses), ['common ^2.0.0 L5', 'postgresql 15.5.1 L8']);
  // A chart vendored inside another chart is a copy of a dependency, not something this repo publishes.
  assert.deepEqual(run(helmParser, 'charts/api/charts/postgresql/Chart.yaml', 'name: postgresql\n').produces, []);
});

test('helm: values files yield images in both common layouts', () => {
  const { uses } = run(
    helmParser,
    'charts/api/values.yaml',
    [
      'image:',
      '  registry: ghcr.io',
      '  repository: acme/api',
      '  tag: "1.4"',
      '  pullPolicy: IfNotPresent',
      'worker:',
      '  image:',
      '    repository: ghcr.io/acme/worker',
      '    tag: ""',
      'sidecar:',
      '  image: ghcr.io/acme/proxy:0.9',
      'git:',
      '  repository: https://github.com/acme/config',
    ].join('\n'),
  );
  assert.deepEqual(brief(uses), ['ghcr.io/acme/api 1.4 L2', 'ghcr.io/acme/worker chart default L8', 'ghcr.io/acme/proxy 0.9 L11']);
});

test('go: go.mod produces the module and uses direct requirements', () => {
  const result = run(
    goModParser,
    'go.mod',
    [
      'module github.com/acme/api/v2',
      '',
      'go 1.23',
      '',
      'require github.com/acme/utils v1.4.0',
      '',
      'require (',
      '\tgithub.com/acme/log/v3 v3.0.1',
      '\tgolang.org/x/sync v0.8.0',
      '\tgithub.com/pkg/errors v0.9.1 // indirect',
      ')',
      '',
      'replace github.com/acme/utils => ../utils',
    ].join('\n'),
  );
  assert.deepEqual(result.produces.map((p) => p.name), ['github.com/acme/api/v2']);
  assert.deepEqual(brief(result.uses), ['github.com/acme/utils v1.4.0 L5', 'github.com/acme/log/v3 v3.0.1 L8', 'golang.org/x/sync v0.8.0 L9']);
  assert.deepEqual(result.uses.map((u) => u.repoHint), ['acme/utils', 'acme/log', undefined]);
});

test('python: requirements files, including git URLs', () => {
  assert.ok(pythonParser.matches('requirements.txt'));
  assert.ok(pythonParser.matches('services/api/requirements-dev.txt'));
  assert.ok(!pythonParser.matches('docs/requirements.md'));
  const { uses } = run(
    pythonParser,
    'requirements.txt',
    [
      '# runtime',
      'Acme_Utils==2.1.0',
      'requests[security]>=2.31,<3  # http',
      '-r base.txt',
      '--index-url https://pypi.acme.dev/simple',
      'git+https://github.com/acme/billing-client.git@v1.2.0#egg=billing-client',
      '-e ./local-package',
      'pydantic; python_version >= "3.9"',
    ].join('\n'),
  );
  assert.deepEqual(brief(uses), ['acme-utils ==2.1.0 L2', 'requests >=2.31,<3 L3', 'billing-client v1.2.0 L6', 'pydantic unpinned L8']);
  assert.equal(uses[2]?.repoHint, 'acme/billing-client');
});

test('python: pyproject.toml in PEP 621 and Poetry form', () => {
  const pep621 = run(
    pythonParser,
    'pyproject.toml',
    [
      '[project]',
      'name = "acme.api"',
      'dependencies = [',
      '  "acme-utils>=2",',
      '  "acme-auth @ git+https://github.com/acme/auth@v3.1",',
      ']',
      '[project.optional-dependencies]',
      'dev = ["pytest>=8"]',
      '[dependency-groups]',
      'lint = ["ruff==0.6.0"]',
    ].join('\n'),
  );
  assert.deepEqual(pep621.produces.map((p) => p.name), ['acme-api']);
  assert.deepEqual(brief(pep621.uses), ['acme-utils >=2 L4', 'acme-auth v3.1 L5', 'pytest >=8 L8', 'ruff ==0.6.0 L10']);
  assert.equal(pep621.uses[1]?.repoHint, 'acme/auth');

  const poetry = run(
    pythonParser,
    'pyproject.toml',
    [
      '[tool.poetry]',
      'name = "acme-worker"',
      '[tool.poetry.dependencies]',
      'python = "^3.12"',
      'acme-utils = "^2.0"',
      'acme-auth = { git = "https://github.com/acme/auth.git", tag = "v3.0" }',
      'local-lib = { path = "../local-lib" }',
      '[tool.poetry.group.dev.dependencies]',
      'pytest = { version = "^8.0" }',
    ].join('\n'),
  );
  assert.deepEqual(poetry.produces.map((p) => p.name), ['acme-worker']);
  assert.deepEqual(brief(poetry.uses), ['acme-utils ^2.0 L5', 'acme-auth v3.0 L6', 'pytest ^8.0 L9']);
});

test('actions: a malformed workflow still yields its uses: lines, with a warning', () => {
  const result = run(
    actionsParser,
    '.github/workflows/trigger.yml',
    ['jobs:', '  check:', '    steps:', '      - uses: actions/checkout@v4', '      - run: |', '          X=$(curl', ')', '      - uses: acme/ci/.github/workflows/build.yml@v2'].join('\n'),
  );
  assert.deepEqual(brief(result.uses), ['actions/checkout v4 L4', 'acme/ci/.github/workflows/build.yml v2 L8']);
  assert.equal(result.warnings?.length, 1);
  assert.match(result.warnings![0]!, /not valid YAML/);
});
