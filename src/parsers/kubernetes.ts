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

function imageLines(file: string, content: string): Usage[] {
  const uses: Usage[] = [];
  content.split(/\r?\n/).forEach((text, i) => {
    const value = /^\s*(?:-\s*)?image:\s*["']?([^\s"'#]+)/.exec(text)?.[1];
    const image = value && parseImageRef(value);
    if (image) uses.push({ kind: 'image', ...image, location: { file, line: i + 1 } });
  });
  return uses;
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

    // Multi-MB install bundles: scanning lines is much faster than building a YAML tree, and finds the same images.
    if (content.length > 2 * 1024 * 1024) return { uses: imageLines(file, content), produces: [] };

    const lineCounter = new LineCounter();
    const docs = parseAllDocuments(content, { lineCounter });
    const list = Array.isArray(docs) ? docs : [];
    // Kubernetes reads YAML more forgivingly than the spec allows (multi-line quoted strings, for one).
    // Image references are all this parser takes, so reading `image:` lines directly loses nothing.
    if (list.some((doc) => doc.errors.length)) return { uses: imageLines(file, content), produces: [] };
    for (const doc of list) {
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
