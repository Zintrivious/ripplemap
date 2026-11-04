import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultCacheDir, globToRegExp, pool, type GitHubScanResult } from './github.ts';
import { MAX_FILE_BYTES, scanRepos, skipDir, wantsFile, type LoadedRepo, type ScanOptions, type ScanWarning } from './scan.ts';
import type { RepoInfo } from './types.ts';

export interface AzureScanOptions extends Omit<ScanOptions, 'owner'> {
  /** Azure DevOps organization: the "contoso" in dev.azure.com/contoso. */
  org: string;
  /** Projects to scan. Defaults to every project, which needs a token; public projects can be named without one. */
  projects?: string[];
  /** Glob patterns matched against repo names. */
  match?: string[];
  includeForks?: boolean;
  /** A personal access token with Code (read) scope. Defaults to AZURE_DEVOPS_TOKEN, AZURE_DEVOPS_EXT_PAT or SYSTEM_ACCESSTOKEN. */
  token?: string;
  cacheDir?: string | false;
  fetch?: typeof fetch;
  baseUrl?: string;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

export type AzureScanResult = GitHubScanResult;

interface AdoRepo {
  id: string;
  name: string;
  project: { name: string };
  defaultBranch?: string;
  isDisabled?: boolean;
  isFork?: boolean;
  webUrl: string;
}

interface AdoItem {
  objectId: string;
  gitObjectType: string;
  path: string;
}

class AzureError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Stops the whole scan: sign-in problems and throttling affect every request after them. */
class AzureFatalError extends Error {}

const SIGN_IN =
  'Azure DevOps wants you to sign in (it answers the same way for a project that doesn\'t exist). ' +
  'Set AZURE_DEVOPS_TOKEN to a personal access token with Code (read) scope, or, for a public project, check its name and pass it with --project.';

/** Which environment token to use, and how: a PAT goes in Basic auth, a pipeline's System.AccessToken as a bearer token. */
function authHeader(token?: string): string | undefined {
  if (token) return `Basic ${Buffer.from(`:${token}`).toString('base64')}`;
  const pat = process.env.AZURE_DEVOPS_TOKEN || process.env.AZURE_DEVOPS_EXT_PAT;
  if (pat) return `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;
  if (process.env.SYSTEM_ACCESSTOKEN) return `Bearer ${process.env.SYSTEM_ACCESSTOKEN}`;
  return undefined;
}

class AzureClient {
  requests = 0;
  private fetchFn: typeof fetch;
  private headers: Record<string, string>;
  readonly base: string;

  constructor(fetchFn: typeof fetch, base: string, auth?: string) {
    this.fetchFn = fetchFn;
    this.base = base.replace(/\/+$/, '');
    this.headers = { 'User-Agent': 'ripplemap', ...(auth ? { Authorization: auth } : {}) };
  }

  async get(path: string, accept = 'application/json'): Promise<Response> {
    this.requests++;
    const sep = path.includes('?') ? '&' : '?';
    // Unauthenticated requests to private resources are redirected to a sign-in page.
    const res = await this.fetchFn(`${this.base}${path}${sep}api-version=7.1`, { headers: { ...this.headers, Accept: accept }, redirect: 'manual' });
    if (res.status === 429) {
      const wait = res.headers.get('retry-after');
      throw new AzureFatalError(`Azure DevOps is throttling requests.${wait ? ` Try again in ${wait} seconds.` : ''}`);
    }
    if (res.status === 401 || res.status === 203 || (res.status >= 300 && res.status < 400)) throw new AzureFatalError(SIGN_IN);
    if (!res.ok) throw new AzureError(res.status, `Azure DevOps returned ${res.status} for ${path.split('?')[0]}`);
    if (accept === 'application/json' && !(res.headers.get('content-type') ?? '').includes('json')) throw new AzureFatalError(SIGN_IN);
    return res;
  }

  async json<T>(path: string): Promise<T> {
    return (await this.get(path)).json() as Promise<T>;
  }

  /** Follows x-ms-continuationtoken across pages. */
  async list<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    let token: string | null = null;
    do {
      const sep = path.includes('?') ? '&' : '?';
      const res = await this.get(token ? `${path}${sep}continuationToken=${encodeURIComponent(token)}` : path);
      items.push(...((await res.json()) as { value: T[] }).value);
      token = res.headers.get('x-ms-continuationtoken');
    } while (token);
    return items;
  }
}

const enc = encodeURIComponent;

/** Scans every repo of an Azure DevOps organization without cloning, fetching only the files parsers read. */
export async function scanAzure(options: AzureScanOptions): Promise<AzureScanResult> {
  const client = new AzureClient(options.fetch ?? fetch, options.baseUrl ?? `https://dev.azure.com/${enc(options.org)}`, authHeader(options.token));
  const cacheDir = options.cacheDir === false ? undefined : (options.cacheDir ?? defaultCacheDir());
  const patterns = options.match?.map(globToRegExp);
  const warnings: ScanWarning[] = [];
  const stats = { repos: 0, skipped: 0, apiRequests: 0, downloads: 0, cacheHits: 0 };

  const projects = options.projects?.length
    ? options.projects
    : (await client.list<{ name: string }>('/_apis/projects?$top=500')).map((p) => p.name);

  const all: AdoRepo[] = [];
  for (const project of projects) {
    try {
      all.push(...(await client.list<AdoRepo>(`/${enc(project)}/_apis/git/repositories`)));
    } catch (error) {
      if (error instanceof AzureError && error.status === 404) throw new Error(`No Azure DevOps project named "${project}" in ${options.org}.`);
      throw error;
    }
  }
  const selected = all
    .filter((r) => !r.isDisabled && (options.includeForks || !r.isFork))
    .filter((r) => !patterns || patterns.some((p) => p.test(r.name)))
    .sort((a, b) => `${a.project.name}/${a.name}`.localeCompare(`${b.project.name}/${b.name}`));
  stats.repos = selected.length;
  stats.skipped = all.length - selected.length;

  const repoPath = (repo: AdoRepo) => `/${enc(repo.project.name)}/_apis/git/repositories/${repo.id}`;

  const readBlob = async (repo: AdoRepo, objectId: string): Promise<string> => {
    const cached = cacheDir && join(cacheDir, 'blobs', objectId.slice(0, 2), objectId);
    if (cached && existsSync(cached)) {
      stats.cacheHits++;
      return readFileSync(cached, 'utf8');
    }
    const content = await (await client.get(`${repoPath(repo)}/blobs/${objectId}?$format=text`, 'text/plain')).text();
    stats.downloads++;
    if (cached) {
      mkdirSync(join(cacheDir, 'blobs', objectId.slice(0, 2)), { recursive: true });
      writeFileSync(cached, content);
    }
    return content;
  };

  /** The file list at the branch's head commit, cached per commit. */
  const readItems = async (repo: AdoRepo, branch: string): Promise<AdoItem[] | null> => {
    const refs = await client.json<{ value: { objectId: string }[] }>(`${repoPath(repo)}/refs?filter=heads/${enc(branch)}`);
    const commit = refs.value[0]?.objectId;
    if (!commit) return null;
    const cached = cacheDir && join(cacheDir, 'trees', `ado__${repo.id}__${commit}.json`);
    if (cached && existsSync(cached)) return JSON.parse(readFileSync(cached, 'utf8')) as AdoItem[];
    const items = await client.json<{ value: AdoItem[] }>(
      `${repoPath(repo)}/items?recursionLevel=Full&versionDescriptor.version=${commit}&versionDescriptor.versionType=commit`,
    );
    if (cached) {
      mkdirSync(join(cacheDir, 'trees'), { recursive: true });
      writeFileSync(cached, JSON.stringify(items.value));
    }
    return items.value;
  };

  const loaded: LoadedRepo[] = [];
  let done = 0;
  await pool(selected, options.concurrency ?? 6, async (adoRepo) => {
    const org = options.org.toLowerCase();
    const owner = `${org}/${adoRepo.project.name.toLowerCase()}`;
    const repo: RepoInfo = {
      id: `${owner}/${adoRepo.name.toLowerCase()}`,
      owner,
      name: adoRepo.name.toLowerCase(),
      path: `${options.org}/${adoRepo.project.name}/${adoRepo.name}`,
      url: adoRepo.webUrl,
    };
    const files: LoadedRepo['files'] = [];
    loaded.push({ repo, files });

    try {
      // A repo without a default branch is empty, so nothing is missing.
      const branch = adoRepo.defaultBranch?.replace(/^refs\/heads\//, '');
      const items = branch ? await readItems(adoRepo, branch) : [];
      const wanted = (items ?? []).filter((item) => {
        if (item.gitObjectType !== 'blob') return false;
        const path = item.path.replace(/^\//, '');
        return !path.split('/').slice(0, -1).some(skipDir) && wantsFile(path, options);
      });
      await pool(wanted, 4, async (item) => {
        const path = item.path.replace(/^\//, '');
        try {
          const content = await readBlob(adoRepo, item.objectId);
          if (content.length > MAX_FILE_BYTES) warnings.push({ repo: repo.id, file: path, message: 'skipped: larger than 32 MB' });
          else files.push({ path, read: () => content });
        } catch (error) {
          if (error instanceof AzureFatalError) throw error;
          warnings.push({ repo: repo.id, file: path, message: (error as Error).message });
        }
      });
      files.sort((a, b) => a.path.localeCompare(b.path));
    } catch (error) {
      if (error instanceof AzureFatalError) throw error;
      warnings.push({ repo: repo.id, file: '', message: (error as Error).message });
    }
    options.onProgress?.(++done, selected.length);
  });

  loaded.sort((a, b) => a.repo.id.localeCompare(b.repo.id));
  stats.apiRequests = client.requests;
  return { ...scanRepos(loaded, options, warnings), stats };
}
