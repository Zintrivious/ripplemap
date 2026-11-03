import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MAX_FILE_BYTES, scanRepos, wantsFile, type LoadedRepo, type ScanOptions, type ScanResult, type ScanWarning } from './scan.ts';
import type { RepoInfo } from './types.ts';

export interface GitHubScanOptions extends Omit<ScanOptions, 'owner'> {
  /** Org or user to scan. */
  org: string;
  /** Glob patterns matched against repo names, e.g. "terraform-*". A repo is kept if any pattern matches. */
  match?: string[];
  includeForks?: boolean;
  includeArchived?: boolean;
  /** Defaults to GITHUB_TOKEN, GH_TOKEN, or `gh auth token`. */
  token?: string;
  /** Where downloaded files are cached by git blob SHA. `false` turns the cache off. */
  cacheDir?: string | false;
  fetch?: typeof fetch;
  apiUrl?: string;
  rawUrl?: string;
  /** Repos fetched at the same time. Each also fetches up to 4 files at once. */
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface GitHubScanResult extends ScanResult {
  stats: { repos: number; skipped: number; apiRequests: number; downloads: number; cacheHits: number };
}

interface ApiRepo {
  name: string;
  full_name: string;
  owner: { login: string };
  default_branch: string;
  fork: boolean;
  archived: boolean;
  pushed_at?: string;
}

interface ApiTree {
  tree: { path: string; type: string; sha: string; size?: number }[];
  truncated: boolean;
}

class GitHubError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
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

class GitHubClient {
  requests = 0;
  readonly authenticated: boolean;
  private fetchFn: typeof fetch;
  private headers: Record<string, string>;
  private apiUrl: string;

  constructor(fetchFn: typeof fetch, apiUrl: string, token?: string) {
    this.fetchFn = fetchFn;
    this.apiUrl = apiUrl.replace(/\/+$/, '');
    this.authenticated = Boolean(token);
    this.headers = { 'User-Agent': 'ripplemap', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  }

  async get(url: string, api = true): Promise<Response> {
    if (api) this.requests++;
    const headers = api ? { ...this.headers, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } : this.headers;
    const res = await this.fetchFn(url, { headers });
    if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
      const when = reset ? ` It resets at ${new Date(reset).toLocaleTimeString()}.` : '';
      const hint = this.authenticated ? '' : ' Set GITHUB_TOKEN or run "gh auth login" to get 5,000 requests an hour instead of 60.';
      throw new Error(`GitHub API rate limit reached.${when}${hint}`);
    }
    if (!res.ok) throw new GitHubError(res.status, `GitHub returned ${res.status} for ${url.replace(this.apiUrl, '')}`);
    return res;
  }

  async json<T>(path: string): Promise<T> {
    return (await this.get(`${this.apiUrl}${path}`)).json() as Promise<T>;
  }

  /** Follows `Link: <...>; rel="next"` headers until the last page. */
  async paginate<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    let url: string | undefined = `${this.apiUrl}${path}`;
    while (url) {
      const res = await this.get(url);
      items.push(...((await res.json()) as T[]));
      url = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1];
    }
    return items;
  }
}

async function listRepos(client: GitHubClient, org: string): Promise<ApiRepo[]> {
  const name = encodeURIComponent(org);
  try {
    return await client.paginate<ApiRepo>(`/orgs/${name}/repos?type=all&per_page=100`);
  } catch (error) {
    if (!(error instanceof GitHubError && error.status === 404)) throw error;
  }
  // Not an org. Your own private repos are only listed through /user/repos.
  if (client.authenticated) {
    const me = await client.json<{ login: string }>('/user').catch(() => undefined);
    if (me?.login.toLowerCase() === org.toLowerCase()) return client.paginate<ApiRepo>('/user/repos?affiliation=owner&per_page=100');
  }
  try {
    return await client.paginate<ApiRepo>(`/users/${name}/repos?type=owner&per_page=100`);
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) throw new Error(`No GitHub org or user named "${org}".`);
    throw error;
  }
}

