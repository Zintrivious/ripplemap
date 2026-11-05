import { buildLinks } from './graph.ts';
import { parsers as defaultParsers } from './parsers/index.ts';
import type { Graph, Parser, RepoInfo, RepoProduction, RepoUsage, ScanWarning } from './types.ts';

// The parts of scanning that need no file system, shared by the CLI and the in-browser scanner.

export const SKIP_DIRS = new Set([
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
