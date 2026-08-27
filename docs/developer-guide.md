# Developer guide

Life in a repository that `runway new` generated, told in the order you will meet it: the daily
loop, the pull-request gate, deploying staging yourself, and the one thing you cannot do — deploy
production — which is the platform working, not the platform in your way.

The audience is a service developer. If you are provisioning projects or running `runway
bootstrap`, that is the operator path in the [README](../README.md); if you are auditing what the
guardrails enforce, that is [control-mapping.md](control-mapping.md).

## Your repository, at a glance

Almost every file is generated. **`.projenrc.ts` is the only configuration meant to be
hand-edited**; `npx projen` regenerates the rest, and CI fails a pull request whose generated
output is stale (a `self-mutation` job repairs it automatically when the repo has a
`PROJEN_GITHUB_TOKEN` secret). Editing a workflow file directly therefore does not stick — the
change belongs in `.projenrc.ts`, or upstream in `@runway/cli` if every service should have it.

What is yours to write: `src/client/` (a React SPA bundled by vite), `src/server/` (a Node server,
no framework), `test/`, and `infra/index.ts` — the Pulumi program composing the
`@runway/gcp-components` your service runs on.

```bash
npm install        # must precede projen: .projenrc.ts imports it
npx projen         # regenerate config after editing .projenrc.ts
npm run dev        # client and server, reloading on change
npm run build      # the whole PR gate: compile → test → lint
runway doctor      # what this machine is missing, before npm tells you cryptically
```

## The daily loop

`npm run dev` opens one URL. vite serves the client with hot replacement and forwards `/api/*` and
`/healthz` to the Node server on 8080, so the browser talks to a single origin — the same shape as
production. That is why there is no CORS config and no API-base-URL environment variable, and why
server routes belong under `/api/`: an unreserved path goes to the client and 404s confusingly.

Two things about the toolchain will surprise you once each:

- **The dev server strips types; it does not check them.** `node --watch` runs the server straight
  from TypeScript source using Node's own type stripping, so a type error will not stop it —
  `npm run build` and CI still typecheck with `tsc`. Type stripping also rejects `enum`,
  `namespace`, and constructor parameter properties; prefer plain types.
- **Lint warnings fail the build.** oxlint runs type-aware with `--deny-warnings`; `npm run
  lint:fix` applies what is autofixable.

## What CI does with your pull request

`build.yml` runs the same `npm run build` you run locally, so CI and your machine cannot disagree.
Alongside it, a `package` job proves the Dockerfile still builds on every run — and on pushes to
`main` it pushes the image to the staging registry tagged `sha-<commit>`. The registry's tags are
immutable: every commit gets a fresh tag, and nothing is ever re-tagged.

Dependabot opens version PRs weekly. Two scopes are deliberately absent from them: `@pulumi/*` is
pinned exactly as a verified combination (a solo bump would desynchronise the provider from the
components built against it), and `@runway/*` lives in an authenticated registry dependabot cannot
read. Upgrading `@runway/cli` is how the repo moves onto the current paved road: bump it, run
`npx projen`, and review what regenerated.

## Deploying staging — you, from your laptop

Staging is deployed by people, deliberately: the audit log then names a person, not a bot. Your
access comes from membership of the developers group, which holds `roles/run.developer` on the
staging project and object access to its state bucket — deploy verbs, not IAM-rewriting verbs.

The image you deploy is one CI already built. Pick the `sha-<commit>` tag from the main build you
want, then:

```bash
cd infra
pulumi login gs://<name>-staging-state
pulumi stack select staging
pulumi config set imageTag sha-<commit>
pulumi up
```

There is no `docker push` in that flow because you cannot: humans hold no registry-writer role.
Images enter the registry through CI's federated identity only, so what staging runs is always
something a pipeline built from a commit — never an image whose provenance is one laptop.

## Production — the 403 is the product

You cannot deploy production, and neither can any credential you hold. This is not a policy asking
for restraint; the IAM built by bootstrap simply grants no human a deploy-capable role on the
production project, so `pulumi up` fails at Google's door. The only deployer is a federated CI
identity that exists exclusively for `release.yml`.

What you do instead is release:

```bash
git tag v1.4.0 && git push origin v1.4.0   # deploy to production
gh workflow run release.yml --ref v1.3.0   # roll back: re-run an old release
```

The release resolves the tagged commit to the image digest CI built for it, copies that digest into
the production registry, and deploys the digest — never a tag. If the tagged commit was never built
on `main`, the release goes red at the resolve step: promotion is an artifact moving, not a
rebuild, so there is nothing to promote. A rollback is the same run re-asked-for on an older tag,
with the asking actor named in the log.

## When the guardrails push back

The components are secure by default, and every relaxation is a named argument in `infra/index.ts`
— visible in review, regenerated on every `npx projen`, never a console toggle. The refusals you
are most likely to meet:

- **The new service is unreachable.** `SecureContainerService` defaults to internal ingress and no
  invoker binding; reaching it needs a load balancer. That is the default working, not a
  misconfiguration — making it public is an explicit, justified opt-out in the infra program.
- **`test/production-image.test.ts` fails.** Someone put an `imageTag` in the production stack
  config. Production deploys a digest, never a tag — a tag can be repointed after the fact — and
  this test failing is the control working. The fix is to remove the tag, not the test: the test is
  projen-managed, so deleting it is a visible edit to `.projenrc.ts`, not a quiet `rm`.
- **A deploy grant to an individual is rejected.** Staging access goes to the developers group,
  never a `user:` principal — joining the team is a group membership change, and offboarding is a
  group removal rather than IAM archaeology.

A worked example of all of this, end to end — scaffolded, provisioned, CI pushing images by
federation, deployed to staging — is [ivaravko/first01](https://github.com/ivaravko/first01).
