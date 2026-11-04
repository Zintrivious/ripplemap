import type { ArtifactKind, Confidence } from './types.ts';

export interface RepoRef {
  host: string;
  owner: string;
  name: string;
}

/**
 * Azure DevOps writes one repo several ways. They all become host dev.azure.com, owner "org/project":
 *   https://[user@]dev.azure.com/org/project/_git/repo
 *   https://org.visualstudio.com/[DefaultCollection/]project/_git/repo
 *   git@ssh.dev.azure.com:v3/org/project/repo  (and vs-ssh.visualstudio.com)
 * Returns undefined for other hosts, and null for an Azure URL it can't read.
 */
function azureRepo(host: string, parts: string[]): RepoRef | null | undefined {
  let org: string | undefined;
  let project: string | undefined;
  let name: string | undefined;
  if (host === 'ssh.dev.azure.com' || host === 'vs-ssh.visualstudio.com') {
    if (parts[0] === 'v3') [, org, project, name] = parts;
  } else if (host === 'dev.azure.com' || host.endsWith('.visualstudio.com')) {
    const git = parts.indexOf('_git');
    if (git === -1) return null;
    name = parts[git + 1];
    project = parts[git - 1];
    org = host === 'dev.azure.com' ? parts[0] : host.split('.')[0];
    // A project-named repo can drop the project: dev.azure.com/org/_git/repo.
    if (host === 'dev.azure.com' && git === 1) project = name;
  } else {
    return undefined;
  }
  if (!org || !project || !name) return null;
  return { host: 'dev.azure.com', owner: `${org}/${project}`.toLowerCase(), name: name.toLowerCase() };
}

/** Parses git remote URLs: git@host:owner/repo.git, https://host/owner/repo, ssh://git@host/owner/repo. */
export function parseRepoUrl(url: string): RepoRef | null {
  let host: string;
  let path: string;
  const scp = /^(?:[\w.-]+@)?([\w.-]+):(.+)$/.exec(url);
  if (!url.includes('://') && scp) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    try {
      const u = new URL(url);
      host = u.hostname;
      path = u.pathname;
    } catch {
      return null;
    }
  }
  const parts = path.replace(/\.git\/?$/, '').split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  const azure = azureRepo(host.toLowerCase(), parts);
  if (azure !== undefined) return azure;
  if (parts.length < 2) return null;
  return {
    host: host.toLowerCase(),
    owner: parts.slice(0, -1).join('/').toLowerCase(),
    name: parts.at(-1)!.toLowerCase(),
  };
}

export interface ImageRef {
  name: string;
  version: string;
}

/** Splits "ghcr.io/acme/api:1.2@sha256:..." into a normalized name and a version. */
export function parseImageRef(raw: string): ImageRef | null {
  let ref = raw.trim();
  if (!ref || ref.includes('$')) return null;

  let digest: string | undefined;
  const at = ref.indexOf('@');
  if (at !== -1) {
    digest = ref.slice(at + 1);
    ref = ref.slice(0, at);
  }

  let tag: string | undefined;
  const colon = ref.lastIndexOf(':');
  if (colon > ref.lastIndexOf('/')) {
    tag = ref.slice(colon + 1);
    ref = ref.slice(0, colon);
  }

  const name = ref
    .toLowerCase()
    .replace(/^(?:docker\.io|index\.docker\.io|registry-1\.docker\.io)\//, '')
    .replace(/^library\//, '');
  if (!/^[a-z0-9][a-z0-9._\-/:]*$/.test(name)) return null;

  return { name, version: tag || (digest ? digest.slice(0, 19) : 'latest') };
}

/**
 * Guesses which repo builds an image from its name: ghcr.io/acme/api → acme/api.
 * Returns null for official Docker Hub images like "node", which no org repo builds.
 */
export function guessImageRepo(name: string): { owner?: string; name: string } | null {
  const parts = name.split('/');
  const hasRegistry = parts.length > 1 && /[.:]|^localhost$/.test(parts[0]!);
  const path = hasRegistry ? parts.slice(1) : parts;
  if (!hasRegistry && path.length === 1) return null;
  if (path.length >= 2) return { owner: path.at(-2)!, name: path.at(-1)! };
  return { name: path[0]! };
}

export interface ResolvedRef {
  kind: ArtifactKind;
  name: string;
  version: string;
  repoHint?: string;
  hintConfidence?: Confidence;
}

const GIT_HOST_SHORTHAND = /^(github\.com|gitlab\.com|bitbucket\.org)\//;
const REGISTRY_SOURCE = /^(?:([\w-]+(?:\.[\w-]+)+)\/)?([\w-]+)\/([\w-]+)\/([\w-]+)(?:\/\/.*)?$/;

/** Normalizes a Terraform module `source`. Local paths and archives (s3::, http) return null. */
export function parseModuleSource(source: string, version?: string): ResolvedRef | null {
  const s = source.trim();
  if (s.startsWith('./') || s.startsWith('../') || s.startsWith('/')) return null;

  const isGit = s.startsWith('git::') || GIT_HOST_SHORTHAND.test(s) || /^[\w.-]+@[\w.-]+:/.test(s);
  if (!isGit) {
    const reg = REGISTRY_SOURCE.exec(s);
    if (!reg) return null;
    const [, host, namespace, name, provider] = reg;
    return {
      kind: 'terraform-module',
      name: `${host ? host + '/' : ''}${namespace}/${name}/${provider}`.toLowerCase(),
      version: version?.trim() || 'unpinned',
      // Terraform registries only publish repos named terraform-<PROVIDER>-<NAME>, so this is reliable.
      repoHint: `${namespace}/terraform-${provider}-${name}`.toLowerCase(),
      hintConfidence: 'exact',
    };
  }

  let rest = s.replace(/^git::/, '');
  let ref: string | undefined;
  const query = rest.indexOf('?');
  if (query !== -1) {
    ref = new URLSearchParams(rest.slice(query + 1)).get('ref') ?? undefined;
    rest = rest.slice(0, query);
  }

  let subdir = '';
  const schemeEnd = rest.indexOf('://');
  const sub = rest.indexOf('//', schemeEnd === -1 ? 0 : schemeEnd + 3);
  if (sub !== -1) {
    subdir = rest.slice(sub + 2).replace(/\/+$/, '');
    rest = rest.slice(0, sub);
  }
  if (GIT_HOST_SHORTHAND.test(rest)) rest = `https://${rest}`;

  const repo = parseRepoUrl(rest);
  if (!repo) return null;
  return {
    kind: 'terraform-module',
    name: `${repo.host}/${repo.owner}/${repo.name}${subdir ? `//${subdir.toLowerCase()}` : ''}`,
    version: ref || 'default branch',
    repoHint: `${repo.owner}/${repo.name}`,
    hintConfidence: 'exact',
  };
}

/** Parses a GitHub Actions `uses:` value. Local (./) references return null. */
export function parseUses(uses: string): ResolvedRef | null {
  const v = uses.trim();
  if (!v || v.startsWith('./') || v.startsWith('.\\')) return null;

  if (v.startsWith('docker://')) {
    const image = parseImageRef(v.slice('docker://'.length));
    return image && { kind: 'image', ...image };
  }

  const at = v.lastIndexOf('@');
  const path = (at === -1 ? v : v.slice(0, at)).toLowerCase();
  const parts = path.split('/');
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  return {
    kind: path.includes('/.github/workflows/') ? 'workflow' : 'action',
    name: path,
    version: at === -1 ? 'unpinned' : v.slice(at + 1),
    repoHint: `${parts[0]}/${parts[1]}`,
    hintConfidence: 'exact',
  };
}
