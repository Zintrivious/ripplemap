import { isMap, isScalar, LineCounter, parseDocument } from 'yaml';
import { parseImageRef } from '../refs.ts';
import type { Parser, Usage } from '../types.ts';
import { basename } from '../util.ts';

export const composeParser: Parser = {
  id: 'compose',

  matches(file) {
    return /^(docker-)?compose(\.[\w.-]+)?\.ya?ml$/i.test(basename(file));
  },

  parse({ file, content }) {
    const lineCounter = new LineCounter();
    const doc = parseDocument(content, { lineCounter });
    if (doc.errors.length) throw new Error(doc.errors[0]!.message);

    const uses: Usage[] = [];
    const services = doc.get('services');
    if (!isMap(services)) return { uses, produces: [] };

    for (const service of services.items) {
      if (!isMap(service.value)) continue;
      const node = service.value.get('image', true);
      if (!isScalar(node) || typeof node.value !== 'string') continue;
      const image = parseImageRef(node.value);
      if (image) uses.push({ kind: 'image', ...image, location: { file, line: lineCounter.linePos(node.range?.[0] ?? 0).line } });
    }
    return { uses, produces: [] };
  },
};
