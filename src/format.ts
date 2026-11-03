import type { DriftEntry, ImpactEntry } from './graph.ts';
import type { ArtifactKind, Graph, Link } from './types.ts';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
export const bold = paint(1);
export const dim = paint(2);
export const yellow = paint(33);
export const cyan = paint(36);

const KIND_LABEL: Record<ArtifactKind, string> = {
  image: 'image',
  'terraform-module': 'module',
  workflow: 'workflow',
  action: 'action',
  npm: 'npm',
  'helm-chart': 'chart',
  go: 'go',
  python: 'python',
};

const MAX_REPOS_PER_LINE = 4;
const EXAMPLE_PATH = /(^|\/)(examples?|tests?|fixtures)\//;

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Full git SHAs are unreadable in a table; 12 characters are still unique in practice. */
const shortVersion = (version: string) => (/^[0-9a-f]{40}$/.test(version) ? version.slice(0, 12) : version);

/** Drops the "owner/" prefix when every scanned repo shares the same owner. */
export function repoNamer(graph: Graph): (id: string) => string {
  const owners = new Set(graph.repos.map((r) => r.owner));
  const [owner] = owners;
  if (owners.size !== 1 || !owner) return (id) => id;
  return (id) => (id.startsWith(`${owner}/`) ? id.slice(owner.length + 1) : id);
}

function describeLink(link: Link): string {
  const separator = link.kind === 'image' ? ':' : '@';
  const guess = link.confidence === 'convention' ? yellow(' (guessed from name)') : '';
  return `${dim(KIND_LABEL[link.kind])} ${link.name}${dim(separator)}${shortVersion(link.version)}  ${dim(`${link.location.file}:${link.location.line}`)}${guess}`;
}

function repoList(repos: string[]): string {
  if (repos.length <= MAX_REPOS_PER_LINE) return repos.join(', ');
  return `${repos.slice(0, MAX_REPOS_PER_LINE - 1).join(', ')} ${dim(`+${repos.length - MAX_REPOS_PER_LINE + 1} more`)}`;
}

export function formatImpact(graph: Graph, target: string, entries: ImpactEntry[]): string {
  const name = repoNamer(graph);
  if (!entries.length) return `Nothing in the scanned repos depends on ${bold(name(target))}.`;

  const children = new Map<string, ImpactEntry[]>();
  for (const entry of entries) children.set(entry.parent, [...(children.get(entry.parent) ?? []), entry]);

  const lines = [bold(name(target))];
  const render = (parent: string, prefix: string) => {
    const kids = (children.get(parent) ?? []).sort((a, b) => a.repo.localeCompare(b.repo));
    kids.forEach((entry, i) => {
      const last = i === kids.length - 1;
      const [first, ...more] = entry.links;
      const extra = more.length ? dim(`  +${more.length} more`) : '';
      lines.push(`${prefix}${last ? '└─' : '├─'} ${cyan(name(entry.repo))}  ${describeLink(first!)}${extra}`);
      render(entry.repo, prefix + (last ? '   ' : '│  '));
    });
  };
  render(target, '');

  const direct = entries.filter((e) => e.depth === 1).length;
  lines.push('', `${bold(plural(entries.length, 'repo'))} affected: ${direct} direct, ${entries.length - direct} indirect.`);
  return lines.join('\n');
}

export function formatDrift(graph: Graph, entries: DriftEntry[]): string {
  if (!entries.length) return 'No version drift found. Every shared artifact is used at a single version.';
  const name = repoNamer(graph);

  const blocks = entries.map((entry) => {
    const owner = entry.producers.length ? `built in ${entry.producers.map(name).join(', ')}` : 'third-party';
    const header = `${bold(entry.name)}  ${dim(`${KIND_LABEL[entry.kind]} · ${owner} · ${plural(entry.versions.length, 'version')} across ${plural(entry.repoCount, 'repo')}`)}`;
    const width = Math.max(...entry.versions.map((v) => shortVersion(v.version).length));
    const rows = entry.versions.map(({ version, usages }) => {
      const repos = [...new Set(usages.map((u) => name(u.repo)))].sort();
      return `  ${shortVersion(version).padEnd(width)}  ${repoList(repos)}`;
    });
    return [header, ...rows].join('\n');
  });

  const internal = entries.filter((e) => e.producers.length).length;
  return [
    blocks.join('\n\n'),
    '',
    `${bold(plural(entries.length, 'artifact'))} with drift (${internal} built in your repos). Use --json for full repo lists.`,
  ].join('\n');
}

export function formatScanSummary(
  graph: Graph,
  root: string,
  filesParsed: number,
  top: { repo: string; consumers: number }[],
  outFile: string,
): string {
  const name = repoNamer(graph);
  const lines = [
    `Scanned ${bold(plural(graph.repos.length, 'repo'))} in ${root} (${plural(filesParsed, 'file')} parsed).`,
    `Found ${plural(graph.usages.length, 'reference')} and ${bold(plural(graph.links.length, 'cross-repo link'))}.`,
  ];

  const fromExamples = graph.links.filter((l) => EXAMPLE_PATH.test(l.location.file)).length;
  if (fromExamples) {
    lines.push(dim(`${fromExamples} of them come from examples/ or test/ folders. Add --exclude examples --exclude test to leave those out.`));
  }

  if (top.length) {
    const width = Math.max(...top.map((t) => name(t.repo).length));
    lines.push('', 'Most depended-on repos:');
    for (const t of top) lines.push(`  ${cyan(name(t.repo).padEnd(width))}  used by ${plural(t.consumers, 'repo')}`);
  }
  lines.push('', `Wrote ${outFile}`);
  if (top[0]) lines.push('', 'Next:', `  ripplemap impact ${name(top[0].repo)}`, '  ripplemap drift');
  return lines.join('\n');
}
