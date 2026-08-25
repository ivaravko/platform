# Implementation Plan: integration-tests

Implements [SPEC-integration-tests.md](../SPEC-integration-tests.md).

**This file is the task-list target for this tier**, not `tasks/todo.md`. The tier cuts across
`gcp-components` and `runway-cli` rather than sitting in the capability map's build order
(`gcp-components → runway-cli → environment-provisioning → service-stacks → release-path`), so
threading it into the v1 completion plan in [tasks/plan.md](plan.md) would interleave it with work
it neither blocks nor depends on.

## Overview

Automate the integration tier: Tier A runs `pulumi preview` against the sandbox and asserts on the
plan; Tier B deploys, reads the deployed state back **through the GCP API**, asserts the control
holds, and destroys. Both run nightly, never in the PR gate.

The deploy has already been done once by hand (`feb337b`, `dd5c503`) — readings for CR-01, CR-03,
CR-04, CR-06, CR-07 and CR-08 exist and are recorded in
[SPEC-secure-container-service.md](../SPEC-secure-container-service.md). **This plan transcribes
known readings into assertions rather than discovering new ones**, which is what makes Tier B's
tasks small.

## Architecture Decisions

**Assert against the live API, never against Pulumi state.** Pulumi state records what we asked
for; the API reports what GCP did. CR-06 is the standing proof that these differ — state says
`deletionProtection: true`, the v2 API returns `null`. A harness that reads state would have
reported that control as verified.

**One harness, two tiers, one lifecycle helper.** `withStack` owns up/destroy and destroys in a
`finally`. Teardown failure fails the test rather than being swallowed — a leaked Cloud Run service
in a sandbox is cheap, but a teardown that silently stopped working is how it stops being a sandbox.

