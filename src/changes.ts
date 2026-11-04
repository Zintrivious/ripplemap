import { isUnpinned } from './graph.ts';
import type { ArtifactKind, Graph, Link } from './types.ts';

/**
 * Files that never change what other repos consume: docs, tests, examples, repo housekeeping.
 * requirements*.txt is a .txt file that does matter, so it is checked first.
 */
const IGNORED = [
  /(^|\/)(docs?|examples?|tests?|__tests__|spec|testdata|fixtures?)\//i,
  /\.(md|mdx|rst|adoc)$/i,
  /(^|\/)(LICEN[CS]E|NOTICE|CHANGELOG|AUTHORS|CODEOWNERS)(\.\w+)?$/i,
  /(_test\.go|\.(test|spec)\.[cm]?[jt]sx?)$/,
  /(^|\/)\.(gitignore|gitattributes|editorconfig|prettierrc[\w.]*|markdownlint[\w.]*)$/,
  /^\.github\/(ISSUE_TEMPLATE|PULL_REQUEST_TEMPLATE|DISCUSSION_TEMPLATE)/i,
  /^\.github\/(dependabot|renovate|labeler|release-drafter|stale|FUNDING)\.ya?ml$/i,
];

export const isIgnoredChange = (file: string) => !/(^|\/)requirements[^/]*\.(txt|in)$/.test(file) && IGNORED.some((re) => re.test(file));

/** Kinds of dependency that pass a change along: a reusable workflow calling an action counts as one chain. */
const FAMILY: Record<ArtifactKind, string> = {
  image: 'image',
  'terraform-module': 'terraform',
  workflow: 'ci',
  action: 'ci',
  npm: 'npm',
  'helm-chart': 'helm',
  go: 'go',
  python: 'python',
  pipeline: 'ci',
};

/** The part of a repo an artifact is built from: one file, a folder, or (dir "") the whole repo. */
interface Scope {
  file?: string;
  dir?: string;
}

function scopeOf(graph: Graph, repo: string, kind: ArtifactKind, name: string): Scope {
  switch (kind) {
    case 'workflow':
      // owner/repo/.github/workflows/build.yml
      return { file: name.split('/').slice(2).join('/') };
    case 'pipeline':
      // org/project/repo//templates/build.yml
      return { file: name.split('//')[1] ?? '' };
    case 'action':
      // owner/repo or owner/repo/path/to/action
      return { dir: name.split('/').slice(2).join('/') };
    case 'terraform-module':
      // github.com/acme/modules//vpc, or a whole-repo module with no //subdir
      return { dir: name.split('//')[1] ?? '' };
    case 'image':
      // The build context isn't known, so any change to the repo can change the image.
      return { dir: '' };
    default: {
      // npm, Python, Go and Helm: the folder holding the manifest that declares the package.
      const producer = graph.produces.find((p) => p.repo === repo && p.kind === kind && p.name === name);
      const file = producer?.location.file ?? '';
      return { dir: file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '' };
    }
  }
}

const touches = (scope: Scope, file: string) =>
  scope.file !== undefined ? file === scope.file : scope.dir === '' || file.startsWith(`${scope.dir}/`);

export interface Consumer {
  repo: string;
  links: Link[];
  /** Pins nothing (latest, @main...), so it picks up the change as soon as it merges. */
  unpinned: boolean;
}

export interface ChangedArtifact {
  kind: ArtifactKind;
  name: string;
  /** The changed files that touch it. */
  files: string[];
  consumers: Consumer[];
}

export interface ChangeImpact {
  repo: string;
  /** Whether `repo` was part of the scan at all. */
  scanned: boolean;
  /** Changed files that can affect consumers. */
  relevant: string[];
  /** Changed files skipped as docs, tests or examples. */
  ignored: string[];
  artifacts: ChangedArtifact[];
  /** Repos that use a changed artifact, sorted. */
  direct: string[];
  /** Repos that depend on a directly affected repo through the same kind of dependency, breadth-first. */
  indirect: { repo: string; depth: number; via: string; kind: ArtifactKind }[];
  /** Things this repo produces that others use, but that this change doesn't touch. */
  untouched: { kind: ArtifactKind; name: string; consumers: number }[];
}

/** Which repos a change to `files` in `repo` may affect, and through what. */
export function changeImpact(graph: Graph, repo: string, files: string[]): ChangeImpact {
  const unique = [...new Set(files.map((f) => f.trim().replace(/^\.?\//, '')).filter(Boolean))].sort();
  const relevant = unique.filter((f) => !isIgnoredChange(f));
  const ignored = unique.filter((f) => isIgnoredChange(f));
  const scanned = graph.repos.some((r) => r.id === repo);

  const byArtifact = new Map<string, Link[]>();
  for (const link of graph.links) {
    if (link.to !== repo) continue;
    const k = `${link.kind}\0${link.name}`;
    byArtifact.set(k, [...(byArtifact.get(k) ?? []), link]);
  }

  const artifacts: ChangedArtifact[] = [];
  const untouched: ChangeImpact['untouched'] = [];
  for (const [k, links] of byArtifact) {
    const [kind, name] = k.split('\0') as [ArtifactKind, string];
    const scope = scopeOf(graph, repo, kind, name);
    const touched = relevant.filter((f) => touches(scope, f));
    const consumersByRepo = new Map<string, Link[]>();
    for (const link of links) consumersByRepo.set(link.from, [...(consumersByRepo.get(link.from) ?? []), link]);
    if (!touched.length) {
      untouched.push({ kind, name, consumers: consumersByRepo.size });
      continue;
    }
    artifacts.push({
      kind,
      name,
      files: touched,
      consumers: [...consumersByRepo]
        .map(([from, ls]) => ({ repo: from, links: ls, unpinned: ls.some((l) => isUnpinned(l.version)) }))
        .sort((a, b) => Number(b.unpinned) - Number(a.unpinned) || a.repo.localeCompare(b.repo)),
    });
  }
  artifacts.sort((a, b) => b.consumers.length - a.consumers.length || a.name.localeCompare(b.name));
  untouched.sort((a, b) => b.consumers - a.consumers || a.name.localeCompare(b.name));

  const direct = [...new Set(artifacts.flatMap((a) => a.consumers.map((c) => c.repo)))].sort();

  // Downstream of the directly affected repos, following only the same kind of dependency.
  // A new base image changes every image built on it, and a library change reaches libraries
  // built on that library. But a Terraform module change doesn't alter the container image of
  // a repo that uses the module, so it stops there instead of alarming that image's users.
  const consumersOf = new Map<string, Link[]>();
  for (const link of graph.links) consumersOf.set(link.to, [...(consumersOf.get(link.to) ?? []), link]);
  const seen = new Set([repo, ...direct]);
  const indirect: ChangeImpact['indirect'] = [];
  let frontier = artifacts.flatMap((a) => a.consumers.map((c) => ({ repo: c.repo, family: FAMILY[a.kind] })));
  for (let depth = 2; frontier.length; depth++) {
    const next: typeof frontier = [];
    for (const { repo: producer, family } of frontier) {
      const links = (consumersOf.get(producer) ?? []).filter((l) => FAMILY[l.kind] === family).sort((a, b) => a.from.localeCompare(b.from));
      for (const link of links) {
        if (seen.has(link.from)) continue;
        seen.add(link.from);
        indirect.push({ repo: link.from, depth, via: producer, kind: link.kind });
        next.push({ repo: link.from, family });
      }
    }
    frontier = next;
  }

  return { repo, scanned, relevant, ignored, artifacts, direct, indirect, untouched };
}
