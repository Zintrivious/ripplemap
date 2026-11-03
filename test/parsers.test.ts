import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actionsParser } from '../src/parsers/actions.ts';
import { composeParser } from '../src/parsers/compose.ts';
import { dockerfileParser } from '../src/parsers/dockerfile.ts';
import { npmParser } from '../src/parsers/npm.ts';
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
