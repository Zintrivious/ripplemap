// Scans the orgs suggested on the website and writes their results to docs/data.
// Run with `npm run demos` (needs a GitHub token: GITHUB_TOKEN or `gh auth login`).
// A scheduled workflow (.github/workflows/demos.yml) reruns it every week so the numbers stay current.
// Pass org names to rescan only those: `npm run demos -- linuxserver`.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { scanGitHub } from '../src/github.ts';
import { impact } from '../src/graph.ts';
import { reportData } from '../src/report-data.ts';

interface Demo {
  org: string;
  /** What the org is, in a few words. */
  about: string;
  match?: string[];
  exclude?: string[];
  /** The repo the headline is about. Defaults to the one whose change reaches the most repos. */
  feature?: string;
}

export const DEMOS: Demo[] = [
  { org: 'linuxserver', about: 'Docker images built on shared base images', feature: 'linuxserver/docker-baseimage-alpine' },
  { org: 'cloudposse', about: 'Terraform modules that call each other', match: ['terraform-*'], exclude: ['examples', 'test'] },
  { org: 'sindresorhus', about: 'Hundreds of npm packages that depend on each other', feature: 'sindresorhus/execa' },
  { org: 'actions', about: "GitHub's own actions, used in each other's workflows" },
  { org: 'fluxcd', about: 'GitOps toolkit: Go modules and shared workflows' },
  { org: 'jupyter', about: 'Python packages and their shared CI' },
];

/** The org drawn as the moving web behind the landing page's headline. */
const HERO = 'cloudposse';

const out = new URL('../docs/data/', import.meta.url);
mkdirSync(out, { recursive: true });
const indexFile = new URL('index.json', out);
const previous = existsSync(indexFile) ? (JSON.parse(readFileSync(indexFile, 'utf8')) as { orgs: Record<string, unknown>[] }).orgs : [];

const only = process.argv.slice(2);
const entries: Record<string, unknown>[] = [];
let failed = 0;
for (const demo of DEMOS) {
  if (only.length && !only.includes(demo.org)) {
    const kept = previous.find((e) => e.org === demo.org);
    if (kept) entries.push(kept);
    continue;
  }
  process.stderr.write(`${demo.org}: scanning…\n`);
  let result;
  try {
    result = await scanGitHub({ org: demo.org, match: demo.match, exclude: demo.exclude });
  } catch (error) {
    // Usually the rate limit. Keep last week's results; the cache keeps what was fetched, so the next run gets further.
    process.stderr.write(`${demo.org}: ${(error as Error).message} Keeping the previous results.\n`);
    failed++;
    const kept = previous.find((e) => e.org === demo.org);
    if (kept) entries.push(kept);
    continue;
  }
  const graph = result.graph;
  graph.source = `github.com/${demo.org}`;

  // The headline: the repo whose change reaches the most others.
  const producers = demo.feature ? [demo.feature] : [...new Set(graph.links.map((l) => l.to))];
  const top = producers
    .map((repo) => {
      const entries = impact(graph, repo);
      return { repo, affected: entries.length, direct: entries.filter((e) => e.depth === 1).length };
    })
    .sort((a, b) => b.affected - a.affected || a.repo.localeCompare(b.repo))[0];

  const data = reportData(graph);
  writeFileSync(new URL(`${demo.org}.json`, out), JSON.stringify(data));
  if (demo.org === HERO) {
    // Just the shape: short names and repo pairs, a few KB.
    const ids = [...new Set(graph.links.flatMap((l) => [l.from, l.to]))].sort();
    const at = new Map(ids.map((id, i) => [id, i]));
    const pairs = [...new Set(graph.links.map((l) => `${at.get(l.from)},${at.get(l.to)}`))].map((p) => p.split(',').map(Number));
    writeFileSync(new URL('hero.json', out), JSON.stringify({ org: demo.org, nodes: ids.map((id) => id.split('/')[1]), edges: pairs }));
  }
  entries.push({
    org: demo.org,
    about: demo.about,
    ...(demo.match ? { match: demo.match } : {}),
    repos: graph.repos.length,
    links: graph.links.length,
    kinds: [...new Set(graph.links.map((l) => l.kind))].sort(),
    drifted: data.drift.filter((d) => d.producers.length).length,
    top,
    scannedAt: graph.generatedAt,
  });
  process.stderr.write(`${demo.org}: ${graph.repos.length} repos, ${graph.links.length} links, top ${top?.repo} → ${top?.affected}\n`);
}

writeFileSync(indexFile, JSON.stringify({ orgs: entries }, null, 2) + '\n');
if (failed) process.exitCode = 1;