function globToRegExp(glob: string): RegExp {
  const body = glob.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}$`, 'i');
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/** Scans every repo of a GitHub org or user without cloning, fetching only the files parsers read. */
export async function scanGitHub(options: GitHubScanOptions): Promise<GitHubScanResult> {
  const token = options.token ?? findToken();
  const client = new GitHubClient(options.fetch ?? fetch, options.apiUrl ?? 'https://api.github.com', token);
  const rawUrl = (options.rawUrl ?? 'https://raw.githubusercontent.com').replace(/\/+$/, '');
  const cacheDir = options.cacheDir === false ? undefined : (options.cacheDir ?? defaultCacheDir());
  const patterns = options.match?.map(globToRegExp);
  const warnings: ScanWarning[] = [];
  const stats = { repos: 0, skipped: 0, apiRequests: 0, downloads: 0, cacheHits: 0 };

  const all = await listRepos(client, options.org);
  const selected = all
    .filter((r) => (options.includeForks || !r.fork) && (options.includeArchived || !r.archived))
    .filter((r) => !patterns || patterns.some((p) => p.test(r.name)))
    .sort((a, b) => a.name.localeCompare(b.name));
  stats.repos = selected.length;
  stats.skipped = all.length - selected.length;

  const readBlob = async (repo: ApiRepo, path: string, sha: string): Promise<string> => {
    const cached = cacheDir && join(cacheDir, 'blobs', sha.slice(0, 2), sha);
    if (cached && existsSync(cached)) {
      stats.cacheHits++;
      return readFileSync(cached, 'utf8');
    }
    const url = `${rawUrl}/${repo.full_name}/refs/heads/${encodePath(repo.default_branch)}/${encodePath(path)}`;
    const content = await (await client.get(url, false)).text();
    stats.downloads++;
    if (cached) {
      mkdirSync(join(cacheDir, 'blobs', sha.slice(0, 2)), { recursive: true });
      writeFileSync(cached, content);
    }
    return content;
  };

  /** File listings change only when someone pushes, so they are cached until `pushed_at` moves. */
  const readTree = async (repo: ApiRepo): Promise<ApiTree> => {
    const cached = cacheDir && repo.pushed_at && join(cacheDir, 'trees', `${repo.full_name.replace('/', '__')}.json`);
    if (cached && existsSync(cached)) {
      const entry = JSON.parse(readFileSync(cached, 'utf8')) as { pushedAt: string; branch: string; tree: ApiTree };
      if (entry.pushedAt === repo.pushed_at && entry.branch === repo.default_branch) return entry.tree;
    }
    const tree = await client.json<ApiTree>(`/repos/${repo.full_name}/git/trees/${encodeURIComponent(repo.default_branch)}?recursive=1`);
    if (cached) {
      mkdirSync(join(cacheDir, 'trees'), { recursive: true });
      writeFileSync(cached, JSON.stringify({ pushedAt: repo.pushed_at, branch: repo.default_branch, tree }));
    }
    return tree;
  };

  const loaded: LoadedRepo[] = [];
  let done = 0;
  await pool(selected, options.concurrency ?? 6, async (apiRepo) => {
    const repo: RepoInfo = {
      id: apiRepo.full_name.toLowerCase(),
      owner: apiRepo.owner.login.toLowerCase(),
      name: apiRepo.name.toLowerCase(),
      path: apiRepo.full_name,
    };
    const files: LoadedRepo['files'] = [];
    loaded.push({ repo, files });

    try {
      const tree = await readTree(apiRepo);
      if (tree.truncated) {
        warnings.push({ repo: repo.id, file: '', message: 'repo is too large for one tree request; some files were not scanned' });
      }
      const wanted = tree.tree.filter((e) => e.type === 'blob' && (e.size ?? 0) <= MAX_FILE_BYTES && wantsFile(e.path, options));
      await pool(wanted, 4, async (entry) => {
        try {
          const content = await readBlob(apiRepo, entry.path, entry.sha);
          files.push({ path: entry.path, read: () => content });
        } catch (error) {
          warnings.push({ repo: repo.id, file: entry.path, message: (error as Error).message });
        }
      });
      files.sort((a, b) => a.path.localeCompare(b.path));
    } catch (error) {
      // 409 means the repo is empty.
      if (!(error instanceof GitHubError && error.status === 409)) {
        if (!(error instanceof GitHubError)) throw error;
        warnings.push({ repo: repo.id, file: '', message: error.message });
      }
    }
    options.onProgress?.(++done, selected.length);
  });

  loaded.sort((a, b) => a.repo.id.localeCompare(b.repo.id));
  stats.apiRequests = client.requests;
  return { ...scanRepos(loaded, options, warnings), stats };
}
