import { isMap, isScalar, isSeq, LineCounter, parseAllDocuments, visit } from 'yaml';
import { parseImageRef } from '../refs.ts';
import type { Parser, Usage } from '../types.ts';
import { basename } from '../util.ts';

/** Keys that hold container lists in every workload kind, including CRDs like Argo Rollouts. */
const CONTAINER_KEYS = new Set(['containers', 'initContainers', 'ephemeralContainers']);

/** YAML files other parsers own, or that are never Kubernetes manifests. */
function isOtherYaml(file: string): boolean {
  const name = basename(file);
  return (
    file.startsWith('.github/') ||
    name.startsWith('.') ||
    /^(docker-)?compose(\.[\w.-]+)?\.ya?ml$/i.test(name) ||
    /^(Chart|values([.-][\w.-]+)?|action|mkdocs|codecov|dependabot|renovate|pnpm-lock|pnpm-workspace)\.ya?ml$/.test(name) ||
    // Helm templates are Go templates, not plain YAML.
    file.split('/').includes('templates')
  );
}

export const kubernetesParser: Parser = {
  id: 'kubernetes',

  matches(file) {
    return /\.ya?ml$/i.test(file) && !isOtherYaml(file);
  },

  parse({ file, content }) {
    const uses: Usage[] = [];
    // Plenty of YAML isn't a manifest. Only files with a top-level apiVersion and kind are read,
    // and templated files ({{ }}) can't be read as YAML at all.
    if (!/^apiVersion\s*:/m.test(content) || !/^kind\s*:/m.test(content) || content.includes('{{')) {
      return { uses, produces: [] };
    }

    const lineCounter = new LineCounter();
    const docs = parseAllDocuments(content, { lineCounter });
    for (const doc of Array.isArray(docs) ? docs : []) {
      if (doc.errors.length) throw new Error(doc.errors[0]!.message);
      visit(doc, {
        Pair(_, pair) {
          if (!isScalar(pair.key) || !CONTAINER_KEYS.has(String(pair.key.value)) || !isSeq(pair.value)) return;
          for (const container of pair.value.items) {
            if (!isMap(container)) continue;
            const node = container.get('image', true);
            if (!isScalar(node) || typeof node.value !== 'string') continue;
            const image = parseImageRef(node.value);
            if (image) uses.push({ kind: 'image', ...image, location: { file, line: lineCounter.linePos(node.range?.[0] ?? 0).line } });
          }
        },
      });
    }
    return { uses, produces: [] };
  },
};
