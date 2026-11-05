import { RateLimitError, scanGitHubApi, type ApiTree, type ScanCache } from './github-api.ts';
import { reportData, type ReportData } from './report-data.ts';

// Entry point of the scanner bundled for the website (docs/assets/scanner.js).
// It runs the same parsers and linking as the CLI, in the visitor's browser.

export { RateLimitError };

export interface WebScanOptions {
  org: string;
  /** Optional. Without one GitHub allows 60 API requests an hour per visitor. */
  token?: string;
  /** Glob patterns for repo names, like the CLI's --match. */
  match?: string[];
  exclude?: string[];
  signal?: AbortSignal;
  onListed?: (info: { repos: number; rateRemaining?: number; authenticated: boolean }) => void | Promise<void>;
  onProgress?: (done: number, total: number) => void;
}

export interface WebScanResult {
  data: ReportData;
  stats: { repos: number; skipped: number; apiRequests: number; downloads: number; cacheHits: number };
  warnings: { repo: string; file: string; message: string }[];
}

/** Kept for the life of the page, so scanning a second org that shares files is faster. */
const blobs = new Map<string, string>();
const trees = new Map<string, ApiTree>();
const memoryCache: ScanCache = {
  getBlob: (sha) => blobs.get(sha),
  setBlob: (sha, content) => void blobs.set(sha, content),
  getTree: (repo, pushedAt, branch) => trees.get(`${repo}\0${pushedAt}\0${branch}`),
  setTree: (repo, pushedAt, branch, tree) => void trees.set(`${repo}\0${pushedAt}\0${branch}`, tree),
};

export async function scanOrg(options: WebScanOptions): Promise<WebScanResult> {
  const result = await scanGitHubApi({
    org: options.org,
    token: options.token || undefined,
    match: options.match,
    exclude: options.exclude,
    cache: memoryCache,
    // raw.githubusercontent.com rejects cross-origin requests with headers, so only public repos can be read.
    rawHeaders: false,
    publicOnly: true,
    concurrency: 6,
    fetch: (input, init) => fetch(input, { ...init, signal: options.signal }),
    onListed: options.onListed,
    onProgress: options.onProgress,
  });
  result.graph.source = `github.com/${options.org}`;
  return { data: reportData(result.graph), stats: result.stats, warnings: result.warnings };
}
