import { drift } from './graph.ts';
import type { Graph } from './types.ts';

/** The data the page works from. Kept small: links and drift only, no raw usages. */
export function reportData(graph: Graph) {
  const owners = new Set(graph.repos.map((r) => r.owner));
  return {
    source: graph.source ?? '',
    generatedAt: graph.generatedAt,
    problems: graph.warnings?.length ?? 0,
    owner: owners.size === 1 ? [...owners][0]! : '',
    repos: graph.repos.map((r) => ({ id: r.id, url: r.url ?? '' })),
    links: graph.links.map((l) => ({
      from: l.from,
      to: l.to,
      kind: l.kind,
      name: l.name,
      version: l.version,
      file: l.location.file,
      line: l.location.line,
      confidence: l.confidence,
    })),
    drift: drift(graph).map((e) => ({
      kind: e.kind,
      name: e.name,
      producers: e.producers,
      versions: e.versions.map((v) => ({ version: v.version, repos: [...new Set(v.usages.map((u) => u.repo))].sort() })),
    })),
  };
}

export type ReportData = ReturnType<typeof reportData>;
