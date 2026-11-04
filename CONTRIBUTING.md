# Contributing to ripplemap

Thanks for helping. Bug reports with a real file that ripplemap misreads are as valuable as code. Paste the smallest snippet that shows the problem.

## Setup

```bash
git clone https://github.com/Zintrivious/ripplemap && cd ripplemap
npm install
npm test          # runs the TypeScript sources directly (Node 22, 24 or 26)
npm run typecheck
npm run build     # compiles to dist/
node dist/cli.js scan test/fixtures/acme --owner acme
```

## How it fits together

```
src/
  cli.ts              argument parsing and commands
  scan.ts             finds repos on disk, runs parsers over their files
  github.ts           scan --org: lists repos and fetches files through the GitHub API, with a cache
  azure.ts            scan --azure-org: the same for Azure DevOps
  parsers/            one file per file format
  refs.ts             normalizing image names, module sources, `uses:` values
  graph.ts            linking usages to producing repos, impact, drift, unpinned
  changes.ts          what a set of changed files affects (ripplemap affected, the Action)
  markdown.ts         the pull request comment
  format.ts           terminal output
  report.ts           builds the HTML report from the graph
assets/
  report.css, report.js   the report page's styles and script (plain files, no build step)
action.yml            the GitHub Action: runs src/ directly on Node 24, no build step
test/
  fixtures/acme/      a small fake org used by the graph tests
```

A scan works in three steps:

1. Every file is offered to each parser whose `matches(file)` returns true.
2. Each parser returns **uses** (this repo references X at version Y) and **produces** (this repo publishes X).
3. `buildLinks` connects each use to the repo that produces it.

## Adding a parser

1. Create `src/parsers/<format>.ts` exporting a `Parser`:

   ```ts
   import type { Parser } from '../types.ts';

   export const helmParser: Parser = {
     id: 'helm',
     matches: (file) => file.endsWith('Chart.yaml'),
     parse({ repo, file, content }) {
       return { uses: [/* { kind, name, version, location: { file, line } } */], produces: [] };
     },
   };
   ```

2. Register it in `src/parsers/index.ts`.
3. If it introduces a new kind of artifact, add it to `ArtifactKind` in `src/types.ts` and to `KIND_LABEL` in `src/format.ts`.
4. Add tests to `test/parsers.test.ts`. If it links repos together, add a small repo to `test/fixtures/acme` and assert on the links in `test/graph.test.ts`.

Guidelines:

- Normalize names so the same thing written two ways matches: lowercase, no registry defaults (`docker.io/library/node` becomes `node`).
- Always set `version`. Use `latest`, `unpinned`, or `default branch` instead of leaving it empty.
- Set `repoHint` when the reference itself names a repo, so the link can be exact.
- Report a line number, since people jump to it from the output.
- Throw on malformed files. The scanner catches the error and reports it as a warning without stopping.

## Pull requests

- Keep each PR to one change, with tests.
- `npm test` and `npm run typecheck` must pass. CI runs both.
- Match the style of the surrounding code. The repo has no formatter config yet, so mimic what's there.
