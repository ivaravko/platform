# Spec: integration-tests

The integration tier named in [SPEC.md](SPEC.md#testing-strategy) — the row that exists in the
table and has never been built. Shared toolchain, code style, and boundaries are inherited from
[SPEC.md](SPEC.md).

Not a capability-map module. It ships no artifact and nothing depends on it; it is a test tier
spanning both `gcp-components` and `runway-cli`, specified separately because it is the one tier
that needs credentials, a project, and a CI decision that the other three do not.

## Objective

Prove that what the components *plan* is what GCP *accepts and enforces*.

The PR gate already proves the plan is shaped correctly — `pulumi.runtime.setMocks()` unit tests,
the CrossGuard policy pack, and `control-mapping.test.ts`. Every one of those runs against a
fabricated engine. None has ever spoken to Google. That is the gap: a hardened default that GCP
silently ignores, a provider field that does not survive the round trip, or an API that rejects our
resource shape outright would pass the entire suite today.

**Users:** platform engineers, who own the guardrails and need a regression in enforcement to fail
loudly before a service team inherits it. Service developers never run this tier.

**Success looks like:** a nightly run that fails when a hardening control stops being enforced by
GCP — not when it stops being *emitted* by us, which is already covered.

### The two gaps this closes, by name

[docs/control-mapping.md](docs/control-mapping.md) already records both, under *Known gaps*:

- **CR-03's stack-scoped policy rule is not exercised end to end offline.** It resolves an IAM
  binding to its service through the engine's dependency graph, and `setMocks` supplies no such
  graph. It is currently covered by hand-built dependency fixtures — a test of the fixture as much
  as of the rule. A real `pulumi preview` builds a real graph.
- **CR-06 guards the IaC path only.** `deletionProtection` is a provider-side field, not a GCP API
  field: the v2 API returns `null` for a deployed service while Pulumi state records `true`. That
  divergence was found against a real deployment, and only a real deployment can keep it from
  regressing or from silently changing when the provider version moves.

### Why not LocalStack, or any GCP emulator

The request that produced this spec asked for LocalStack. Recording the finding here so it is not
re-proposed:

**LocalStack emulates AWS only** — it has no GCP support. The third-party equivalents
([LocalGCP](https://github.com/slokam-ai/localgcp), MiniSky, LocalCloud) do emulate GCP, but not
the part that matters here. LocalGCP's own documentation lists under *not included*:
**"IAM/auth enforcement (all requests are accepted)"**, and its fourteen services include no IAM,
no Artifact Registry, and no Binary Authorization.

Set that against what this repo hardens — CR-01 through CR-09 are ingress, IAM bindings, service
account identity, and Binary Authorization. Every control lands in the emulator's gap. An emulator
that accepts all requests returns `200 OK` for a wide-open `allUsers` binding exactly as readily as
for a locked-down one, so an emulator-backed suite is structurally incapable of failing on a
security regression.

SPEC.md's rule is that *a control without a test is not a control*. A green suite that cannot fail
is worse than no suite, because it reads as proof. **No emulator is used in this tier.**

## Target Project

Resolved in [SPEC.md Open Question 3](SPEC.md#open-questions). Restated here because this spec is
the thing that acts on it:

| Fact | Value |
|---|---|
| Project id | `enduring-badge-506610-u9` |
| Project number | `741165637912` |
| Billing | active — `billingAccounts/01A131-8B0806-3C46A4` |
| Backend | local file backend; no state reaches Pulumi Cloud |
| Contents | no service accounts, no deployed workloads — this is what makes it a sandbox |

`project-4da1a7fd-3681-4524-853` must **never** be used: it holds live workloads and service
accounts (`piper-image-builder`, `app-image-builder`, `qwen2vl-image-builder`).

**API enablement, as verified.** Read per-API by exact match, not by grep — the distinction between
"no matches" and "the command failed" is one this repo's tests keep catching:

| API | State | Needed by |
|---|---|---|
| `run.googleapis.com` | enabled | Tier A, Tier B |
| `artifactregistry.googleapis.com` | enabled | Tier A, Tier B |
| `serviceusage.googleapis.com` | enabled | both |
| `compute.googleapis.com` | **enabled 2026-08-25** | provider region validation — **found during T2** |
| `iam.googleapis.com` | **enabled** — see below | Tier B |
| `cloudresourcemanager.googleapis.com` | not enabled | Tier B |
| `binaryauthorization.googleapis.com` | not enabled | Tier B (CR-09, currently out of scope) |

`pulumi preview` needs no APIs enabled at all, so Tier A was unblocked before any of this.
Confirmed by running it: the private fixture planned three resources and exited 0 while
`compute.googleapis.com` was still disabled.

**`compute.googleapis.com` was a T2 finding, and is now enabled.** The GCP provider probes the
Compute API to validate regions and warned on every run when it could not:

```
warning: failed to get regions list: failed to list regions: googleapi: Error 403:
Compute Engine API has not been used in project enduring-badge-506610-u9 …
```

That was a *warning*, not an error — `preview` exited 0 and the plan was complete either way. It
was enabled on explicit request rather than for correctness: a warning present on every single run
is one nobody reads, and the tier's whole value depends on people believing its output. **Verified
after enabling: `preview` exits 0 with zero warnings.**

**`iam.googleapis.com` turned out to be enabled already**, contradicting this table's earlier
reading and [SPEC.md OQ3](SPEC.md#open-questions). It was found enabled when the state was re-read
per-API by exact match after the compute change — so either enabling Compute pulled it in as a
dependency, or the original reading was wrong. **The lesson is the one OQ3 already recorded about
`grep`:** enablement is ambient state that changes outside this repo, so it is read at the moment
it matters, never trusted from a document. T11 shrinks accordingly — only
`cloudresourcemanager.googleapis.com` is definitely still needed.

## Scope: Two Tiers

Tier B is the point of this spec, and Tier A is not merely a stepping stone to it — they fail on
different things. Split because they carry different risk and different approval status.

### Tier A — `preview` against the sandbox

Creates nothing. Runs `pulumi preview` against the real Google API with a real credential, and
asserts on the resulting plan.

**What only this tier can catch:**
- The provider rejects our resource shape (a field removed or renamed across `@pulumi/gcp`
  versions).
- The engine's real dependency graph resolves differently from the hand-built fixtures — which is
  precisely CR-03's known gap.
- Our pinned provider version drifts from what the API now accepts.

**What it cannot catch:** whether GCP *enforces* anything. A `preview` never asks Google to apply a
policy. Ingress restriction, IAM binding rejection, and Binary Authorization all go unverified.

**Status:** buildable now. Needs no new API enablement and no boundary change.

### Tier B — `up`, assert against the live API, `destroy`

Deploys a real service, reads the deployed state back through the GCP API rather than through
Pulumi state, asserts the control holds, and destroys unconditionally.

Reading back **through the API, not through Pulumi state**, is the whole design. Pulumi state
records what we asked for; the API reports what GCP did. CR-06 is the proof that these differ, and
a test that reads Pulumi state would have missed it.

**Status: approved 2026-08-25 and unblocked.** The two decisions it rested on — unattended
`pulumi up` against the sandbox, and enabling three APIs on that project — are both taken, and
[SPEC.md](SPEC.md#boundaries)'s Never list is amended to scope the exception to this workflow and
this project. Tier A and Tier B are now planned together rather than sequentially.

**This tier automates a run that has already been performed once by hand.** Commits `feb337b`
(*Deploy and verify the controls on real infrastructure*) and `dd5c503` (*Tear down the integration
deployment, proving CR-06 both ways*) deployed a private and a public service to
`enduring-badge-506610-u9/europe-west1`, verified CR-01, CR-03, CR-04, CR-07 and CR-08 against the
live API, and destroyed both. Those commits changed documentation only — no test code exists.

That precedent matters twice over. It de-risks Tier B: the resource shapes are known to deploy, and
the assertions below are transcriptions of readings already taken, not guesses. And it is the
argument for automating them — a control verified by hand once is verified on the day someone
remembered to look, which is the same failure mode as a control with no test at all.

## Commands

```bash
# Tier A — preview only, creates nothing
npm run test:integration:preview

# Tier B — deploys, asserts, destroys (approved; sandbox only)
npm run test:integration:deploy

# Both, as CI runs them
npm run test:integration

# The PR gate, unchanged — must stay credential-free and offline
npm run build
```

All three are projen tasks added in `.projenrc.ts`, never hand-edited `package.json` scripts. None
is spawned by `build` or `test`; wiring one in would put credentials in the PR gate and violate a
SPEC.md Always rule.

**Two tasks split by directory, not one task with vitest projects.** A tier that only previews and
a tier that deploys differ enough in risk to be different commands, and one directory each says so
without a config file to maintain. `receiveArgs` is set on both, so `-- -t "CR-06"` reaches vitest
rather than being silently swallowed.

Local runs need application-default credentials against the sandbox project:

```bash
gcloud auth application-default login
gcloud config set project enduring-badge-506610-u9
```

## Project Structure

```
test/                            → the pull-request gate; `vitest run --dir test`
  ci.test.ts                     → existing: parses the emitted workflows
  integration-guard.test.ts      → the sandbox guard, gated (see below)
test-integration/                → the tier; never collected by the gate
  preview/
    dependency-graph.test.ts     → CR-03 against a real engine graph
    provider-contract.test.ts    → resource shapes the provider still accepts
  deploy/
    deletion-protection.test.ts  → CR-06 provider-vs-API divergence
    ingress.test.ts              → CR-01 enforced, not merely requested
    invoker-binding.test.ts      → CR-03 enforced
  fixtures/
    stacks/                      → precompiled stack programs + Pulumi.yaml
  support/
    sandbox.ts                   → project id, region, guard
    gcp-client.ts                → live API reads, distinct from Pulumi state
```

Integration tests live at the **repo root**, not inside a package: they compose `gcp-components`
stacks *and* repos emitted by `runway-cli`, so they belong to neither.

**`test-integration/` is a sibling of `test/`, not a subdirectory — the isolation is structural.**
The root suite runs `vitest run --dir test`, so it *cannot* collect this tree even by accident. The
first draft of this spec put the tier at `test/integration/` and excluded it by pattern; that puts
the credential-free guarantee behind a flag a later edit can silently drop, and the failure mode is
a pull request attempting to deploy to GCP. A directory boundary has no such failure mode.

**Typechecked, never run.** The root `tsconfig.json` includes `test-integration/**/*.ts`, so
`npm run build` still catches type errors here. Typechecking is offline and needs no credentials;
only *running* the tier touches GCP.

**The sandbox guard is the one exception, and it is gated deliberately.**
`test/integration-guard.test.ts` lives in the pull-request gate and imports the guard from
`test-integration/support/sandbox.ts`. The guard is a pure function over an environment — no I/O,
no credentials — and it is the single check standing between an unattended `pulumi up` and someone
else's project. There is no reason for it to be verified only inside the tier it protects: a broken
guard must fail a pull request.

**One consequence that must be designed around.** `control-mapping.test.ts` walks
`packages/gcp-components/test` and no further. A control whose only test lives in
`test-integration/` will therefore fail the "a row without a test fails" check. **Integration tests
supplement the mapping's unit tests; they never replace them.** Every `CR-0X` keeps its unit test
inside `packages/gcp-components/test/`, and the mapping's `Tests` column keeps pointing there.

## Code Style

Inherits SPEC.md. Two conventions specific to this tier:

```ts
import { afterAll, describe, expect, it } from "vitest";
import { assertSandbox, withStack } from "../support/sandbox";
import { getService } from "../support/gcp-client";

// Refuses to run anywhere but the designated sandbox. Placed at module scope so
// a misconfigured GOOGLE_CLOUD_PROJECT fails before any resource is planned,
// not midway through a deploy that then needs manual cleanup.
assertSandbox();

describe("CR-06: deletion protection survives the round trip", () => {
  it("is recorded in Pulumi state but absent from the v2 API", async () => {
    await withStack("cr06-deletion-protection", async (stack) => {
      const outputs = await stack.up();
      const deployed = await getService(outputs.serviceName);

      // The divergence is the assertion, not an accident being tolerated.
      // See docs/control-mapping.md "Known gaps" — if the API ever starts
      // returning this field, CR-06's gap has closed and the mapping is stale.
      expect(outputs.deletionProtection).toBe(true);
      expect(deployed.deletionProtection).toBeNull();
    });
  });
});
```

- **`withStack` destroys in a `finally`.** No test leaves a resource behind on assertion failure,
  and the teardown result is asserted rather than ignored — a failed `destroy` fails the test.
- **Test titles carry the control id** (`CR-06: …`), matching the existing convention, so a reader
  grepping a control id finds every tier that covers it.

## Testing Strategy

Slots in as the fourth row of SPEC.md's table, which currently describes it in one line:

| Level | Tool | Runs on | Gate |
|---|---|---|---|
| Unit | vitest + `setMocks()` | every PR | blocking |
| Policy | vitest against the policy pack | every PR | blocking |
| Generation | vitest — scaffold to temp dir, build it | every PR | blocking |
| **Integration A** | `pulumi preview` on the sandbox | **nightly + pre-release** | **non-blocking on PR** |
| **Integration B** | `pulumi up` → API read → `destroy` | **nightly + pre-release** | **non-blocking on PR** |

- **Never in the PR gate.** SPEC.md: *"no test in the PR gate may touch GCP or need credentials"*
  and *"keep the PR test gate credential-free and offline"*. Fork PRs cannot hold credentials
  anyway, so a gating integration tier would make every external contribution red.
- **Failure is a real signal, not noise.** A nightly tier that fails intermittently gets muted
  within a month. Flakiness is treated as a defect in this suite, not a fact of cloud testing:
  quota and propagation delays are retried explicitly with a bounded, logged backoff; nothing else
  is.
- **Coverage is not measured here.** The 80% line-coverage floor is a PR-gate metric. This tier is
  measured by which controls it exercises, tracked in the mapping document.

### Authentication

**Workload Identity Federation, never a service account key.** SPEC.md's Never list forbids
committing credentials, and `gcp-components` exists partly to make user-managed SA keys impossible
to create. A JSON key in a GitHub secret to test that library would be self-refuting.

CI authenticates via `google-github-actions/auth` with WIF; a local run uses application-default
credentials. **No credential is ever written to the repo or to a projen-generated file.**

**This tier consumes a WIF pool; it never provisions one.** Provisioning is EP-03 in
[SPEC-environment-provisioning.md](SPEC-environment-provisioning.md). Standing up a second pool
here would duplicate the identity boundary that module exists to own, and two pools with different
attribute conditions is precisely how a permissive one survives review.

### Cost and cleanup

Tier A costs nothing. Tier B deploys a scale-to-zero Cloud Run service for the duration of one
test — cents per night, and the sandbox has active billing. The workflow runs `destroy` in an
`if: always()` step, and a final job asserts the project is empty, so a crashed run is caught by
the next night's assertion rather than by a billing alert.

## CI

One workflow, `integration`, added in `.projenrc.ts` via `root.github.addWorkflow("integration")` —
the same mechanism as the existing `security` workflow. It is **never hand-edited**, and
`test/ci.test.ts` gets contract assertions for it alongside the existing ones: that it does not
trigger on `pull_request`, that it pins the sandbox project id, and that teardown runs with
`if: always()`.

Triggers: nightly schedule, plus `workflow_dispatch`. Not on push to `main` — a merge should not
deploy, and the nightly run catches the same regression within a day.

## Boundaries

Inherits SPEC.md. Additions and one amendment specific to this tier:

**Always**
- Run against `enduring-badge-506610-u9` and assert the project id before planning any resource.
- Destroy in a `finally` and in an `if: always()` CI step; assert the teardown succeeded.
- Read deployed state through the GCP API when asserting enforcement, never through Pulumi state.
- Keep a unit test inside `packages/gcp-components/test/` for every control, whatever the
  integration tier also covers.

**Ask first**
- Enabling any additional API on the sandbox project.
- Adding a test that deploys anything beyond Cloud Run, Artifact Registry, and a service account.
- Any increase in what Tier B leaves running between tests.

**Never**
- Run this tier against any project other than the designated sandbox.
- Put an integration test in the PR gate, or let one block a pull request.
- Use a service account key. WIF or application-default credentials only.
- Weaken an assertion because a control behaves differently against real GCP than against mocks —
  that divergence is the finding, and it belongs in the mapping's *Known gaps*.

**Amends SPEC.md — done, 2026-08-25.** SPEC.md's Never list previously read: *"Run `pulumi up` or
`pulumi destroy` unattended, or against a project not designated as sandbox."* Tier B is unattended
by construction — it is a nightly CI job — so the rule has been split in two:

- Running against a project other than the designated sandbox stays forbidden, unconditionally.
- Running unattended is forbidden **except** from the `integration` workflow against
  `enduring-badge-506610-u9`.

The exception is deliberately narrow: one workflow, one project. It is not a general licence to
automate `pulumi up`, and any other unattended invocation still violates SPEC.md.

## Success Criteria

**Tier A**
- [ ] `npm run test:integration -- --project=preview` runs green against the sandbox, creating nothing.
- [ ] The sandbox is verifiably empty after the run, asserted by the suite rather than by eye.
- [ ] CR-03's stack-scoped rule is proven against a real engine dependency graph, and
      [docs/control-mapping.md](docs/control-mapping.md)'s *Known gaps* entry for it is deleted in
      the same commit.
- [ ] A deliberately bumped `@pulumi/gcp` minor that changes a resource shape fails this tier.
- [ ] `test/ci.test.ts` asserts the workflow does not trigger on `pull_request`.

**Tier B**
- [ ] CR-01 verified as *enforced*: a service planned as internal-only is not reachable publicly.
- [ ] CR-06's provider-vs-API divergence is asserted, so a provider change that closes it fails
      the suite and forces the mapping to be updated.
- [ ] A control deliberately weakened in a scratch branch turns this tier red. **Until this is
      demonstrated once, the tier is not proven to work** — the entire objection to emulators is
      that a suite which cannot fail reads as proof.
- [ ] The project is empty after a run that fails mid-deploy, verified by killing a run on purpose.

**Both**
- [ ] `npm run build` remains credential-free and offline; total PR-gate runtime unchanged.
- [ ] Nightly runs green for ten consecutive nights before the tier is called done.

## Open Questions

1. ~~**`pulumi up` unattended.**~~ **RESOLVED 2026-08-25 — approved, sandbox only.**
   [SPEC.md](SPEC.md#boundaries)'s Never list is amended: unattended `up`/`destroy` is permitted
   from the `integration` workflow against `enduring-badge-506610-u9`, and forbidden everywhere
   else. Tier B is unblocked.
2. ~~**Enabling three APIs on the sandbox.**~~ **RESOLVED 2026-08-25 — approved.**
   `iam.googleapis.com`, `cloudresourcemanager.googleapis.com` and
   `binaryauthorization.googleapis.com` may be enabled on the sandbox. The Ask-first gate is
   satisfied; enabling them is a task in the plan, not yet executed. Note this partly pre-empts
   [SPEC.md OQ4](SPEC.md#open-questions) (Binary Authorization defaults) — enabling the API does
   not decide whether BinAuthz defaults on, and OQ4 stays open.
3. ~~**WIF setup — who performs it.**~~ **RESOLVED by the capability map, not by a decision.**
   [SPEC-environment-provisioning.md](SPEC-environment-provisioning.md) now owns WIF provisioning
   as control **EP-03** — *"CI authenticates by Workload Identity Federation; no service account
   key is created, ever"* — and that module entered the map after this spec was drafted. This tier
   therefore **consumes** the pool rather than provisioning one, and must not create its own.

   What remains is ordering, not ownership: `environment-provisioning` is unbuilt, so until it
   ships, the `integration` workflow runs on `workflow_dispatch` with a local credential. Confirm
   that interim is acceptable, or hold CI wiring until EP-03 lands. **Neither tier is blocked
   locally** — both run today against application-default credentials.
4. **Ten green nights is a guess.** It is a stand-in for "stable enough to trust". If pre-release
   is the only moment this tier's verdict is acted on, a shorter bar is defensible.
