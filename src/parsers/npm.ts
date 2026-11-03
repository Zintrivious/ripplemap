import type { Parser, Production, Usage } from '../types.ts';
import { basename, lineAt } from '../util.ts';

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;

export const npmParser: Parser = {
  id: 'npm',

  matches(file) {
    return basename(file) === 'package.json';
  },

  parse({ file, content }) {
    const pkg = JSON.parse(content) as Record<string, unknown>;
    const uses: Usage[] = [];
    const produces: Production[] = [];

    if (typeof pkg.name === 'string') {
      produces.push({ kind: 'npm', name: pkg.name, location: { file, line: lineAt(content, content.indexOf('"name"')) } });
    }

    for (const field of DEPENDENCY_FIELDS) {
      const deps = pkg[field];
      if (!deps || typeof deps !== 'object') continue;
      const fieldOffset = content.indexOf(`"${field}"`);
      for (const [name, version] of Object.entries(deps as Record<string, unknown>)) {
        if (typeof version !== 'string') continue;
        const offset = content.indexOf(`"${name}"`, fieldOffset);
        uses.push({ kind: 'npm', name, version: version || '*', location: { file, line: lineAt(content, Math.max(offset, 0)) } });
      }
    }

    return { uses, produces };
  },
};
