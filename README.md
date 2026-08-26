# platform

A paved road onto GCP: `runway new` produces a repository that builds, tests, lints, and deploys a
security-hardened Cloud Run service, so a team's first commit is already correct. The guardrails
are components with recorded opt-outs, not documentation — see [SPEC.md](SPEC.md) and
[docs/control-mapping.md](docs/control-mapping.md) for what is enforced and how it is proven.

## Install the CLI

`@runway/*` is published to Artifact Registry, not npmjs.com, so npm needs the scope mapping and a
credential once:

```bash
cat >> ~/.npmrc <<'EOF'
@runway:registry=https://europe-west1-npm.pkg.dev/enduring-badge-506610-u9/runway/
//europe-west1-npm.pkg.dev/enduring-badge-506610-u9/runway/:always-auth=true
EOF
npx google-artifactregistry-auth --credential-config=$HOME/.npmrc

npm install -g @runway/cli
```

## Create a service

```bash
runway new <name> --region europe-west1
cd <name>
npm install        # must precede projen: .projenrc.ts imports it
npm run build      # compile → test → lint
npm run dev        # hot-reloading client + API server on one origin
runway doctor      # what this machine is missing, before npm tells you cryptically
```

`<name>` becomes the package name, the directory, and — with `-staging` / `-production` — the GCP
project ids. `.projenrc.ts` is the only generated file meant to be hand-edited; `npx projen`
regenerates the rest.

A complete service produced by this flow, end to end:
[ivaravko/first01](https://github.com/ivaravko/first01) — scaffolded, provisioned, CI building and
pushing its images by federation, and deployed to staging.

## Provision its environments

The projects pre-exist (the CLI never creates one); bootstrap adopts them and builds the identity
boundary — state buckets, deploy IAM, and the CI federation:

```bash
runway bootstrap <name> --staging-project <name>-staging \
  --github-repo <org>/<repo> --region europe-west1 \
  --bootstrap-state gs://<org>-runway-bootstrap-state         # previews
# … same command with --yes                                    # applies

runway bootstrap <name> … --dry-run        # plan from derivation alone, no credentials
runway bootstrap <name> … --print-config   # the repository variables the workflows read
```

`--production-project` is optional — staging-first is the supported path, and the service is
reported **incomplete** on every run until production exists. Adopting a production project that
already grants a human a deploy role is refused, with every offending binding named. Set the
printed `RUNWAY_*` repository variables and the generated repo's CI installs, builds, and pushes a
`sha-<commit>` image on every push to main.

## Deploy

```bash
# Staging, from a laptop, as yourself:
docker build --platform linux/amd64 --secret id=npmrc,src=$HOME/.npmrc .
cd infra && pulumi login gs://<name>-staging-state
pulumi stack select staging && pulumi up

# Production: only CI can, and only from a tag.
git tag v1.4.0 && git push origin v1.4.0

# Rollback: re-run an old release, with your name in the log.
gh workflow run release.yml --ref v1.3.0
```

There is deliberately no local command that deploys production — the attempt fails at Google's
door, not at a policy. See [SPEC-release-path.md](SPEC-release-path.md).

## Working on the platform itself

```bash
npm install && npm run build   # the whole PR gate: credential-free, offline
```

The toolchain is deliberately unusual (TypeScript 7, oxlint, precompiled Pulumi programs) — the
reasons live in [SPEC.md](SPEC.md), and each module's spec records what is verified against real
GCP and what is not.
