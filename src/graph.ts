import { guessImageRepo } from './refs.ts';
import type { ArtifactKind, Graph, Link, RepoInfo, RepoProduction, RepoUsage } from './types.ts';

const key = (kind: ArtifactKind, name: string) => `${kind}\0${name}`;

class RepoIndex {
  private byId = new Map<string, RepoInfo>();
  private byName = new Map<string, RepoInfo[]>();

  constructor(repos: RepoInfo[]) {
    for (const repo of repos) {
      this.byId.set(repo.id, repo);
      this.byName.set(repo.name, [...(this.byName.get(repo.name) ?? []), repo]);
    }
  }

  /** Finds "owner/name". Falls back to the name alone when exactly one repo has it and its owner is unknown. */
  find(owner: string | undefined, name: string): RepoInfo | undefined {
    const exact = owner ? this.byId.get(`${owner}/${name}`) : undefined;
    if (exact) return exact;
    const candidates = (this.byName.get(name) ?? []).filter((r) => !owner || !r.owner);
    return candidates.length === 1 ? candidates[0] : undefined;
  }
}

function splitHint(hint: string): [string | undefined, string] {
  const slash = hint.lastIndexOf('/');
  return slash === -1 ? [undefined, hint] : [hint.slice(0, slash), hint.slice(slash + 1)];
}

/** Connects each usage to the scanned repo that produces it, if any. */
export function buildLinks(repos: RepoInfo[], usages: RepoUsage[], produces: RepoProduction[]): Link[] {
  const index = new RepoIndex(repos);
  const producers = new Map<string, Set<string>>();
  for (const p of produces) {
    const k = key(p.kind, p.name);
    producers.set(k, (producers.get(k) ?? new Set()).add(p.repo));
  }

  const links: Link[] = [];
  for (const usage of usages) {
    const targets: { repo: string; confidence: Link['confidence'] }[] = [];

    if (usage.repoHint) {
      const repo = index.find(...splitHint(usage.repoHint));
      if (repo) targets.push({ repo: repo.id, confidence: usage.hintConfidence ?? 'exact' });
    }
    if (!targets.length) {
      for (const repo of producers.get(key(usage.kind, usage.name)) ?? []) targets.push({ repo, confidence: 'declared' });
    }
    if (!targets.length && usage.kind === 'image') {
      const guess = guessImageRepo(usage.name);
      const repo = guess && index.find(guess.owner, guess.name);
      if (repo) targets.push({ repo: repo.id, confidence: 'convention' });
    }

    for (const target of targets) {
      if (target.repo === usage.repo) continue;
      links.push({
        from: usage.repo,
        to: target.repo,
        kind: usage.kind,
        name: usage.name,
        version: usage.version,
        location: usage.location,
        confidence: target.confidence,
      });
    }
  }
  return links;
}

/** Resolves a repo argument like "api" or "acme/api". Throws with suggestions if it is unknown or ambiguous. */
export function findRepo(graph: Graph, arg: string): RepoInfo {
  const wanted = arg.toLowerCase().replace(/\/+$/, '');
  const exact = graph.repos.find((r) => r.id === wanted);
  if (exact) return exact;
  const byName = graph.repos.filter((r) => r.name === wanted || r.id.endsWith(`/${wanted}`));
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) throw new Error(`"${arg}" matches several repos: ${byName.map((r) => r.id).join(', ')}`);
  const close = graph.repos.filter((r) => r.id.includes(wanted)).map((r) => r.id);
  throw new Error(`No repo named "${arg}" in the graph.${close.length ? ` Did you mean: ${close.slice(0, 5).join(', ')}?` : ''}`);
}

export interface ImpactEntry {
  repo: string;
  depth: number;
  /** The repo this one depends on, one step closer to the target. */
  parent: string;
  /** Every link from `repo` to `parent`. */
  links: Link[];
}

