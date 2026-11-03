import { parseModuleSource } from '../refs.ts';
import type { Parser, Usage } from '../types.ts';
import { lineAt } from '../util.ts';

/** Offset of the `}` that closes the block opened just before `start`, skipping braces inside strings. */
function blockEnd(content: string, start: number): number {
  let depth = 1;
  let inString = false;
  for (let i = start; i < content.length; i++) {
    const ch = content[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}' && --depth === 0) {
      return i;
    }
  }
  return content.length;
}

export const terraformParser: Parser = {
  id: 'terraform',

  matches(file) {
    return file.endsWith('.tf');
  },

  parse({ file, content }) {
    const uses: Usage[] = [];
    // Anchored to the line start so commented-out modules (# or //) are skipped.
    const moduleBlock = /^[ \t]*module\s+"[^"]*"\s*\{/gm;
    for (const match of content.matchAll(moduleBlock)) {
      const bodyStart = match.index + match[0].length;
      const body = content.slice(bodyStart, blockEnd(content, bodyStart));
      const source = /^\s*source\s*=\s*"([^"]+)"/m.exec(body)?.[1];
      if (!source) continue;
      const version = /^\s*version\s*=\s*"([^"]+)"/m.exec(body)?.[1];
      const ref = parseModuleSource(source, version);
      if (ref) uses.push({ ...ref, location: { file, line: lineAt(content, match.index) } });
    }
    return { uses, produces: [] };
  },
};
