#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { formatDrift, formatImpact, formatScanSummary, yellow } from './format.ts';
import { drift, findRepo, impact, mostDependedOn } from './graph.ts';
import { scan } from './scan.ts';
import type { ArtifactKind, Graph } from './types.ts';

const KINDS: ArtifactKind[] = ['image', 'terraform-module', 'workflow', 'action', 'npm'];
const DEFAULT_GRAPH = 'ripplemap.json';

const HELP = `ripplemap: see which repos are affected when you change one

Usage:
  ripplemap scan <dir> [--out ripplemap.json] [--owner <org>] [--exclude <dir>] [--verbose]
      Scan a folder of cloned repos (or a single repo) and write the dependency graph.
      --owner    the org for repos that have no git remote
      --exclude  skip a folder name (examples) or repo-relative path (test/fixtures), repeatable

  ripplemap impact <repo> [--graph ripplemap.json] [--json]
      Every repo that depends on <repo>, directly or through other repos.

  ripplemap drift [--graph ripplemap.json] [--internal] [--kind <kind>] [--json] [--fail]
      Shared images, modules, workflows and packages used at different versions.
      --internal  only things built in your scanned repos
      --kind      one of: ${KINDS.join(', ')} (repeatable)
      --fail      exit with code 1 if any drift is found (for CI)

  ripplemap --version
`;

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return pkg.version;
}

function loadGraph(file: string): Graph {
  if (!existsSync(file)) throw new Error(`${file} not found. Run "ripplemap scan <dir>" first, or pass --graph.`);
  const graph = JSON.parse(readFileSync(file, 'utf8')) as Graph;
  if (graph.schemaVersion !== 1) throw new Error(`${file} was written by an incompatible version of ripplemap. Re-run scan.`);
  return graph;
}

function runScan(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o', default: DEFAULT_GRAPH },
      owner: { type: 'string' },
      exclude: { type: 'string', multiple: true },
      verbose: { type: 'boolean', short: 'v', default: false },
    },
  });
  const dir = positionals[0];
  if (!dir) throw new Error('Usage: ripplemap scan <dir>');
  if (!existsSync(dir)) throw new Error(`${dir} does not exist.`);

  const { graph, filesParsed, warnings } = scan(dir, { owner: values.owner, exclude: values.exclude });
  writeFileSync(values.out, JSON.stringify(graph, null, 2) + '\n');
  console.log(formatScanSummary(graph, dir, filesParsed, mostDependedOn(graph), values.out));

  if (warnings.length) {
    console.log('');
    if (values.verbose) for (const w of warnings) console.log(yellow(`warning: ${w.repo}/${w.file}: ${w.message}`));
    else console.log(yellow(`${warnings.length} files could not be parsed. Run with --verbose to see them.`));
  }
  return 0;
}

function runImpact(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      graph: { type: 'string', short: 'g', default: DEFAULT_GRAPH },
      json: { type: 'boolean', default: false },
    },
  });
  if (!positionals[0]) throw new Error('Usage: ripplemap impact <repo>');
  const graph = loadGraph(values.graph);
  const target = findRepo(graph, positionals[0]);
  const entries = impact(graph, target.id);
  console.log(values.json ? JSON.stringify({ target: target.id, affected: entries }, null, 2) : formatImpact(graph, target.id, entries));
  return 0;
}

function runDrift(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: {
      graph: { type: 'string', short: 'g', default: DEFAULT_GRAPH },
      internal: { type: 'boolean', default: false },
      kind: { type: 'string', multiple: true },
      json: { type: 'boolean', default: false },
      fail: { type: 'boolean', default: false },
    },
  });
  const kinds = values.kind as ArtifactKind[] | undefined;
  const unknown = kinds?.find((k) => !KINDS.includes(k));
  if (unknown) throw new Error(`Unknown kind "${unknown}". Use one of: ${KINDS.join(', ')}`);

  const graph = loadGraph(values.graph);
  const entries = drift(graph, { internalOnly: values.internal, kinds });
  console.log(values.json ? JSON.stringify(entries, null, 2) : formatDrift(graph, entries));
  return values.fail && entries.length ? 1 : 0;
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  switch (command) {
    case 'scan':
      return runScan(rest);
    case 'impact':
      return runImpact(rest);
    case 'drift':
      return runDrift(rest);
    case '--version':
    case '-V':
      console.log(version());
      return 0;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return 0;
    default:
      console.error(`Unknown command "${command}".\n\n${HELP}`);
      return 2;
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(`ripplemap: ${(error as Error).message}`);
  process.exitCode = 2;
}
