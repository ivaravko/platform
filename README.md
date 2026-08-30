# platform

A paved road onto GCP: `runway new` produces a repository that builds, tests, lints, and deploys a
security-hardened Cloud Run service, so a team's first commit is already correct. The guardrails
are components with recorded opt-outs, not documentation — see [SPEC.md](SPEC.md) and
[docs/control-mapping.md](docs/control-mapping.md) for what is enforced and how it is proven.

## Build the CLI from source

```bash
git clone git@github.com:ivaravko/platform.git
cd platform
npm install
npm run compile
npm link --workspace @runway/cli   # puts `runway` on your PATH
```

## Create a service

The generated repository resolves `@runway/*` from Artifact Registry — its committed `.npmrc`
carries the scope mapping, you supply the credential once:

```bash
npx google-artifactregistry-auth --credential-config=$HOME/.npmrc
```

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

This flow was exercised end to end on a real service (`first01`, 2026-08-26) — scaffolded,
provisioned, CI building and pushing its images by federation, deployed to staging, then promoted
to production from a pushed tag. **That repository was deleted on 2026-08-30**, so there is no live
example to inspect and its CI run logs are gone with it; what those runs proved is recorded in
[SPEC-release-path.md](SPEC-release-path.md#promotion-resolves-a-tag-to-a-digest).

Day-to-day life inside the generated repository — the dev loop, the PR gate, deploying staging
yourself, and why production 403s you — is [docs/developer-guide.md](docs/developer-guide.md).

## Provision its environments

Two things are hand-made before bootstrap can run — the CLI adopts, it never creates:

```bash
# Once per organisation: the bucket holding the bootstrap stacks' own state.
gcloud storage buckets create gs://<org>-runway-bootstrap-state \
  --project <platform-project> --location europe-west1 --uniform-bucket-level-access
gcloud storage buckets update gs://<org>-runway-bootstrap-state --versioning

# Once per service: the projects, with billing attached. Ids derive from the
# service name — the flags below only confirm them.
gcloud projects create <name>-staging     # and <name>-production, when it is ready

# Once per deployer identity: read access to the @runway/* npm registry, which
# the image build's `npm ci` pulls from. Found by the first production cutover:
# the deployer authenticated fine and then 403'd on the package download.
gcloud artifacts repositories add-iam-policy-binding runway \
  --location europe-west1 --project <platform-project> \
  --member serviceAccount:<name>-deployer@<name>-production.iam.gserviceaccount.com \
  --role roles/artifactregistry.reader
```

For a production project, one more hand-made step — and it is the point of the module: **the
creator's `roles/owner` must come off**, replaced by admin roles that carry no `run.*` verb
(`iam.serviceAccountAdmin`, `iam.workloadIdentityPoolAdmin`, `storage.admin`,
`resourcemanager.projectIamAdmin`), or EP-06 refuses the adoption — correctly. Org-level access is
the recovery path; without an organisation, do not attempt this.

Bootstrap then adopts the projects and builds the identity boundary — state buckets, deploy IAM,
and the CI federation:

```bash
runway bootstrap <name> --staging-project <name>-staging \
  --github-repo <org>/<repo> --region europe-west1 \
  --developers-group <team>@<org> \
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
