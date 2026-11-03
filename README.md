# ripplemap

**See which repos are affected when you change one.**

You're about to bump the shared base image, change a Terraform module, or edit the reusable CI workflow. Which repos use it? Which are still on the old version? Usually the answer lives in someone's head or a stale wiki page.

ripplemap reads the files your repos already have (Dockerfiles, Terraform, GitHub Actions workflows, `package.json`, Compose files) and builds the cross-repo dependency graph. You don't write any catalog YAML, and nothing leaves your machine.

```
$ ripplemap impact base-images

base-images
├─ api  image ghcr.io/acme/base:1.4  Dockerfile:1
│  └─ frontend  image ghcr.io/acme/api:latest  docker-compose.yml:3
└─ web  image ghcr.io/acme/base:1.2  Dockerfile:1

3 repos affected: 2 direct, 1 indirect.
```

`frontend` never mentions `base-images`. It runs the `api` image, which is built on top of it. ripplemap follows that chain.

## Quick start

Requires Node.js 20 or newer.

```bash
# Clone the repos you care about into one folder (or point it at a single repo)
gh repo list my-org --limit 200 --json name --jq '.[].name' \
  | xargs -I{} git clone --depth 1 https://github.com/my-org/{} repos/{}

npx github:Zintrivious/ripplemap scan repos
npx github:Zintrivious/ripplemap impact <repo>
npx github:Zintrivious/ripplemap drift
```

Or install it from source:

```bash
git clone https://github.com/Zintrivious/ripplemap && cd ripplemap
npm install && npm link
ripplemap scan ~/code/my-org
```

## Commands

### `ripplemap scan <dir>`

Scans a folder of cloned repos, or a single repo, and writes `ripplemap.json`.

| Option | |
|---|---|
| `--out <file>` | Where to write the graph (default `ripplemap.json`) |
| `--owner <org>` | Org name for repos without a git remote |
| `--exclude <dir>` | Skip a folder name (`examples`) or repo-relative path (`test/fixtures`). Repeatable. |
| `--verbose` | Show files that could not be parsed |

### `ripplemap impact <repo>`

Every repo that depends on `<repo>`, directly or through other repos, with the file and line of each reference. `--json` for scripting.

### `ripplemap drift`

Shared things used at more than one version. Here it is on 27 of [Cloud Posse](https://github.com/cloudposse)'s Terraform module repos:

```
$ ripplemap drift --internal --kind terraform-module

cloudposse/dynamic-subnets/aws  module · built in terraform-aws-dynamic-subnets · 7 versions across 15 repos
  3.1.1   terraform-aws-elasticache-redis
  2.4.2   terraform-aws-ec2-autoscale-group, terraform-aws-ec2-bastion-server, terraform-aws-ec2-instance +5 more
  2.4.1   terraform-aws-ecs-codepipeline, terraform-aws-elastic-beanstalk-environment, terraform-aws-rds, terraform-aws-vpc-peering-multi-account
  2.3.0   terraform-aws-ec2-instance, terraform-aws-eks-cluster, terraform-aws-vpc-peering
  2.1.0   terraform-aws-vpc-peering
  2.0.4   terraform-aws-vpc
  0.39.8  terraform-aws-vpc
```

(All of that drift is in their `examples/` folders; their module code itself is kept current by Renovate. Run with `--exclude examples` to see only the code you ship.)

| Option | |
|---|---|
| `--internal` | Only things built in your scanned repos (hides `actions/checkout` and similar) |
| `--kind <kind>` | `image`, `terraform-module`, `workflow`, `action` or `npm`. Repeatable. |
| `--fail` | Exit with code 1 when drift is found, so you can run it in CI |
| `--json` | Full output for scripting |

## What it understands

| File | Uses | Produces |
|---|---|---|
| `Dockerfile`, `*.dockerfile`, `Containerfile` | `FROM` and `COPY --from` images (resolves `ARG` defaults, skips build stages) | |
| `*.tf` | `module` sources: git (`git::`, `github.com/...`), and registry (`org/name/provider`) | the module, by repo name |
| `.github/workflows/*.yml`, `action.yml` | actions, reusable workflows, `docker://` images | images pushed with `docker/build-push-action`, `docker/metadata-action`, or `docker push` |
| `package.json` | `dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies` | the package `name` |
| `compose.yml`, `docker-compose*.yml` | service `image`s | |

### How references are linked to repos

Every link carries a confidence level so you know how much to trust it:

- **exact**: the reference names the repo (`acme/ci/.github/workflows/build.yml@v2`, `git::https://github.com/acme/modules.git//vpc`). Terraform registry modules count too, since registries only publish repos named `terraform-<provider>-<name>`.
- **declared**: another repo declares it produces the thing (a `package.json` `name`, an image push in CI).
- **convention**: guessed from naming, e.g. `ghcr.io/acme/api` is probably built by `acme/api`. These are marked `(guessed from name)` in the output.

### Known limits

- It reads files, not traffic. Service A calling service B over HTTP is invisible unless a config file names it. Your APM tool covers that side.
- Images whose names are built entirely from CI variables can't be resolved statically and are skipped.
- Repos are found one level deep: `repos/<repo>`. Nested layouts aren't supported yet.
- The Terraform and GitHub Actions parsing has been checked against real public repos. The Docker and npm linking has so far only been tested on the fixtures in `test/fixtures`. Bug reports with real-world files are very welcome.

## Roadmap

- `--org <name>`: scan a GitHub org through the API without cloning everything
- An HTML report with an interactive graph
- A GitHub Action that comments "this PR affects N repos" on pull requests
- More parsers: Kubernetes manifests, Helm charts, `go.mod`, Python packages

Check the [issues](https://github.com/Zintrivious/ripplemap/issues). The ones labeled `good first issue` are self-contained.

## Contributing

Adding a parser is the easiest way in. A parser is one file with a `matches(file)` and a `parse(...)` function, and you don't need to touch the rest of the code. [CONTRIBUTING.md](CONTRIBUTING.md) walks through it.

## License

MIT
