import type { ChangeImpact } from './changes.ts';
import { repoNamer } from './format.ts';
import type { ArtifactKind, Graph, Link } from './types.ts';

/** Marks ripplemap's PR comment so later runs update it instead of adding another. */
export const COMMENT_MARKER = '<!-- ripplemap -->';

const KIND_NAME: Record<ArtifactKind, string> = {
  image: 'container image',
  'terraform-module': 'Terraform module',
  workflow: 'reusable workflow',
  action: 'GitHub Action',
  npm: 'npm package',
  'helm-chart': 'Helm chart',
  go: 'Go module',
  python: 'Python package',
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const code = (text: string) => `\`${text.replace(/`/g, "'")}\``;

function list(items: string[], max = 5): string {
  const shown = items.slice(0, max).map(code).join(', ');
  return items.length > max ? `${shown} and ${items.length - max} more` : shown;
}

export interface MarkdownOptions {
  version: string;
  /** Rows per table before the rest is summarized. */
  maxRows?: number;
}

/** The pull request comment: what the change touches, who uses it, and who picks it up on merge. */
export function formatChangeMarkdown(graph: Graph, impact: ChangeImpact, options: MarkdownOptions): string {
  const maxRows = options.maxRows ?? 25;
  const name = repoNamer(graph);
  const urls = new Map(graph.repos.map((r) => [r.id, r.url]));
  const repoLink = (id: string) => (urls.get(id) ? `[${cell(name(id))}](${urls.get(id)})` : cell(name(id)));
  const where = (link: Link) => {
    const label = `${link.location.file}:${link.location.line}`;
    const url = urls.get(link.from);
    return url ? `[${cell(label)}](${url}/blob/HEAD/${link.location.file}#L${link.location.line})` : cell(label);
  };
  const source = graph.source || 'the scanned repos';
  const out: string[] = [COMMENT_MARKER];

  const total = impact.direct.length + impact.indirect.length;
  if (!impact.scanned) {
    out.push('### ripplemap', '', `${code(impact.repo)} wasn't part of the scan of ${source}, so ripplemap can't tell which repos use it.`);
  } else if (!total) {
    out.push('### ripplemap: no other repos are affected', '');
    out.push(
      impact.relevant.length
        ? `No repo in ${source} uses the parts of ${code(name(impact.repo))} this pull request changes.`
        : `This pull request only changes docs, tests or examples (${list(impact.ignored)}), which other repos don't consume.`,
    );
  } else {
    const unpinned = new Set(impact.artifacts.flatMap((a) => a.consumers.filter((c) => c.unpinned).map((c) => c.repo)));
    out.push(`### ripplemap: this pull request may affect ${plural(total, 'repo')}`, '');
    const parts = [`${impact.direct.length} directly`, ...(impact.indirect.length ? [`${impact.indirect.length} through other repos`] : [])];
    let summary = `${parts.join(' and ')}.`;
    if (unpinned.size) summary += ` **${plural(unpinned.size, 'repo')} pin${unpinned.size === 1 ? 's' : ''} no version and will pick this up as soon as it merges.**`;
    out.push(summary);

    for (const artifact of impact.artifacts) {
      out.push('', `#### ${code(artifact.name)} · ${KIND_NAME[artifact.kind]}`, '', `Changed here: ${list(artifact.files)}`, '');
      out.push('| Repo | Uses | Where |', '|---|---|---|');
      for (const consumer of artifact.consumers.slice(0, maxRows)) {
        const [first, ...more] = consumer.links;
        const version = consumer.unpinned ? `${code(first!.version)} **on merge**` : code(first!.version);
        const extra = more.length ? ` +${more.length} more` : '';
        out.push(`| ${repoLink(consumer.repo)} | ${version} | ${where(first!)}${extra} |`);
      }
      if (artifact.consumers.length > maxRows) out.push(`| … and ${artifact.consumers.length - maxRows} more | | |`);
    }

    if (impact.indirect.length) {
      const rows = impact.indirect.slice(0, maxRows).map((e) => `| ${repoLink(e.repo)} | ${repoLink(e.via)} |`);
      if (impact.indirect.length > maxRows) rows.push(`| … and ${impact.indirect.length - maxRows} more | |`);
      out.push(
        '',
        `<details><summary>${plural(impact.indirect.length, 'repo')} affected through other repos</summary>`,
        '',
        '| Repo | Through |',
        '|---|---|',
        ...rows,
        '',
        '</details>',
      );
    }
  }

  if (impact.scanned && impact.untouched.length) {
    const rows = impact.untouched.slice(0, maxRows).map((u) => `- ${code(u.name)} (${KIND_NAME[u.kind]}), used by ${plural(u.consumers, 'repo')}`);
    out.push(
      '',
      `<details><summary>Not touched by this change: ${plural(impact.untouched.length, 'other thing')} this repo publishes</summary>`,
      '',
      ...rows,
      '',
      '</details>',
    );
  }

  const problems = graph.warnings?.length ?? 0;
  if (problems) {
    out.push(
      '',
      '> [!WARNING]',
      `> Incomplete scan: ${problems === 1 ? '1 file or repo' : `${problems} files or repos`} could not be read or parsed, so some affected repos may be missing.`,
    );
  }

  out.push(
    '',
    `<sub>ripplemap reads references in files; it doesn't build or test anything, so this is a list to check, not a list of breakages. ` +
      `Scanned ${plural(graph.repos.length, 'repo')} in ${source} · [ripplemap](https://github.com/Zintrivious/ripplemap) ${options.version}</sub>`,
  );
  return out.join('\n') + '\n';
}