**Fixtures are precompiled JavaScript with `typescript: false` in `Pulumi.yaml`.** Not a style
choice: Pulumi runs `.ts` stacks through ts-node, which throws under TypeScript 7 (`ts.sys` is
undefined). [SPEC.md](../SPEC.md#tech-stack) records the mechanism and the verified workaround.

**The tier consumes a WIF pool; it never provisions one.** Provisioning is EP-03 in
[SPEC-environment-provisioning.md](../SPEC-environment-provisioning.md). Until that module ships,
CI runs on `workflow_dispatch` with a local credential.

**Every control keeps its unit test.** `control-mapping.test.ts` walks
`packages/gcp-components/test` and no further, so a control tested only from `test-integration/`
fails the "a row without a test fails" check. Integration tests supplement the mapping; they never
replace it.

## Dependency Graph

```
T1 sandbox guard ──┬─→ T4 provider-contract (Tier A)
                   │
T2 stack fixtures ─┼─→ T5 CR-03 real graph (Tier A) ──→ [gap closed in control-mapping.md]
   (precompiled)   │
                   └─→ T6 gcp-client ──→ T7 withStack ──┬─→ T8  CR-06 divergence
T3 vitest config                                        ├─→ T9  CR-01/03/07/08 enforcement
   + projen task                                        └─→ T10 emptiness + failure injection
                                                                        │
T11 enable 3 APIs ──────────────────────────────────────────────────────┴─→ T12 CI workflow
```

Foundation first (T1–T3), then Tier A, then Tier B, then CI. T11 is sequenced late deliberately:
it mutates a real GCP project, and nothing before T8 needs it.

## Task List

### Phase 1: Harness

- [x] **T1: Sandbox guard and configuration** — done
  - **Description:** `assertSandbox()` refuses to run anywhere but `enduring-badge-506610-u9`,
    evaluated at module scope so a misconfigured project fails before any resource is planned.
    Pins the local file backend so no state reaches Pulumi Cloud.
  - **Acceptance:** a wrong `GOOGLE_CLOUD_PROJECT` fails with a named error, not a diff; the
    project id appears in exactly one place.
  - **Verified:** six tests in `test/integration-guard.test.ts` — accepts the sandbox; rejects the
    live project `project-4da1a7fd-3681-4524-853` by name; rejects unset rather than defaulting;
    rejects empty and whitespace-only; refuses a trimmed match; compares case-sensitively.
  - **Files:** `test-integration/support/sandbox.ts`, `test/integration-guard.test.ts` · **XS**
  - **Note:** the guard's test sits in `test/`, not `test-integration/`, so it runs in the
    pull-request gate. It is a pure function needing no credentials, and it is the one check
    standing between an unattended `up` and someone else's project — a broken guard must fail a PR.
    The backend pin moved to T7, where `withStack` actually configures a stack.

- [x] **T2: Stack fixtures, precompiled** — done for the private path
  - **Description:** ~~The private and public service stacks~~ — **the private fixture only.** It
    is the one that proves the mechanism; the public fixture is deferred to T9, which is the task
    that actually asserts against it, so the harness is not carrying an unused stack until then.
  - **Verified — the TS 7 risk is retired.** `pulumi preview` against the sandbox planned **3
    resources and exited 0**, with no ts-node in the process. The outputs confirm the hardened
    defaults survive to a real plan:

    | Output | Value |
    |---|---|
    | `ingress` | `INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER` |
    | `isPublic` | `false` |
    | `deletionProtection` | `true` |

  - **Files:** `test-integration/fixtures/{tsconfig.json,package.json}`,
    `fixtures/private-service/{index.ts,Pulumi.yaml,Pulumi.integration.yaml}`, `.projenrc.ts` · **S**
  - **Config is required, never defaulted.** `location`, `image` and `serviceAccountEmail` are
    `config.require(...)`, and `gcp:project` is pinned in `Pulumi.integration.yaml`. A stack that
    fell back to gcloud's active project would have deployed to
    `project-4da1a7fd-3681-4524-853` — the live one — since that is this machine's current default.
  - **Two warnings surfaced; one fixed, one recorded.** The entry-point warning is gone
    (`test-integration/fixtures/package.json`, deliberately with no `main`). The Compute Engine API
    warning is a **new finding** — see Risk 6.

- [x] **T3: projen tasks and gate isolation** — done
  - **Description:** ~~`vitest.integration.config.ts` with `preview`/`deploy` projects~~ — **no
    config file was needed.** Three projen tasks in `.projenrc.ts` instead:
    `test:integration:preview`, `test:integration:deploy`, and `test:integration` spawning both.
    Split by directory rather than by vitest projects: two tiers of different risk deserve two
    commands, and a directory each says so without a config file to maintain.
  - **Acceptance:** ~~neither runs nor compiles~~ — **amended: `build` must not *run* them, but
    typechecking is deliberately retained.** The root `tsconfig.json` includes
    `test-integration/**/*.ts`, so type errors in the tier still fail a pull request. Typechecking
    is offline and credential-free; only running touches GCP. Excluding it would have traded a real
    check for nothing.
  - **Verified:** `npm run build` exits 0 with no credentials (root 50 tests, gcp-components 109,
    cli 63); `test` task steps unchanged; `npx projen` twice leaves generated files byte-identical.
  - **Files:** `.projenrc.ts`, `.projen/tasks.json`, `package.json`, `tsconfig.json` · **S**

**Checkpoint — Foundation.** `npm run build` unchanged and credential-free · `pulumi preview` runs a
fixture · `npx projen` idempotent · **human review before Tier A.**

### Phase 2: Tier A — preview

- [x] **T4: Provider-contract preview test** — done
  - **Description:** `pulumi preview` against the sandbox via the Automation API, asserting on the
    inputs the provider actually received. `preview()` returns only a change summary, so the plan
    is collected from the engine event stream (`resourcePreEvent`) — the counts say an operation
    happened, the events say what was sent, and only the latter is a contract.
  - **Verified:** 7 tests green. CR-01 ingress `INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER`, CR-07
    `defaultUriDisabled`, CR-03 *no* IAM member resource planned at all, CR-04 a non-default
    service account. Plan is 3 creates, no updates, no deletes.
  - **Acceptance met — the mutation test passed.** Expecting `INGRESS_TRAFFIC_ALL` failed with
    `expected 'INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER' to be 'INGRESS_TRAFFIC_ALL'`: 1 failed,
    6 passed. A precise failure, not a suite abort — the assertion reads a real value from a real
    plan.
  - **Also verified:** two consecutive runs both green (see below); the guard refuses
    `project-4da1a7fd-3681-4524-853` and exits 1; `npm run build` still green.
  - **Files:** `test-integration/preview/provider-contract.test.ts`,
    `test-integration/support/stack.ts`, `.projenrc.ts` · **M** (grew from S — the lifecycle
    helper landed here rather than in T7)

  **Two defects found by running it, both mine:**

  1. **The per-run passphrase broke on the second run.** Pulumi writes `encryptionsalt` into
     `Pulumi.<stack>.yaml` keyed to the passphrase that created the stack; a fresh passphrase next
     run means `error: incorrect passphrase`. **The first run passed** — which is precisely how
     this reaches CI and fails there. Fixed by making the stack ephemeral: `withFixtureStack`
     creates, uses, and removes it inside one call, deleting any settings file a crashed run left
     behind. That also makes "3 creates, no updates" meaningful, since leftover state would turn
     creates into updates and an unchanged resource carries no inputs to assert on.
  2. **The lint gate rejected two type assertions** (`no-unnecessary-type-assertion`,
     `no-unsafe-type-assertion`) — caught only because T3 kept the tier typechecked and linted in
     the PR gate. Replaced with `stringAt`, a predicate-based reader. Casting the shape of a
     resource input would assert the very thing this tier exists to verify.

  **Committed stack config was dropped as a result.** `Pulumi.integration.yaml` is now gitignored
  along with all `Pulumi.*.yaml` under fixtures: config is set programmatically from the guard's
  constants, so the sandbox project id appears in exactly one place, as T1 required and the
  committed file quietly violated.

- [x] **T5: CR-03 against a real engine dependency graph** — done; **Risk 1 retired**
  - **Description:** Closes a named gap. The stack-scoped CR-03 rule resolves a binding to its
    service through the engine's graph; `setMocks` supplies none, so it is currently proven only
    against hand-built fixtures.
  - **Verified, both directions.** `public-service` (justified) passes; `rogue-public` (raw
    `allUsers`, no justification) fails with the CR-03 violation. One direction alone proves
    nothing: a rule that resolved nothing and passed everything would look identical to a working
    one.
  - **Mutation proves the edge resolution.** Giving `rogue-public` a `"Public access justified: "`
    description flipped it to passing — `expected undefined to be defined`, 1 failed / 8 passed.
    Both fixtures auto-name the service, so its name is an output that does not exist at plan time;
    the only link between binding and service is the dependency edge. That flip is impossible
    unless the edge resolved, which is exactly what `setMocks` cannot supply.
  - **Acceptance met:** the CR-03 *Known gaps* entry in
    [docs/control-mapping.md](../docs/control-mapping.md) is closed in the same commit.
  - **Files:** `test-integration/preview/dependency-graph.test.ts`,
    `test-integration/support/policy-pack.ts`, `fixtures/{public-service,rogue-public}/`,
    `docs/control-mapping.md`, `.projenrc.ts` · **M**

  **Risk 1 was real, reproduced, and is now retired.** Running the pack from inside the monorepo
  fails exactly as SPEC.md predicted: `TypeError: Cannot read properties of undefined (reading
  'readFile')` from the vendored `ts-node@7.0.1`, then `policy pack not started`. Staged into a
  tree under the OS temp dir where `typescript` does not resolve, it loads: `✅ runway-gcp@v0.0.1`.

  **One correction to SPEC.md's account:** the staged tree needs `@pulumi/gcp` as well as
  `@pulumi/policy` and `@pulumi/pulumi` — the rules import it for its types. Its absence is not a
  load failure but a `MODULE_NOT_FOUND` thrown after the runner has started, which reads as a bug
  in the pack rather than a missing dependency.

  `policy-pack.ts` asserts `typescript` is unreachable from the staged tree before using it. If a
  transitive dependency ever makes it resolvable, the pack stops loading and `ts.sys.readFile`
  points nowhere near the cause.

**Checkpoint — Tier A.** One known gap closed and its doc entry removed · sandbox verifiably empty ·
**human review before anything deploys.**

### Phase 3: Tier B — deploy, assert, destroy

- [ ] **T6: Live GCP API client**
  - **Description:** Read deployed services back through the Cloud Run v2 API. Deliberately has no
    access to Pulumi state, so a test cannot accidentally assert against the wrong source.
  - **Acceptance:** returns raw API responses, unnormalised — `deletionProtection: null` must
    survive as `null` and not be defaulted.
  - **Verify:** reads back a service deployed by hand.
  - **Dependencies:** T1 · **Files:** `test-integration/support/gcp-client.ts` · **S**

- [ ] **T7: `withStack` lifecycle helper**
  - **Description:** up → yield outputs → destroy in `finally`, teardown result asserted.
  - **Acceptance:** a thrown assertion still destroys; a failed destroy fails the test.
  - **Verify:** a fixture test that throws on purpose leaves the project empty.
  - **Dependencies:** T2, T6 · **Files:** `test-integration/support/sandbox.ts` (+1 test) · **S**

- [ ] **T8: CR-06 — provider-vs-API divergence**
  - **Description:** Assert state says `true` and the v2 API says `null`. The divergence *is* the
    assertion, so a provider change that closes it fails the suite and forces the mapping update.
  - **Acceptance:** both readings asserted; the test names the *Known gaps* entry it guards.
  - **Verify:** `npm run test:integration -- --project=deploy`
  - **Dependencies:** T7 · **Files:** `test-integration/deploy/deletion-protection.test.ts` · **S**

- [ ] **T9: CR-01, CR-03, CR-07, CR-08 enforced**
  - **Description:** Transcribe the manual run's readings: ingress
    `internal-and-cloud-load-balancing` vs `all`; no invoker bindings vs exactly one `allUsers`;
    no URL assigned vs URL serving 200; description and `runway-public: true` label present only
    on the public service.
  - **Acceptance:** four controls asserted against the live API, private and public paths both.
  - **Verify:** `npm run test:integration -- --project=deploy`
  - **Dependencies:** T7 · **Files:** `test-integration/deploy/ingress.test.ts`,
    `invoker-binding.test.ts` · **M**

- [ ] **T10: Emptiness assertion and failure injection**
  - **Description:** Assert the project is empty after a run. Then **prove the tier can fail**:
    weaken a control on a scratch branch and confirm it goes red.
  - **Acceptance:** a killed mid-deploy run is caught by the next emptiness check; the weakened
    control turns the tier red, and the transcript is recorded in the plan.
  - **Verify:** kill a run on purpose; run the scratch branch.
  - **Dependencies:** T8, T9 · **Files:** `test-integration/deploy/sandbox-empty.test.ts` · **S**
  - **This is the acceptance gate for the whole tier.** Until failure injection is demonstrated,
    the suite is unproven — which is the entire objection to emulators, applied to ourselves.

**Checkpoint — Tier B.** Every control asserted against the live API · project empty after a failed
run · failure injection demonstrated · **human review before CI.**

### Phase 4: CI

- [ ] **T11: Enable the remaining API(s) on the sandbox** — *mostly done already*
  - **Description:** ~~`iam`, `cloudresourcemanager`, `binaryauthorization`~~ — **re-scoped after
    reading the state rather than trusting the document.** `compute.googleapis.com` was enabled
    2026-08-25 on explicit request (a T2 finding), and `iam.googleapis.com` was found **already
    enabled**, contradicting SPEC.md OQ3. Only `cloudresourcemanager.googleapis.com` is definitely
    outstanding; `binaryauthorization.googleapis.com` is not needed while CR-09 stays out of scope
    (Open Question 4).
  - **Acceptance:** enabled state read back per-API by exact match, never by grep — "no matches"
    and "the command failed" are not the same answer. **This is what caught the stale `iam`
    reading**, so the rule earned its place twice.
  - **Verify:** `gcloud services list --enabled --project enduring-badge-506610-u9
    --filter='config.name=<api>'`, one API at a time. **`--project` is not optional**: this
    machine's active gcloud project is `project-4da1a7fd-3681-4524-853`, the live one.
  - **Dependencies:** none technically; sequenced here so nothing mutates GCP before it is needed · **XS**
  - **Mutates a real project.** Reversible, and does not decide
    [SPEC.md OQ4](../SPEC.md#open-questions) — enabling BinAuthz's API is not defaulting it on.

- [ ] **T12: `integration` workflow**
  - **Description:** `root.github.addWorkflow("integration")` in `.projenrc.ts`, matching the
    existing `security` workflow. Nightly schedule + `workflow_dispatch`; **no `pull_request`**.
    Teardown with `if: always()`.
  - **Acceptance:** contract assertions in `test/ci.test.ts` — no `pull_request` trigger, sandbox
    project id pinned, teardown `if: always()`.
  - **Verify:** `npm run build`; `npx projen` idempotent; one `workflow_dispatch` run green.
  - **Dependencies:** T10, T11 · **Files:** `.projenrc.ts`, `test/ci.test.ts`, generated workflow · **M**

**Checkpoint — Complete.** Ten consecutive green nights (see Risk 4) before the tier is called done.

## Risks and Mitigations

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| 1 | **The policy pack cannot load from inside this monorepo.** The pack runner hardcodes ts-node on and never reads `PulumiPolicy.yaml`; Pulumi's vendored fallback fires only when `require("typescript")` *throws*, and TS 7 imports fine. T5 needs the pack against a real plan. | **High — blocks T5** | Install the pack into a temp tree where `typescript` does not resolve, as [SPEC.md](../SPEC.md#tech-stack) records working. Scoped into T5; if it proves unworkable, T5 ships as preview-only and CR-03's gap entry **stays**. |
| 2 | Stack fixtures must be precompiled JS or Pulumi dies in ts-node | High | T2 first, before anything depends on the harness |
| 3 | A leaked deployment quietly accrues cost | Low | destroy in `finally` *and* `if: always()`; T10's emptiness assertion is the backstop |
| 4 | Nightly flakiness gets the tier muted | Medium | Flakiness treated as a defect. Quota and propagation retried with bounded, logged backoff; nothing else retried |
| 5 | Integration tests are mistaken for mapping coverage | Medium | Every control keeps its unit test in `packages/gcp-components/test/`; `control-mapping.test.ts` is unchanged by this plan |
| 6 | **`compute.googleapis.com` is disabled** (found in T2). The provider probes it to validate regions and warns on every run | Low for Tier A — it is a warning and `preview` exits 0 | Recorded, not acted on. **Outside the 2026-08-25 three-API approval**; if T8 shows `up` needs it, raise a fresh Ask-first rather than letting the tier widen its own permissions. The cost of leaving it is a permanent warning nobody reads |

## Definition of Done

Inherits the repo bar, plus:

- [ ] Acceptance criteria met by running it, not by typechecking
- [ ] `npm run build`, `npm test`, `npm run lint` pass at the root across both packages
- [ ] **The PR gate remains credential-free and offline, with runtime unchanged**
- [ ] No `any`, no non-null assertions outside tests, no `TODO` markers
- [ ] Every control asserted here still has its unit test and mapping row
- [ ] Failure injection demonstrated at least once (T10)
- [ ] Human review before each task is checked off

## Open Questions

1. **Interim CI credential.** `environment-provisioning` (EP-03) owns WIF and is unbuilt. Run T12
   on `workflow_dispatch` with a local credential until it lands, or hold T12 entirely?
   Recommendation: ship T12 on `workflow_dispatch`, since T1–T11 deliver value without a schedule.
2. **Ten green nights is a guess** — a stand-in for "stable enough to trust". If pre-release is the
   only moment this tier's verdict is acted on, a shorter bar is defensible.
3. **Stack secret provider.** T2 created the `integration` stack on the local file backend with
   `PULUMI_CONFIG_PASSPHRASE=integration`, and `Pulumi.integration.yaml` now carries the matching
   `encryptionsalt`. The salt is not a secret and is safe to commit, but the passphrase is now a
   value CI must supply. Keep the passphrase (a GitHub secret, one more thing to rotate), or move
   the tier to `--secrets-provider=passphrase` with a generated value per run given no fixture
   stores a secret at all? Decide in T7, before T12 wires CI.
4. **Does Tier B cover Binary Authorization (CR-09)?** T9 covers CR-01/03/07/08. CR-09 needs an
   attestor and org-level setup, and [SPEC.md OQ4](../SPEC.md#open-questions) has not decided
   whether BinAuthz defaults on. Currently **out of scope** — confirm.
