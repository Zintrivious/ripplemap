import { MAX_FILE_BYTES, scanRepos, skipDir, wantsFile, type LoadedRepo, type ScanOptions, type ScanResult, type ScanWarning } from './core.ts';
import type { RepoInfo } from './types.ts';

// Scanning a GitHub org through the API. No Node built-ins here: the in-browser scanner on the
// website runs this same code. github.ts adds the token lookup and the on-disk cache.

/** Where file contents and listings are kept between scans. */
export interface ScanCache {
  /** File contents by git blob SHA. */
  getBlob(sha: string): string | undefined;
  setBlob(sha: string, content: string): void;
  /** A repo's file listing, valid while `pushedAt` and `branch` stay the same. */
  getTree(repo: string, pushedAt: string, branch: string): ApiTree | undefined;
  setTree(repo: string, pushedAt: string, branch: string, tree: ApiTree): void;
}

export interface GitHubScanOptions extends Omit<ScanOptions, 'owner'> {
  /** Org or user to scan. */
  org: string;
  /** Glob patterns matched against repo names, e.g. "terraform-*". A repo is kept if any pattern matches. */
  match?: string[];
  includeForks?: boolean;
  includeArchived?: boolean;
  token?: string;
  cache?: ScanCache;
  /**
   * Send the token and User-Agent to raw.githubusercontent.com too. Browsers can't: that host
   * rejects cross-origin requests with custom headers, so the website reads public repos only.
   */
  rawHeaders?: boolean;
  /** Skip private repos, which can't be read without rawHeaders. */
  publicOnly?: boolean;
  /** Milliseconds before the first retry of a failed request. */
  retryDelay?: number;
  /** Called once the repo list is in, before any repo is read. Throw to stop the scan. */
  onListed?: (info: { repos: number; rateRemaining?: number; authenticated: boolean }) => void | Promise<void>;
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
  private?: boolean;
  full_name: string;
  owner: { login: string };
  default_branch: string;
  fork: boolean;
  archived: boolean;
  pushed_at?: string;
}

export interface ApiTree {
  tree: { path: string; type: string; sha: string; size?: number }[];
  truncated: boolean;
}

export class GitHubError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Stops the whole scan: every later request would fail the same way. */
export class RateLimitError extends Error {}

class GitHubClient {
  requests = 0;
  /** From the last API response's X-RateLimit-Remaining header. */
  rateRemaining?: number;
  readonly authenticated: boolean;
  rawHeaders = true;
  retryDelay = 400;
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
    const headers = api ? { ...this.headers, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } : this.rawHeaders ? this.headers : {};
    const res = await this.fetchRetrying(url, headers);
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (api && remaining !== null) this.rateRemaining = Number(remaining);
    if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
      const when = reset ? ` It resets at ${new Date(reset).toLocaleTimeString()}.` : '';
      const hint = this.authenticated ? '' : ' Set GITHUB_TOKEN or run "gh auth login" to get 5,000 requests an hour instead of 60.';
      throw new RateLimitError(`GitHub API rate limit reached.${when}${hint}`);
    }
    if (!res.ok) throw new GitHubError(res.status, `GitHub returned ${res.status} for ${url.replace(this.apiUrl, '')}`);
    return res;
  }

  /** GitHub, raw.githubusercontent.com especially, sometimes answers 5xx under load. Two retries, with backoff. */
  private async fetchRetrying(url: string, headers: Record<string, string>): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let res: Response | undefined;
      try {
        res = await this.fetchFn(url, { headers });
      } catch (error) {
        if (attempt >= 2 || (error as Error).name === 'AbortError') throw error;
      }
      if (res && (res.status < 500 || attempt >= 2)) return res;
      await new Promise((resolve) => setTimeout(resolve, this.retryDelay * 2 ** attempt));
    }
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

