import { isMap, isScalar, isSeq, LineCounter, parseDocument, visit, type YAMLMap } from 'yaml';
import { parseImageRef } from '../refs.ts';
import type { Parser, RepoInfo, Usage } from '../types.ts';
import { basename } from '../util.ts';

interface RepoResource {
  /** owner/name of the repo the alias points at. */
  repo: string;
  version: string;
}

const str = (map: YAMLMap, key: string): string | undefined => {
  const value = map.get(key);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

/**
 * Where a `resources.repositories` entry points. For Azure Repos, `name` is "Project/Repo",
 * or just "Repo" for the pipeline's own project. For GitHub it is "owner/repo".
 */
function resolveRepo(type: string, name: string, self: RepoInfo): string | undefined {
  if (type === 'github' || type === 'githubenterprise') return name.toLowerCase();
  if (type !== 'git') return undefined;
  const [org, project] = self.owner.split('/');
  const parts = name.toLowerCase().split('/');
  if (parts.length === 2 && org) return `${org}/${parts[0]}/${parts[1]}`;
  if (parts.length === 1 && org && project) return `${org}/${project}/${parts[0]}`;
  return undefined;
}

/**
 * Azure Pipelines YAML: templates pulled from other repos (`template: build.yml@templates`,
 * with `templates` declared under resources.repositories) and container resources.
 * Templates in the same repo carry no @alias and aren't cross-repo.
 */
export const pipelinesParser: Parser = {
  id: 'azure-pipelines',

  matches(file) {
    const name = basename(file);
    return (
      /\.ya?ml$/i.test(name) &&
      !file.startsWith('.github/') &&
      !name.startsWith('.') &&
      // YAML other tools own, never Azure Pipelines.
      !/^((docker-)?compose(\.[\w.-]+)?|Chart|values([.-][\w.-]+)?|action|mkdocs|codecov|dependabot|renovate|pnpm-lock|pnpm-workspace)\.ya?ml$/i.test(name)
    );
  },

  parse({ repo, file, content }) {
    const uses: Usage[] = [];
    // Cheap check first: most YAML files aren't pipelines that pull from other repos. A pipeline's
    // resources: is a top-level key; Kubernetes manifests also have resources: and containers:, indented.
    if (!/^resources\s*:/m.test(content) || !/^\s+(repositories|containers)\s*:/m.test(content)) return { uses, produces: [] };

    const lineCounter = new LineCounter();
    const doc = parseDocument(content, { lineCounter });
    if (doc.errors.length) {
      // Only worth a warning when the file really looks like a pipeline. Helm templates and
      // multi-document manifests that happen to pass the check above are someone else's YAML.
      if (/^(trigger|pr|pool|stages|jobs|steps|extends|variables)\s*:/m.test(content)) throw new Error(doc.errors[0]!.message);
      return { uses, produces: [] };
    }
    const lineOf = (offset = 0) => lineCounter.linePos(offset).line;

    const aliases = new Map<string, RepoResource>();
    const resources = doc.get('resources');
    if (!isMap(resources)) return { uses, produces: [] };

    const repositories = resources.get('repositories');
    if (isSeq(repositories)) {
      for (const entry of repositories.items) {
        if (!isMap(entry)) continue;
        const alias = str(entry, 'repository');
        const name = str(entry, 'name');
        const target = name && resolveRepo((str(entry, 'type') ?? 'git').toLowerCase(), name, repo);
        if (!alias || !target) continue;
        const ref = str(entry, 'ref');
        aliases.set(alias, { repo: target, version: ref ? ref.replace(/^refs\/(heads|tags)\//, '') : 'default branch' });
      }
    }

    // resources.containers: - container: build, image: ghcr.io/acme/builder:2
    const containers = resources.get('containers');
    if (isSeq(containers)) {
      for (const entry of containers.items) {
        if (!isMap(entry)) continue;
        const node = entry.get('image', true);
        if (!isScalar(node) || typeof node.value !== 'string') continue;
        const image = parseImageRef(node.value);
        if (image) uses.push({ kind: 'image', ...image, location: { file, line: lineOf(node.range?.[0]) } });
      }
    }

    if (aliases.size) {
      visit(doc, {
        Pair(_, pair) {
          if (!isScalar(pair.key) || pair.key.value !== 'template' || !isScalar(pair.value) || typeof pair.value.value !== 'string') return;
          const at = pair.value.value.lastIndexOf('@');
          if (at === -1) return;
          const resource = aliases.get(pair.value.value.slice(at + 1).trim());
          if (!resource) return;
          const path = pair.value.value.slice(0, at).trim().replace(/^\/+/, '');
          uses.push({
            kind: 'pipeline',
            name: `${resource.repo}//${path.toLowerCase()}`,
            version: resource.version,
            repoHint: resource.repo,
            hintConfidence: 'exact',
            location: { file, line: lineOf(pair.value.range?.[0]) },
          });
        },
      });
    }
    return { uses, produces: [] };
  },
};
