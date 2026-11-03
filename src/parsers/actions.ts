import { isMap, isScalar, isSeq, LineCounter, parseDocument, visit, type Document, type YAMLMap } from 'yaml';
import { parseImageRef, parseUses } from '../refs.ts';
import type { Parser, Production, RepoInfo, Usage } from '../types.ts';

type Vars = Record<string, string>;

/** Replaces the ${{ }} expressions we can know statically. Returns null if any are left. */
function resolve(value: string, vars: Vars): string | null {
  const out = value.replace(/\$\{\{\s*([\w.-]+)\s*\}\}/g, (whole, expr: string) => vars[expr] ?? whole);
  return out.includes('${{') ? null : out;
}

function envVars(node: unknown, vars: Vars): Vars {
  const out: Vars = { ...vars };
  if (!isMap(node)) return out;
  for (const [key, value] of Object.entries(node.toJSON() as Record<string, unknown>)) {
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const resolved = resolve(String(value), out);
    if (resolved !== null) out[`env.${key}`] = resolved;
  }
  return out;
}

function list(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}

interface Step {
  step: YAMLMap;
  vars: Vars;
}

/** Steps of every job in a workflow, or of a composite action. */
function stepsOf(doc: Document, base: Vars): Step[] {
  const out: Step[] = [];
  const rootVars = envVars(doc.get('env'), base);
  const collect = (steps: unknown, vars: Vars) => {
    if (!isSeq(steps)) return;
    for (const step of steps.items) if (isMap(step)) out.push({ step, vars: envVars(step.get('env'), vars) });
  };
  const jobs = doc.get('jobs');
  if (isMap(jobs)) {
    for (const job of jobs.items) {
      if (isMap(job.value)) collect(job.value.get('steps'), envVars(job.value.get('env'), rootVars));
    }
  }
  const runs = doc.get('runs');
  if (isMap(runs)) collect(runs.get('steps'), rootVars);
  return out;
}

/** Image names a step publishes, from docker/build-push-action, docker/metadata-action, or `docker push`. */
function pushedImages(step: YAMLMap, vars: Vars): string[] {
  const json = step.toJSON() as { uses?: unknown; run?: unknown; with?: Record<string, unknown> };
  const uses = typeof json.uses === 'string' ? json.uses.toLowerCase() : '';
  const inputs = json.with ?? {};
  const raw: string[] = [];

  if (uses.startsWith('docker/build-push-action@')) {
    const push = inputs.push;
    if (push === true || (typeof push === 'string' && push !== 'false')) raw.push(...list(inputs.tags));
  }
  if (uses.startsWith('docker/metadata-action@')) {
    for (const entry of list(inputs.images)) {
      if (entry.startsWith('enable=')) continue;
      raw.push(entry.replace(/^name=/, ''));
    }
  }
  if (typeof json.run === 'string') {
    for (const m of json.run.matchAll(/docker\s+(?:image\s+)?push\s+([^\s;&|]+)/g)) raw.push(m[1]!);
  }

  const names: string[] = [];
  for (const value of raw) {
    const resolved = resolve(value, vars);
    const image = resolved && parseImageRef(resolved);
    if (image) names.push(image.name);
  }
  return names;
}

function repoVars(repo: RepoInfo): Vars {
  if (!repo.owner) return {};
  return {
    'github.repository': `${repo.owner}/${repo.name}`,
    'github.repository_owner': repo.owner,
    'github.event.repository.name': repo.name,
  };
}

export const actionsParser: Parser = {
  id: 'github-actions',

  matches(file) {
    return /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file) || /(^|\/)action\.ya?ml$/.test(file);
  },

  parse({ repo, file, content }) {
    const lineCounter = new LineCounter();
    const doc = parseDocument(content, { lineCounter });
    if (doc.errors.length) throw new Error(doc.errors[0]!.message);
    const lineOf = (offset = 0) => lineCounter.linePos(offset).line;

    const uses: Usage[] = [];
    visit(doc, {
      Pair(_, pair) {
        if (!isScalar(pair.key) || pair.key.value !== 'uses') return;
        if (!isScalar(pair.value) || typeof pair.value.value !== 'string') return;
        const ref = parseUses(pair.value.value);
        if (ref) uses.push({ ...ref, location: { file, line: lineOf(pair.value.range?.[0]) } });
      },
    });

    const produces: Production[] = [];
    for (const { step, vars } of stepsOf(doc, repoVars(repo))) {
      for (const name of pushedImages(step, vars)) {
        produces.push({ kind: 'image', name, location: { file, line: lineOf(step.range?.[0]) } });
      }
    }

    return { uses, produces };
  },
};