export function globToRegExp(glob: string): RegExp {
  const body = glob.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}$`, 'i');
}

export async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/** Scans every repo of a GitHub org or user without cloning, fetching only the files parsers read. */
export async function scanGitHubApi(options: GitHubScanOptions): Promise<GitHubScanResult> {
  const client = new GitHubClient(options.fetch ?? ((input, init) => fetch(input, init)), options.apiUrl ?? 'https://api.github.com', options.token);
  client.rawHeaders = options.rawHeaders ?? true;
  if (options.retryDelay !== undefined) client.retryDelay = options.retryDelay;
  const rawUrl = (options.rawUrl ?? 'https://raw.githubusercontent.com').replace(/\/+$/, '');
  const cache = options.cache;
  const patterns = options.match?.length ? options.match.map(globToRegExp) : undefined;
  const warnings: ScanWarning[] = [];
  const stats = { repos: 0, skipped: 0, apiRequests: 0, downloads: 0, cacheHits: 0 };

  const all = await listRepos(client, options.org);
  const selected = all
    .filter((r) => (options.includeForks || !r.fork) && (options.includeArchived || !r.archived) && !(options.publicOnly && r.private))
    .filter((r) => !patterns || patterns.some((p) => p.test(r.name)))
    .sort((a, b) => a.name.localeCompare(b.name));
  stats.repos = selected.length;
  stats.skipped = all.length - selected.length;
  await options.onListed?.({ repos: selected.length, rateRemaining: client.rateRemaining, authenticated: client.authenticated });

  const readBlob = async (repo: ApiRepo, path: string, sha: string): Promise<string> => {
    const cached = cache?.getBlob(sha);
    if (cached !== undefined) {
      stats.cacheHits++;
      return cached;
    }
    const url = `${rawUrl}/${repo.full_name}/refs/heads/${encodePath(repo.default_branch)}/${encodePath(path)}`;
    const content = await (await client.get(url, false)).text();
    stats.downloads++;
    cache?.setBlob(sha, content);
    return content;
  };

  /**
   * The full file list of a tree. GitHub truncates recursive listings of very large repos,
   * so when that happens this lists the folder and fetches each subfolder on its own,
   * skipping folders the scanner never reads (node_modules, vendor, dot-folders).
   */
  const listTree = async (repo: ApiRepo, ref: string, prefix: string): Promise<ApiTree> => {
    const base = `/repos/${repo.full_name}/git/trees/${encodeURIComponent(ref)}`;
    const full = await client.json<ApiTree>(`${base}?recursive=1`);
    const withPrefix = (entries: ApiTree['tree']) => entries.map((e) => ({ ...e, path: prefix + e.path }));
    if (!full.truncated) return { tree: withPrefix(full.tree), truncated: false };

    const top = await client.json<ApiTree>(base);
    const tree = withPrefix(top.tree.filter((e) => e.type !== 'tree'));
    let truncated = top.truncated;
    for (const dir of top.tree.filter((e) => e.type === 'tree' && !skipDir(e.path))) {
      const sub = await listTree(repo, dir.sha, `${prefix}${dir.path}/`);
      // Not push(...sub.tree): spreading 100k+ entries overflows the call stack.
      for (const entry of sub.tree) tree.push(entry);
      truncated ||= sub.truncated;
    }
    return { tree, truncated };
  };

  /** File listings change only when someone pushes, so they are cached until `pushed_at` moves. */
  const readTree = async (repo: ApiRepo): Promise<ApiTree> => {
    const cached = repo.pushed_at ? cache?.getTree(repo.full_name, repo.pushed_at, repo.default_branch) : undefined;
    if (cached) return cached;
    const tree = await listTree(repo, repo.default_branch, '');
    if (repo.pushed_at) cache?.setTree(repo.full_name, repo.pushed_at, repo.default_branch, tree);
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
      url: `https://github.com/${apiRepo.full_name}`,
    };
    const files: LoadedRepo['files'] = [];
    loaded.push({ repo, files });

    try {
      const tree = await readTree(apiRepo);
      if (tree.truncated) {
        warnings.push({ repo: repo.id, file: '', message: 'a folder has too many files for the GitHub API to list; some files were not scanned' });
      }
      const wanted = [];
      for (const entry of tree.tree) {
        if (entry.type !== 'blob' || !wantsFile(entry.path, options)) continue;
        if ((entry.size ?? 0) > MAX_FILE_BYTES) warnings.push({ repo: repo.id, file: entry.path, message: 'skipped: larger than 32 MB' });
        else wanted.push(entry);
      }
      await pool(wanted, 4, async (entry) => {
        try {
          const content = await readBlob(apiRepo, entry.path, entry.sha);
          files.push({ path: entry.path, read: () => content });
        } catch (error) {
          if (error instanceof RateLimitError) throw error;
          warnings.push({ repo: repo.id, file: entry.path, message: (error as Error).message });
        }
      });
      files.sort((a, b) => a.path.localeCompare(b.path));
    } catch (error) {
      // A rate limit stops everything. Anything else stays with this repo: one bad repo never ends the scan.
      if (error instanceof RateLimitError) throw error;
      // 409 means the repo is empty, so nothing is missing.
      if (!(error instanceof GitHubError && error.status === 409)) {
        warnings.push({ repo: repo.id, file: '', message: (error as Error).message });
      }
    }
    options.onProgress?.(++done, selected.length);
  });

  loaded.sort((a, b) => a.repo.id.localeCompare(b.repo.id));
  stats.apiRequests = client.requests;
  return { ...scanRepos(loaded, options, warnings), stats };
}
