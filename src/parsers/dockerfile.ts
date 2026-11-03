import { parseImageRef } from '../refs.ts';
import type { Parser, Usage } from '../types.ts';
import { basename } from '../util.ts';

/** Joins backslash-continued lines, keeping the line number each instruction starts on. */
function* logicalLines(content: string): Generator<{ text: string; line: number }> {
  const lines = content.split(/\r?\n/);
  let buffer = '';
  let start = 1;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (!buffer) start = i + 1;
    if (raw.endsWith('\\')) {
      buffer += raw.slice(0, -1) + ' ';
      continue;
    }
    yield { text: buffer + raw, line: start };
    buffer = '';
  }
  if (buffer) yield { text: buffer, line: start };
}

function substitute(value: string, args: Map<string, string>): string {
  return value
    .replace(/\$\{(\w+)(?::?-([^}]*))?\}/g, (whole, name: string, fallback?: string) => args.get(name) ?? fallback ?? whole)
    .replace(/\$(\w+)/g, (whole, name: string) => args.get(name) ?? whole);
}

function unquote(value: string): string {
  return value.replace(/^(["'])(.*)\1$/, '$2');
}

export const dockerfileParser: Parser = {
  id: 'dockerfile',

  matches(file) {
    const name = basename(file).toLowerCase();
    return name === 'dockerfile' || name === 'containerfile' || name.startsWith('dockerfile.') || name.endsWith('.dockerfile');
  },

  parse({ file, content }) {
    const uses: Usage[] = [];
    const stages = new Set<string>();
    const args = new Map<string, string>();
    let seenFrom = false;

    const addImage = (raw: string, line: number) => {
      const image = parseImageRef(substitute(raw, args));
      if (image) uses.push({ kind: 'image', ...image, location: { file, line } });
    };

    for (const { text, line } of logicalLines(content)) {
      const match = /^\s*(\w+)\s+(.*)$/.exec(text);
      if (!match || text.trimStart().startsWith('#')) continue;
      const instruction = match[1]!.toUpperCase();
      const rest = match[2]!.trim();

      // Only ARGs before the first FROM can be used in FROM lines.
      if (instruction === 'ARG' && !seenFrom) {
        const arg = /^([A-Za-z_]\w*)=(.*)$/.exec(rest);
        if (arg) args.set(arg[1]!, unquote(arg[2]!.trim()));
        continue;
      }

      if (instruction === 'FROM') {
        seenFrom = true;
        const tokens = rest.split(/\s+/).filter((t) => !t.startsWith('--'));
        const image = tokens[0];
        if (!image) continue;
        const resolved = substitute(image, args).toLowerCase();
        if (resolved !== 'scratch' && !stages.has(resolved)) addImage(image, line);
        const as = tokens.findIndex((t) => t.toLowerCase() === 'as');
        if (as !== -1 && tokens[as + 1]) stages.add(tokens[as + 1]!.toLowerCase());
        continue;
      }

      if (instruction === 'COPY') {
        const from = /--from=(\S+)/.exec(rest)?.[1];
        if (!from) continue;
        const resolved = substitute(from, args).toLowerCase();
        // --from can name a stage, a stage index, or an image.
        if (!stages.has(resolved) && !/^\d+$/.test(resolved) && /[/:]/.test(resolved)) addImage(from, line);
      }
    }

    return { uses, produces: [] };
  },
};
