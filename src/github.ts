import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scanGitHubApi, type ApiTree, type GitHubScanOptions as ApiScanOptions, type GitHubScanResult, type ScanCache } from './github-api.ts';

export { globToRegExp, pool, type GitHubScanResult } from './github-api.ts';

export interface GitHubScanOptions extends Omit<ApiScanOptions, 'cache'> {
  /** Defaults to GITHUB_TOKEN, GH_TOKEN, or `gh auth token`. */
  token?: string;
  /** Where downloaded files are cached by git blob SHA. `false` turns the cache off. */
  cacheDir?: string | false;
}

/** A token from the environment or the GitHub CLI, if either has one. */
export function findToken(): string | undefined {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function defaultCacheDir(): string {
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'ripplemap');
}

/** Blobs under blobs/<sha prefix>/<sha>, one listing per repo under trees/. */
export function fileCache(dir: string): ScanCache {
  const blob = (sha: string) => join(dir, 'blobs', sha.slice(0, 2), sha);
  const tree = (repo: string) => join(dir, 'trees', `${repo.replace('/', '__')}.json`);
  return {
    getBlob: (sha) => (existsSync(blob(sha)) ? readFileSync(blob(sha), 'utf8') : undefined),
    setBlob(sha, content) {
      mkdirSync(join(dir, 'blobs', sha.slice(0, 2)), { recursive: true });
      writeFileSync(blob(sha), content);
    },
    getTree(repo, pushedAt, branch) {
      if (!existsSync(tree(repo))) return undefined;
      const entry = JSON.parse(readFileSync(tree(repo), 'utf8')) as { pushedAt: string; branch: string; tree: ApiTree };
      return entry.pushedAt === pushedAt && entry.branch === branch ? entry.tree : undefined;
    },
    setTree(repo, pushedAt, branch, value) {
      mkdirSync(join(dir, 'trees'), { recursive: true });
      writeFileSync(tree(repo), JSON.stringify({ pushedAt, branch, tree: value }));
    },
  };
}

/** Scans every repo of a GitHub org or user without cloning, fetching only the files parsers read. */
export function scanGitHub(options: GitHubScanOptions): Promise<GitHubScanResult> {
  const { cacheDir, ...rest } = options;
  const dir = cacheDir === false ? undefined : (cacheDir ?? defaultCacheDir());
  return scanGitHubApi({ ...rest, token: options.token ?? findToken(), ...(dir ? { cache: fileCache(dir) } : {}) });
}
