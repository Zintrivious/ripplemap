import { parse as parseToml } from 'smol-toml';
import { parseRepoUrl } from '../refs.ts';
import type { Parser, Production, Usage } from '../types.ts';
import { basename, lineAt } from '../util.ts';

/** PEP 503: names compare case-insensitively, with runs of "-", "_" and "." treated as one "-". */
export const normalizePythonName = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-');

const REQUIREMENTS_FILE = /^requirements([.-][\w.-]+)?\.(txt|in)$/;

interface Requirement {
  name: string;
  version: string;
  repoHint?: string;
}

/** Parses one PEP 508 requirement: `name[extra]>=1,<2; markers` or `name @ git+https://github.com/acme/lib@v1`. */
export function parseRequirement(spec: string): Requirement | null {
  const text = spec.trim();
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$/.exec(text);
  if (!match) return null;
  const name = normalizePythonName(match[1]!);
  let rest = match[3]!.split(';')[0]!.trim();

  if (rest.startsWith('@')) {
    const url = rest.slice(1).trim().replace(/^git\+/, '');
    const at = /@([^@/]+)$/.exec(url.replace(/#.*$/, ''));
    const repo = parseRepoUrl(url.replace(/#.*$/, '').replace(/@[^@/]+$/, ''));
    return { name, version: at?.[1] ?? 'default branch', ...(repo ? { repoHint: `${repo.owner}/${repo.name}` } : {}) };
  }
  rest = rest.replace(/^\(|\)$/g, '').replace(/\s+/g, '');
  return { name, version: rest || 'unpinned' };
}

/** `git+https://github.com/acme/lib.git@v1.2#egg=lib`, a requirements.txt line without a package name in front. */
function parseUrlRequirement(line: string): Requirement | null {
  const egg = /[#&]egg=([A-Za-z0-9._-]+)/.exec(line)?.[1];
  const url = line.replace(/^git\+/, '').replace(/#.*$/, '');
  const ref = /@([^@/]+)$/.exec(url)?.[1];
  const repo = parseRepoUrl(url.replace(/@[^@/]+$/, ''));
  if (!repo) return null;
  return { name: normalizePythonName(egg ?? repo.name), version: ref ?? 'default branch', repoHint: `${repo.owner}/${repo.name}` };
}

/** Poetry writes dependencies as a table: `lib = "^1.2"` or `lib = { git = "...", tag = "v1" }`. */
function poetryRequirement(name: string, value: unknown): Requirement | null {
  if (normalizePythonName(name) === 'python') return null;
  if (typeof value === 'string') return { name: normalizePythonName(name), version: value };
  if (!value || typeof value !== 'object') return null;
  const table = value as Record<string, unknown>;
  if (typeof table.path === 'string') return null; // a local path
  if (typeof table.git === 'string') {
    const repo = parseRepoUrl(table.git);
    const ref = [table.tag, table.rev, table.branch].find((v) => typeof v === 'string') as string | undefined;
    return { name: normalizePythonName(name), version: ref ?? 'default branch', ...(repo ? { repoHint: `${repo.owner}/${repo.name}` } : {}) };
  }
  return { name: normalizePythonName(name), version: typeof table.version === 'string' ? table.version : 'unpinned' };
}

/**
 * pyproject.toml (PEP 621 [project], [dependency-groups] and Poetry) and requirements*.txt.
 * A pyproject's name is what the repo publishes; every requirement is a use.
 */
export const pythonParser: Parser = {
  id: 'python',

  matches(file) {
    const name = basename(file);
    return name === 'pyproject.toml' || REQUIREMENTS_FILE.test(name);
  },

  parse({ file, content }) {
    const uses: Usage[] = [];
    const produces: Production[] = [];
    const add = (req: Requirement | null, needle: string | RegExp) => {
      if (!req) return;
      const offset = typeof needle === 'string' ? content.indexOf(needle) : (needle.exec(content)?.index ?? -1);
      uses.push({
        kind: 'python',
        name: req.name,
        version: req.version,
        ...(req.repoHint ? { repoHint: req.repoHint, hintConfidence: 'exact' as const } : {}),
        location: { file, line: lineAt(content, Math.max(offset, 0)) },
      });
    };

    if (basename(file) !== 'pyproject.toml') {
      for (const raw of content.split(/\r?\n/)) {
        const line = raw.replace(/\s+#.*$/, '').trim();
        // Comments, includes (-r, -c), options (--index-url) and editable local installs carry no package.
        if (!line || line.startsWith('#') || (line.startsWith('-') && !/^-e\s+git\+/.test(line))) continue;
        const target = line.replace(/^-e\s+/, '');
        add(/^(git\+)?(https?|ssh):\/\//.test(target) ? parseUrlRequirement(target) : parseRequirement(target), raw);
      }
      return { uses, produces };
    }

    const doc = parseToml(content) as Record<string, any>;
    const project = doc.project ?? {};
    const poetry = doc.tool?.poetry ?? {};

    const name = typeof project.name === 'string' ? project.name : typeof poetry.name === 'string' ? poetry.name : undefined;
    if (name) produces.push({ kind: 'python', name: normalizePythonName(name), location: { file, line: lineAt(content, content.indexOf(name)) } });

    const specs: string[] = [
      ...(Array.isArray(project.dependencies) ? project.dependencies : []),
      ...Object.values(project['optional-dependencies'] ?? {}).flat(),
      ...Object.values(doc['dependency-groups'] ?? {}).flat(),
    ].filter((s): s is string => typeof s === 'string');
    for (const spec of specs) add(parseRequirement(spec), spec);

    const poetryTables = [poetry.dependencies, poetry['dev-dependencies'], ...Object.values(poetry.group ?? {}).map((g: any) => g?.dependencies)];
    for (const table of poetryTables) {
      if (!table || typeof table !== 'object') continue;
      for (const [dep, value] of Object.entries(table)) {
        const key = new RegExp(`^\\s*"?${dep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?\\s*=`, 'm');
        add(poetryRequirement(dep, value), key);
      }
    }

    return { uses, produces };
  },
};
