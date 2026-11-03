export type ArtifactKind = 'image' | 'terraform-module' | 'workflow' | 'action' | 'npm' | 'helm-chart' | 'go' | 'python';

/**
 * How sure we are that a link points at the right repo.
 * - exact: the reference names the repo itself (acme/ci/.github/workflows/build.yml@v1)
 * - declared: the producing repo declares the artifact (package.json name, an image push in CI)
 * - convention: guessed from naming rules (ghcr.io/acme/api is probably built by acme/api)
 */
export type Confidence = 'exact' | 'declared' | 'convention';

export interface RepoInfo {
  /** "owner/name", lowercased. Just "name" when the owner is unknown. */
  id: string;
  owner: string;
  name: string;
  /** Path relative to the scan root, or "owner/name" for repos fetched with --org. */
  path: string;
  /** Web URL of the repo, when known. Used to link to files from the HTML report. */
  url?: string;
}

export interface Location {
  /** Path relative to the repo root, always with forward slashes. */
  file: string;
  line: number;
}

/** A repo referencing something: an image, a module, a workflow, a package. */
export interface Usage {
  kind: ArtifactKind;
  /** Normalized artifact name without the version, e.g. "ghcr.io/acme/base". */
  name: string;
  /** Tag, ref, or version range as written. Never empty: "latest", "unpinned", etc. */
  version: string;
  /** The repo the reference itself points at, when it names one (owner/name). */
  repoHint?: string;
  hintConfidence?: Confidence;
  location: Location;
}

/** A repo publishing something other repos can use. */
export interface Production {
  kind: ArtifactKind;
  name: string;
  location: Location;
}

export interface ParseContext {
  repo: RepoInfo;
  file: string;
  content: string;
}

export interface ParseResult {
  uses: Usage[];
  produces: Production[];
}

export interface Parser {
  id: string;
  matches(file: string): boolean;
  parse(ctx: ParseContext): ParseResult;
}

export interface RepoUsage extends Usage {
  repo: string;
}

export interface RepoProduction extends Production {
  repo: string;
}

/** A cross-repo dependency: `from` uses something that `to` produces. */
export interface Link {
  from: string;
  to: string;
  kind: ArtifactKind;
  name: string;
  version: string;
  location: Location;
  confidence: Confidence;
}

/** Something that could not be read or parsed. Each one means dependencies may be missing from the graph. */
export interface ScanWarning {
  repo: string;
  /** Empty when the problem concerns the whole repo (for example, its file list could not be fetched). */
  file: string;
  message: string;
}

export interface Graph {
  schemaVersion: 1;
  generatedAt: string;
  /** What was scanned: a folder path or "github.com/<org>". */
  source?: string;
  /** Problems during the scan. Absent in graphs written before ripplemap 0.4. */
  warnings?: ScanWarning[];
  repos: RepoInfo[];
  usages: RepoUsage[];
  produces: RepoProduction[];
  links: Link[];
}
