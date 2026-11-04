import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { buildLinks } from './graph.ts';
import { parsers as defaultParsers } from './parsers/index.ts';
import { parseRepoUrl } from './refs.ts';
import type { Graph, Parser, RepoInfo, RepoProduction, RepoUsage, ScanWarning } from './types.ts';

const SKIP_DIRS = new Set([
  // Installed dependencies: other people's files, not this repo's.
  'node_modules', '.terraform', 'vendor', '.venv', 'venv', 'bower_components', '__pycache__',
  // Test data: deliberately fake (sometimes deliberately broken) manifests.
  'fixture', 'fixtures', '__fixtures__', 'testdata', '__snapshots__',
]);
/** Generated install bundles and CRDs can run past 10 MB, and they reference real images. */
export const MAX_FILE_BYTES = 32 * 1024 * 1024;

export interface ScanOptions {
  /** Owner to use for repos without a git remote, e.g. your GitHub org. */
  owner?: string;
  /** Folder names or repo-relative path prefixes to skip, e.g. "examples" or "test/fixtures". */
  exclude?: string[];
  parsers?: Parser[];
}

export type { ScanWarning };

export interface ScanResult {
  graph: Graph;
  filesParsed: number;
  warnings: ScanWarning[];
}

/** A repo whose candidate files are known, wherever they come from (disk, GitHub API). */
export interface LoadedRepo {
  repo: RepoInfo;
  files: { path: string; read: () => string }[];
}

function isExcluded(file: string, exclude: string[]): boolean {
  const segments = file.split('/').slice(0, -1);
  return exclude.some((pattern) => {
    const p = pattern.replace(/^\.?\/+|\/+$/g, '');
    return p.includes('/') ? file.startsWith(`${p}/`) : segments.includes(p);
  });
}

/** Dot-folders that hold CI configuration ripplemap reads. Every other dot-folder is skipped. */
const KEPT_DOT_DIRS = new Set(['.github', '.azure-pipelines', '.azuredevops', '.pipelines']);

export const skipDir = (name: string) => SKIP_DIRS.has(name) || (name.startsWith('.') && !KEPT_DOT_DIRS.has(name));

/**
 * Whether a repo-relative path should be read: some parser wants it, it is not excluded,
 * and it is not inside a dependency folder or a dot-folder other than .github.
 */
export function wantsFile(file: string, options: ScanOptions = {}): boolean {
  if (file.split('/').slice(0, -1).some(skipDir)) return false;
  if (options.exclude?.length && isExcluded(file, options.exclude)) return false;
  return (options.parsers ?? defaultParsers).some((p) => p.matches(file));
}

/** Files under `dir`, relative to it with forward slashes, without descending into skipped folders. */
function* walk(dir: string, root = dir): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skipDir(entry.name)) yield* walk(join(dir, entry.name), root);
    } else if (entry.isFile()) {
      yield relative(root, join(dir, entry.name)).split(sep).join('/');
    }
  }
}

/**
 * A folder that is itself a git repo is one repo; otherwise each subfolder is a repo.
 * Dot-folders count only when they are git repos (GitHub orgs often have a ".github" repo).
 */
function findRepoDirs(root: string): string[] {
  if (existsSync(join(root, '.git'))) return [root];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && (!e.name.startsWith('.') || existsSync(join(root, e.name, '.git'))))
    .map((e) => join(root, e.name))
    .sort();
}

function originUrl(repoDir: string): string | undefined {
  try {
    const config = readFileSync(join(repoDir, '.git', 'config'), 'utf8');
    return /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(config)?.[1];
  } catch {
    return undefined;
  }
}

function identify(repoDir: string, root: string, owner?: string): RepoInfo {
  const remote = originUrl(repoDir);
  const ref = remote ? parseRepoUrl(remote) : null;
  const name = ref?.name ?? basename(repoDir).toLowerCase();
  const repoOwner = ref?.owner ?? owner?.toLowerCase() ?? '';
  let url: string | undefined;
  if (ref && /^(github\.com|gitlab\.com|bitbucket\.org)$/.test(ref.host)) url = `https://${ref.host}/${ref.owner}/${ref.name}`;
  if (ref?.host === 'dev.azure.com') {
    const [org, project] = ref.owner.split('/') as [string, string];
    url = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_git/${encodeURIComponent(ref.name)}`;
  }
  return {
    id: repoOwner ? `${repoOwner}/${name}` : name,
    owner: repoOwner,
    name,
    path: relative(root, repoDir).split(sep).join('/') || '.',
    ...(url ? { url } : {}),
  };
}

/** Runs the parsers over already-located files and links the results. */
export function scanRepos(repos: LoadedRepo[], options: ScanOptions = {}, warnings: ScanWarning[] = []): ScanResult {
  const parsers = options.parsers ?? defaultParsers;
  const usages: RepoUsage[] = [];
  const produces: RepoProduction[] = [];
  let filesParsed = 0;

  for (const { repo, files } of repos) {
    for (const file of files) {
      const matching = parsers.filter((p) => p.matches(file.path));
      if (!matching.length) continue;
      let content: string;
      try {
        content = file.read();
      } catch (error) {
        warnings.push({ repo: repo.id, file: file.path, message: `could not read: ${(error as Error).message}` });
        continue;
      }
      filesParsed++;

      for (const parser of matching) {
        try {
          const result = parser.parse({ repo, file: file.path, content });
          for (const u of result.uses) usages.push({ ...u, repo: repo.id });
          for (const p of result.produces) produces.push({ ...p, repo: repo.id });
          for (const message of result.warnings ?? []) warnings.push({ repo: repo.id, file: file.path, message: `${parser.id}: ${message}` });
        } catch (error) {
          warnings.push({ repo: repo.id, file: file.path, message: `${parser.id}: ${(error as Error).message}` });
        }
      }
    }
  }

  const repoInfos = repos.map((r) => r.repo);
  return {
    graph: {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      warnings,
      repos: repoInfos,
      usages,
      produces,
      links: buildLinks(repoInfos, usages, produces),
    },
    filesParsed,
    warnings,
  };
}

/** Scans repos cloned on disk. */
export function scan(rootDir: string, options: ScanOptions = {}): ScanResult {
  const root = resolve(rootDir);
  const warnings: ScanWarning[] = [];
  const repos = findRepoDirs(root).map((repoDir): LoadedRepo => {
    const repo = identify(repoDir, root, options.owner);
    const files: LoadedRepo['files'] = [];
    for (const path of walk(repoDir)) {
      if (!wantsFile(path, options)) continue;
      const abs = join(repoDir, path);
      // If stat fails, read() fails too and reports it.
      const size = (() => {
        try {
          return statSync(abs).size;
        } catch {
          return 0;
        }
      })();
      if (size > MAX_FILE_BYTES) warnings.push({ repo: repo.id, file: path, message: 'skipped: larger than 32 MB' });
      else files.push({ path, read: () => readFileSync(abs, 'utf8') });
    }
    return { repo, files };
  });
  return scanRepos(repos, options, warnings);
}
