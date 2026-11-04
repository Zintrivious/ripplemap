#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { changeImpact } from './changes.ts';
import { dim, formatChangeImpact, formatDrift, formatImpact, formatScanSummary, formatUnpinned, plural, yellow } from './format.ts';
import { formatChangeMarkdown } from './markdown.ts';
import { scanAzure } from './azure.ts';
import { scanGitHub } from './github.ts';
import { drift, findRepo, impact, mostDependedOn, unpinned } from './graph.ts';
import { renderReport } from './report.ts';
import { scan, type ScanResult } from './scan.ts';
import type { ArtifactKind, Graph } from './types.ts';

const KINDS: ArtifactKind[] = ['image', 'terraform-module', 'workflow', 'action', 'npm', 'helm-chart', 'go', 'python', 'pipeline'];
const DEFAULT_GRAPH = 'ripplemap.json';

const HELP = `ripplemap: see which repos are affected when you change one

Usage:
  ripplemap scan <dir> [--out ripplemap.json] [--owner <org>] [--exclude <dir>] [--verbose]
      Scan a folder of cloned repos (or a single repo) and write the dependency graph.
      --owner    the org for repos that have no git remote
      --exclude  skip a folder name (examples) or repo-relative path (test/fixtures), repeatable

  ripplemap scan --org <name> [--match <glob>] [--include-forks] [--include-archived] [--no-cache]
      Scan every repo of a GitHub org or user without cloning. Uses GITHUB_TOKEN, GH_TOKEN,
      or your "gh auth login" session. Takes --out, --exclude and --verbose too.
      --match  only repos whose name matches, e.g. "terraform-*" (repeatable)

  ripplemap scan --azure-org <org> [--project <name>] [--match <glob>] [--include-forks] [--no-cache]
      Scan an Azure DevOps organization without cloning. Uses AZURE_DEVOPS_TOKEN (a PAT with
      Code: read), AZURE_DEVOPS_EXT_PAT, or SYSTEM_ACCESSTOKEN in a pipeline. Without a token,
      name public projects with --project (repeatable).

  ripplemap impact <repo> [--graph ripplemap.json] [--json]
      Every repo that depends on <repo>, directly or through other repos.

  ripplemap affected <repo> --files <list|-> [--graph ripplemap.json] [--markdown] [--json]
      Which repos a change to these files in <repo> may affect. --files is a file with one path
      per line, or - for stdin:  git diff --name-only main | ripplemap affected api --files -
      Docs, tests and examples are ignored. --markdown writes the pull request comment.

  ripplemap drift [--graph ripplemap.json] [--internal] [--kind <kind>] [--json] [--fail]
      Shared images, modules, workflows and packages used at different versions.
      --internal  only things built in your scanned repos
      --kind      one of: ${KINDS.join(', ')} (repeatable)
      --fail      exit with code 1 if any drift is found (for CI)

  ripplemap unpinned [--graph ripplemap.json] [--all] [--json] [--fail]
      References that pin nothing (latest, @main, no ref or version), so every new release
      reaches them without a pull request.
      --all   include third-party references too, not just things built in your repos
      --fail  exit with code 1 if any are found (for CI)

  ripplemap report [--graph ripplemap.json] [--out ripplemap.html] [--open]
      A self-contained HTML page: an interactive impact graph and the drift table.

  ripplemap --version

Every command takes --strict: exit with code 1 when the scan was incomplete (some files or repos
could not be read or parsed), so a CI job never trusts a graph with missing dependencies.
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

/** Warns on stderr when the scan behind a graph missed something. Returns the exit code to use. */
function checkComplete(graph: Graph, strict: boolean): number {
  const problems = graph.warnings?.length ?? 0;
  if (!problems) return 0;
  console.error(
    yellow(
      `Incomplete scan: ${problems === 1 ? '1 file or repo' : `${problems} files or repos`} could not be read or parsed, so some dependencies may be missing. ` +
        'Re-run scan with --verbose to see them.',
    ),
  );
  return strict ? 1 : 0;
}

const strictOption = { strict: { type: 'boolean', default: false } } as const;

async function runScan(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o', default: DEFAULT_GRAPH },
      owner: { type: 'string' },
      exclude: { type: 'string', multiple: true },
      verbose: { type: 'boolean', short: 'v', default: false },
      org: { type: 'string' },
      'azure-org': { type: 'string' },
      project: { type: 'string', multiple: true },
      match: { type: 'string', multiple: true },
      'include-forks': { type: 'boolean', default: false },
      'include-archived': { type: 'boolean', default: false },
      'no-cache': { type: 'boolean', default: false },
      ...strictOption,
    },
  });
  const dir = positionals[0];
  const sources = [dir, values.org, values['azure-org']].filter(Boolean).length;
  if (sources > 1) throw new Error('Pass one of a folder, --org or --azure-org.');
  if (!sources) throw new Error('Usage: ripplemap scan <dir>  or  ripplemap scan --org <github-org>  or  ripplemap scan --azure-org <org>');

  let result: ScanResult;
  let source: string;
  if (values.org) {
    source = `github.com/${values.org}`;
    const progress = process.stderr.isTTY ? (done: number, total: number) => process.stderr.write(`\rFetching repos ${done}/${total}`) : undefined;
    const github = await scanGitHub({
      org: values.org,
      match: values.match,
      includeForks: values['include-forks'],
      includeArchived: values['include-archived'],
      cacheDir: values['no-cache'] ? false : undefined,
      exclude: values.exclude,
      onProgress: progress,
    });
    if (progress) process.stderr.write('\r\x1b[K');
    const { stats } = github;
    const skipped = stats.skipped ? `, skipped ${stats.skipped} forks/archived/unmatched` : '';
    console.error(dim(`${stats.apiRequests} API requests, ${stats.downloads} files downloaded, ${stats.cacheHits} from cache${skipped}.`));
    result = github;
  } else if (values['azure-org']) {
    const org = values['azure-org'];
    source = `dev.azure.com/${org}`;
    const progress = process.stderr.isTTY ? (done: number, total: number) => process.stderr.write(`\rFetching repos ${done}/${total}`) : undefined;
    const azure = await scanAzure({
      org,
      projects: values.project,
      match: values.match,
      includeForks: values['include-forks'],
      cacheDir: values['no-cache'] ? false : undefined,
      exclude: values.exclude,
      onProgress: progress,
    });
    if (progress) process.stderr.write('\r\x1b[K');
    const { stats } = azure;
    const skipped = stats.skipped ? `, skipped ${stats.skipped} disabled/forked/unmatched` : '';
    console.error(dim(`${stats.apiRequests} API requests, ${stats.downloads} files downloaded, ${stats.cacheHits} from cache${skipped}.`));
    result = azure;
  } else {
    if (!existsSync(dir!)) throw new Error(`${dir} does not exist.`);
    source = dir!;
    result = scan(dir!, { owner: values.owner, exclude: values.exclude });
  }

  const { graph, filesParsed, warnings } = result;
  graph.source = source;
  writeFileSync(values.out, JSON.stringify(graph, null, 2) + '\n');
  console.log(formatScanSummary(graph, source, filesParsed, mostDependedOn(graph), values.out));

  if (!warnings.length) return 0;
  console.log('');
  if (values.verbose) {
    for (const w of warnings) console.log(yellow(`warning: ${w.repo}${w.file ? `/${w.file}` : ''}: ${w.message}`));
    console.log('');
  }
  const code = checkComplete(graph, values.strict);
  if (code) console.error(yellow('Failing because of --strict. The graph was still written so you can inspect it.'));
  return code;
}

function runImpact(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      graph: { type: 'string', short: 'g', default: DEFAULT_GRAPH },
      json: { type: 'boolean', default: false },
      ...strictOption,
    },
  });
  if (!positionals[0]) throw new Error('Usage: ripplemap impact <repo>');
  const graph = loadGraph(values.graph);
  const target = findRepo(graph, positionals[0]);
  const entries = impact(graph, target.id);
  const complete = !graph.warnings?.length;
  console.log(values.json ? JSON.stringify({ target: target.id, complete, affected: entries }, null, 2) : formatImpact(graph, target.id, entries));
  return checkComplete(graph, values.strict);
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
      ...strictOption,
    },
  });
  const kinds = values.kind as ArtifactKind[] | undefined;
  const unknown = kinds?.find((k) => !KINDS.includes(k));
  if (unknown) throw new Error(`Unknown kind "${unknown}". Use one of: ${KINDS.join(', ')}`);

  const graph = loadGraph(values.graph);
  const entries = drift(graph, { internalOnly: values.internal, kinds });
  console.log(values.json ? JSON.stringify(entries, null, 2) : formatDrift(graph, entries));
  const incomplete = checkComplete(graph, values.strict);
  return values.fail && entries.length ? 1 : incomplete;
}

function runAffected(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      graph: { type: 'string', short: 'g', default: DEFAULT_GRAPH },
      files: { type: 'string' },
      markdown: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      ...strictOption,
    },
  });
  if (!positionals[0] || !values.files) throw new Error('Usage: ripplemap affected <repo> --files <list|->');
  const graph = loadGraph(values.graph);
  const list = readFileSync(values.files === '-' ? 0 : values.files, 'utf8').split(/\r?\n/);

  // A repo outside the scan (filtered by --match, say) is reported as such rather than failing.
  let repo = positionals[0].toLowerCase();
  try {
    repo = findRepo(graph, positionals[0]).id;
  } catch {}

  const result = changeImpact(graph, repo, list);
  if (values.json) console.log(JSON.stringify({ ...result, complete: !graph.warnings?.length }, null, 2));
  else if (values.markdown) process.stdout.write(formatChangeMarkdown(graph, result, { version: version() }));
  else console.log(formatChangeImpact(graph, result));
  return checkComplete(graph, values.strict);
}

function runUnpinned(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: {
      graph: { type: 'string', short: 'g', default: DEFAULT_GRAPH },
      all: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      fail: { type: 'boolean', default: false },
      ...strictOption,
    },
  });
  const graph = loadGraph(values.graph);
  const entries = unpinned(graph, { all: values.all });
  console.log(values.json ? JSON.stringify(entries, null, 2) : formatUnpinned(graph, entries, values.all));
  const incomplete = checkComplete(graph, values.strict);
  return values.fail && entries.length ? 1 : incomplete;
}

function openInBrowser(file: string): void {
  const [command, ...args] =
    process.platform === 'darwin' ? ['open', file] : process.platform === 'win32' ? ['cmd', '/c', 'start', '', file] : ['xdg-open', file];
  const child = spawn(command!, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => console.error(yellow(`Couldn't open a browser. Open ${file} yourself.`)));
  child.unref();
}

function runReport(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: {
      graph: { type: 'string', short: 'g', default: DEFAULT_GRAPH },
      out: { type: 'string', short: 'o', default: 'ripplemap.html' },
      open: { type: 'boolean', default: false },
      ...strictOption,
    },
  });
  const graph = loadGraph(values.graph);
  writeFileSync(values.out, renderReport(graph));
  console.log(`Wrote ${values.out} (${plural(graph.repos.length, 'repo')}, ${plural(graph.links.length, 'link')}).${values.open ? '' : ' Open it in a browser, or add --open.'}`);
  if (values.open) openInBrowser(resolve(values.out));
  return checkComplete(graph, values.strict);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'scan':
      return runScan(rest);
    case 'report':
      return runReport(rest);
    case 'unpinned':
      return runUnpinned(rest);
    case 'affected':
      return runAffected(rest);
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

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: Error) => {
    console.error(`ripplemap: ${error.message}`);
    process.exitCode = 2;
  },
);
