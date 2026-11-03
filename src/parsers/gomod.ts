import type { Parser, Production, Usage } from '../types.ts';
import { basename } from '../util.ts';

/** github.com/acme/utils/v2/log → acme/utils: the repo a module path lives in, when the host is a known forge. */
export function goModuleRepo(path: string): string | undefined {
  const parts = path.toLowerCase().split('/');
  if (!/^(github\.com|gitlab\.com|bitbucket\.org)$/.test(parts[0] ?? '') || !parts[1] || !parts[2]) return undefined;
  return `${parts[1]}/${parts[2]}`;
}

/**
 * go.mod: the module a repo publishes, and its direct requirements.
 * `// indirect` requirements are skipped: they're dependencies of dependencies,
 * which ripplemap finds on its own when it follows the chain.
 */
export const goModParser: Parser = {
  id: 'go',

  matches(file) {
    return basename(file) === 'go.mod';
  },

  parse({ file, content }) {
    const uses: Usage[] = [];
    const produces: Production[] = [];
    let inRequire = false;

    content.split(/\r?\n/).forEach((raw, i) => {
      const line = i + 1;
      const text = raw.replace(/\/\/.*$/, '').trim();
      const indirect = /\/\/\s*indirect\b/.test(raw);

      const module = /^module\s+"?([^\s"]+)"?/.exec(text);
      if (module) {
        produces.push({ kind: 'go', name: module[1]!.toLowerCase(), location: { file, line } });
        return;
      }
      if (/^require\s*\($/.test(text)) {
        inRequire = true;
        return;
      }
      if (inRequire && text === ')') {
        inRequire = false;
        return;
      }

      const requirement = inRequire ? /^"?([^\s"]+)"?\s+(\S+)/.exec(text) : /^require\s+"?([^\s"(]+)"?\s+(\S+)/.exec(text);
      if (!requirement || indirect) return;
      const name = requirement[1]!.toLowerCase();
      const repo = goModuleRepo(name);
      uses.push({
        kind: 'go',
        name,
        version: requirement[2]!,
        ...(repo ? { repoHint: repo, hintConfidence: 'exact' as const } : {}),
        location: { file, line },
      });
    });

    return { uses, produces };
  },
};
