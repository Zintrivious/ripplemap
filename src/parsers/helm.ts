import { isMap, isScalar, isSeq, LineCounter, parseDocument, visit, type YAMLMap } from 'yaml';
import { parseImageRef } from '../refs.ts';
import type { Parser, Production, Usage } from '../types.ts';
import { basename } from '../util.ts';

const VALUES_FILE = /^values([.-][\w.-]+)?\.ya?ml$/;

const scalar = (map: YAMLMap, key: string): string | undefined => {
  const node = map.get(key, true);
  if (!isScalar(node) || node.value === null || node.value === undefined || node.value === '') return undefined;
  return String(node.value);
};

/**
 * Chart.yaml: the chart a repo publishes, and the charts it depends on.
 * values*.yaml: the images a chart deploys, written either as `image: repo:tag`
 * or as the common `image: { registry, repository, tag }` block.
 */
export const helmParser: Parser = {
  id: 'helm',

  matches(file) {
    const name = basename(file);
    return name === 'Chart.yaml' || VALUES_FILE.test(name);
  },

  parse({ file, content }) {
    const uses: Usage[] = [];
    const produces: Production[] = [];
    const lineCounter = new LineCounter();
    const doc = parseDocument(content, { lineCounter });
    if (doc.errors.length) throw new Error(doc.errors[0]!.message);
    const lineOf = (offset = 0) => lineCounter.linePos(offset).line;
    if (!isMap(doc.contents)) return { uses, produces };

    if (basename(file) === 'Chart.yaml') {
      // A chart vendored inside another chart (<chart>/charts/<dependency>/) is a copy, not something this repo publishes.
      const vendored = file.split('/').filter((s) => s === 'charts').length >= 2;
      const name = scalar(doc.contents, 'name');
      if (name && !vendored) produces.push({ kind: 'helm-chart', name: name.toLowerCase(), location: { file, line: lineOf(doc.contents.range?.[0]) } });

      const dependencies = doc.get('dependencies');
      if (isSeq(dependencies)) {
        for (const dep of dependencies.items) {
          if (!isMap(dep)) continue;
          const depName = scalar(dep, 'name');
          const repository = scalar(dep, 'repository') ?? '';
          // file:// dependencies live in the same repo.
          if (!depName || repository.startsWith('file://')) continue;
          uses.push({
            kind: 'helm-chart',
            name: depName.toLowerCase(),
            version: scalar(dep, 'version') ?? 'unpinned',
            location: { file, line: lineOf(dep.range?.[0]) },
          });
        }
      }
      return { uses, produces };
    }

    visit(doc, {
      Map(_, map) {
        // image: { registry: ghcr.io, repository: acme/api, tag: "1.4" }
        const repository = scalar(map, 'repository');
        if (repository && (map.has('tag') || map.has('pullPolicy') || map.has('registry'))) {
          const registry = scalar(map, 'registry');
          const tag = scalar(map, 'tag') ?? scalar(map, 'digest');
          const image = parseImageRef(`${registry ? `${registry}/` : ''}${repository}`);
          if (image) {
            // An empty tag means "the chart's appVersion".
            uses.push({ kind: 'image', name: image.name, version: tag ?? 'chart default', location: { file, line: lineOf(map.range?.[0]) } });
          }
        }
      },
      Pair(_, pair) {
        // image: ghcr.io/acme/api:1.4
        if (!isScalar(pair.key) || pair.key.value !== 'image' || !isScalar(pair.value) || typeof pair.value.value !== 'string') return;
        const image = parseImageRef(pair.value.value);
        if (image) uses.push({ kind: 'image', ...image, location: { file, line: lineOf(pair.value.range?.[0]) } });
      },
    });
    return { uses, produces };
  },
};