/** Every repo that depends on `target`, directly or through other repos, in breadth-first order. */
export function impact(graph: Graph, target: string): ImpactEntry[] {
  const consumers = new Map<string, Map<string, Link[]>>();
  for (const link of graph.links) {
    const byConsumer = consumers.get(link.to) ?? new Map<string, Link[]>();
    byConsumer.set(link.from, [...(byConsumer.get(link.from) ?? []), link]);
    consumers.set(link.to, byConsumer);
  }

  const entries: ImpactEntry[] = [];
  const seen = new Set([target]);
  let frontier = [target];
  for (let depth = 1; frontier.length; depth++) {
    const next: string[] = [];
    for (const producer of frontier) {
      for (const [repo, links] of consumers.get(producer) ?? []) {
        if (seen.has(repo)) continue;
        seen.add(repo);
        entries.push({ repo, depth, parent: producer, links });
        next.push(repo);
      }
    }
    frontier = next.sort();
  }
  return entries;
}

export interface DriftEntry {
  kind: ArtifactKind;
  name: string;
  /** Repos that produce this artifact. Empty for third-party artifacts. */
  producers: string[];
  versions: { version: string; usages: RepoUsage[] }[];
  repoCount: number;
}

/** Newest first for version-like strings (1.4, v2, ^2.1.0); anything else (latest, main, SHAs) after them. */
function compareVersionsDesc(a: string, b: string): number {
  const numeric = (v: string) => /^[\^~>=v\s]*\d/.test(v);
  if (numeric(a) !== numeric(b)) return numeric(a) ? -1 : 1;
  const strip = (v: string) => v.replace(/^[\^~>=v\s]+/, '');
  return strip(b).localeCompare(strip(a), undefined, { numeric: true });
}

export interface DriftOptions {
  /** Only artifacts produced by a scanned repo. */
  internalOnly?: boolean;
  kinds?: ArtifactKind[];
}

/**
 * Artifacts used at more than one version across the scanned repos.
 * Third-party npm packages are left out: lockfile tools already cover them and they would drown everything else.
 */
export function drift(graph: Graph, options: DriftOptions = {}): DriftEntry[] {
  const producers = new Map<string, Set<string>>();
  for (const link of graph.links) {
    const k = key(link.kind, link.name);
    producers.set(k, (producers.get(k) ?? new Set()).add(link.to));
  }

  const groups = new Map<string, Map<string, RepoUsage[]>>();
  for (const usage of graph.usages) {
    if (options.kinds && !options.kinds.includes(usage.kind)) continue;
    const k = key(usage.kind, usage.name);
    // A repo pinning an old release of itself (often in examples/) is not drift between repos.
    if (producers.get(k)?.has(usage.repo)) continue;
    const versions = groups.get(k) ?? new Map<string, RepoUsage[]>();
    versions.set(usage.version, [...(versions.get(usage.version) ?? []), usage]);
    groups.set(k, versions);
  }

  const entries: DriftEntry[] = [];
  for (const [k, versions] of groups) {
    if (versions.size < 2) continue;
    const [kind, name] = k.split('\0') as [ArtifactKind, string];
    const internal = [...(producers.get(k) ?? [])].sort();
    if ((options.internalOnly || kind === 'npm') && !internal.length) continue;
    const all = [...versions.values()].flat();
    entries.push({
      kind,
      name,
      producers: internal,
      versions: [...versions]
        .map(([version, usages]) => ({ version, usages }))
        .sort((a, b) => compareVersionsDesc(a.version, b.version)),
      repoCount: new Set(all.map((u) => u.repo)).size,
    });
  }

  return entries.sort(
    (a, b) =>
      Number(b.producers.length > 0) - Number(a.producers.length > 0) ||
      b.repoCount - a.repoCount ||
      a.name.localeCompare(b.name),
  );
}

/** Repos with the most distinct direct consumers. */
export function mostDependedOn(graph: Graph, limit = 5): { repo: string; consumers: number }[] {
  const consumers = new Map<string, Set<string>>();
  for (const link of graph.links) consumers.set(link.to, (consumers.get(link.to) ?? new Set()).add(link.from));
  return [...consumers]
    .map(([repo, set]) => ({ repo, consumers: set.size }))
    .sort((a, b) => b.consumers - a.consumers || a.repo.localeCompare(b.repo))
    .slice(0, limit);
}
