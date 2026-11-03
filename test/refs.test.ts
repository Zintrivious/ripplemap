import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guessImageRepo, parseImageRef, parseModuleSource, parseRepoUrl, parseUses } from '../src/refs.ts';

test('parseRepoUrl handles ssh, scp-style and https remotes', () => {
  const expected = { host: 'github.com', owner: 'acme', name: 'api' };
  assert.deepEqual(parseRepoUrl('git@github.com:Acme/api.git'), expected);
  assert.deepEqual(parseRepoUrl('https://github.com/acme/api'), expected);
  assert.deepEqual(parseRepoUrl('ssh://git@github.com/acme/api.git'), expected);
  assert.deepEqual(parseRepoUrl('https://gitlab.com/acme/platform/api.git'), { host: 'gitlab.com', owner: 'acme/platform', name: 'api' });
  assert.equal(parseRepoUrl('not a url'), null);
});

test('parseImageRef normalizes names and versions', () => {
  assert.deepEqual(parseImageRef('node:22-alpine'), { name: 'node', version: '22-alpine' });
  assert.deepEqual(parseImageRef('docker.io/library/postgres'), { name: 'postgres', version: 'latest' });
  assert.deepEqual(parseImageRef('GHCR.io/Acme/Base:1.4'), { name: 'ghcr.io/acme/base', version: '1.4' });
  assert.deepEqual(parseImageRef('localhost:5000/app'), { name: 'localhost:5000/app', version: 'latest' });
  assert.deepEqual(parseImageRef('ghcr.io/acme/base@sha256:0123456789abcdef'), { name: 'ghcr.io/acme/base', version: 'sha256:0123456789ab' });
  assert.equal(parseImageRef('${BASE_IMAGE}'), null);
});

test('guessImageRepo maps registry paths to owner/name', () => {
  assert.deepEqual(guessImageRepo('ghcr.io/acme/api'), { owner: 'acme', name: 'api' });
  assert.deepEqual(guessImageRepo('acme/api'), { owner: 'acme', name: 'api' });
  assert.deepEqual(guessImageRepo('123.dkr.ecr.us-east-1.amazonaws.com/api'), { name: 'api' });
  assert.equal(guessImageRepo('node'), null);
});

test('parseModuleSource handles git and registry sources', () => {
  assert.deepEqual(parseModuleSource('git::https://github.com/acme/infra-modules.git//vpc?ref=v1.3.0'), {
    kind: 'terraform-module',
    name: 'github.com/acme/infra-modules//vpc',
    version: 'v1.3.0',
    repoHint: 'acme/infra-modules',
    hintConfidence: 'exact',
  });
  assert.equal(parseModuleSource('github.com/acme/infra-modules//vpc?ref=v1.1.0')?.name, 'github.com/acme/infra-modules//vpc');
  assert.equal(parseModuleSource('git@github.com:acme/modules.git//rds?ref=main')?.repoHint, 'acme/modules');
  assert.equal(parseModuleSource('git::ssh://git@github.com/acme/modules.git')?.version, 'default branch');

  const registry = parseModuleSource('cloudposse/label/null', '0.25.0');
  assert.equal(registry?.name, 'cloudposse/label/null');
  assert.equal(registry?.repoHint, 'cloudposse/terraform-null-label');
  assert.equal(registry?.hintConfidence, 'exact');
  assert.equal(parseModuleSource('app.terraform.io/acme/vpc/aws')?.name, 'app.terraform.io/acme/vpc/aws');
  assert.equal(parseModuleSource('terraform-aws-modules/vpc/aws')?.version, 'unpinned');

  assert.equal(parseModuleSource('./modules/vpc'), null);
  assert.equal(parseModuleSource('s3::https://bucket.s3.amazonaws.com/vpc.zip'), null);
});

test('parseUses distinguishes actions, reusable workflows and docker images', () => {
  assert.deepEqual(parseUses('actions/checkout@v4'), {
    kind: 'action',
    name: 'actions/checkout',
    version: 'v4',
    repoHint: 'actions/checkout',
    hintConfidence: 'exact',
  });
  assert.equal(parseUses('acme/ci/.github/workflows/build.yml@v2')?.kind, 'workflow');
  assert.equal(parseUses('acme/actions/setup-tools@main')?.repoHint, 'acme/actions');
  assert.deepEqual(parseUses('docker://alpine:3.20'), { kind: 'image', name: 'alpine', version: '3.20' });
  assert.equal(parseUses('./.github/actions/local'), null);
});
