import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { MAX_FILE_BYTES, scanRepos, SKIP_DIRS, skipDir, wantsFile, type LoadedRepo, type ScanOptions, type ScanResult } from './core.ts';
import { parseRepoUrl } from './refs.ts';
import type { RepoInfo, ScanWarning } from './types.ts';

export { MAX_FILE_BYTES, scanRepos, skipDir, wantsFile, type LoadedRepo, type ScanOptions, type ScanResult, type ScanWarning } from './core.ts';

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
