# Tasks: Platform

One ordered list across both modules, in approved build order. Plan and rationale:
[tasks/plan.md](plan.md). Every task also clears the project-wide Definition of Done in the plan.

- **Tasks 1–12** — `gcp-components` ([spec](../SPEC-gcp-components.md))
- **Tasks 13–22** — `runway-cli` ([spec](../SPEC-runway-cli.md))

---

# Part 1: gcp-components

---

## Phase 1: Foundation

### Task 1: Bootstrap the projen monorepo
Stand up `platform/` as a projen-managed pnpm monorepo with both packages declared. Nothing is
built on top until this is proven idempotent — every generated file in the repo comes from here.

**Acceptance criteria**
- [ ] `.projenrc.ts` declares a root project plus `packages/gcp-components` and `packages/runway-cli` as subprojects via `parent` + `outdir`
- [ ] `pnpm-workspace.yaml` is generated as a projen `YamlFile`, not hand-written
- [ ] TypeScript 7.0.2 and vitest 4.1.11 resolve and run; **if projen cannot drive TS 7, stop and report before falling back**
- [ ] `.gitignore` covers `.pulumi/`, `node_modules/`, `dist/`, and any credential file pattern

**Verification**
- [ ] `npx projen && pnpm install && pnpm build && pnpm test && pnpm lint` — all pass from a clean clone
- [ ] `npx projen` run twice produces zero diff on the second run (`git diff --exit-code`)
- [ ] `git status` is clean afterwards — no generated file left untracked and unignored

**Dependencies:** None
**Files:** `.projenrc.ts`, `.gitignore`, plus projen-generated `package.json` / `pnpm-workspace.yaml` / `tsconfig.json`
**Scope:** M — highest-risk task in the plan; see the TS 7 and pnpm-workspace risks

---

### Task 2: Pulumi mock test harness
Prove `pulumi.runtime.setMocks()` works under vitest 4 before any component depends on it. Exists
solely to isolate this risk — its throwaway assertion is replaced by real tests in Task 3.

**Acceptance criteria**
- [ ] `test/setup.ts` installs Pulumi mocks and exports a `resolve<T>(output: pulumi.Output<T>): Promise<T>` helper
- [ ] A proof-of-life test constructs a raw `gcp.serviceaccount.Account` and resolves one `Output` value
- [ ] The suite runs with no `GOOGLE_APPLICATION_CREDENTIALS` and no network access

**Verification**
- [ ] `pnpm --filter @runway/gcp-components test` passes
- [ ] Passes with credentials explicitly unset and network disabled — confirms no live provider call
- [ ] Test completes in under 5s (a slow run means it is reaching for something real)

**Dependencies:** Task 1
**Files:** `packages/gcp-components/test/setup.ts`, `packages/gcp-components/test/harness.test.ts`
**Scope:** S

---

### ✅ Checkpoint 1: Foundation
- [ ] Monorepo builds, tests, and lints clean from a fresh clone
- [ ] `npx projen` is idempotent
- [ ] Pulumi mocks resolve outputs offline under vitest
- [ ] **The two high-risk toolchain unknowns are settled — TS 7 and vitest+Pulumi both confirmed working, or fallbacks agreed with the human**
- [ ] Human review before proceeding

---

## Phase 2: Walking Skeleton

Proves all three hardening layers on one component before repeating the pattern.

### Task 3: `SecureServiceAccount` and shared conventions
First real component: a dedicated runtime identity with hardened defaults, plus the naming and
labelling conventions every later component consumes.

**Acceptance criteria**
- [ ] `conventions/naming.ts` derives resource names deterministically; `conventions/labels.ts` applies the mandatory label set
- [ ] `SecureServiceAccount` wraps `gcp.serviceaccount.Account`, exposes `.email` as `Output<string>`, and exposes **no** path to `gcp.serviceaccount.Key`
- [ ] Exported from `src/index.ts`; every args member has TSDoc
- [ ] `docs/control-mapping.md` created with its first rows, establishing the `Control | Source | Component | Test` format

**Verification**
- [ ] `pnpm --filter @runway/gcp-components test` — named tests for each hardened default pass
- [ ] `grep -r "serviceaccount.Key" packages/gcp-components/src` returns nothing
- [ ] Every mapping row added names a test that exists and passes

**Dependencies:** Task 2
**Files:** `src/conventions/naming.ts`, `src/conventions/labels.ts`, `src/service-account/secure-service-account.ts`, `src/index.ts`, `docs/control-mapping.md` (+ tests)
**Scope:** M — at the upper edge; split if conventions grow beyond naming and labels

---

### Task 4: Role allowlist enforcement
The guardrail half of Task 3: the component must *refuse* over-privileged roles at construction,
not merely avoid granting them.

**Acceptance criteria**
- [ ] `role-allowlist.ts` rejects `roles/owner`, `roles/editor`, and any `*Admin` role
- [ ] Rejection throws at construction with an actionable message naming the role and the alternative
- [ ] Table-driven test covers each rejected role and at least two permitted ones

**Verification**
- [ ] `pnpm --filter @runway/gcp-components test -t "role allowlist"` passes
- [ ] Each rejection case asserts on the thrown message, not just that it threw
- [ ] Mapping rows for CIS IAM controls (user-managed keys, over-privileged accounts) link to these tests

**Dependencies:** Task 3
**Files:** `src/service-account/role-allowlist.ts`, `src/service-account/secure-service-account.ts`, `test/service-account/role-allowlist.test.ts`, `docs/control-mapping.md`
**Scope:** S
**Blocked on:** Open question 4 — denylist as specified, or the safer explicit allowlist

---

### Task 5: Policy pack harness and first rule
Third hardening layer: catch consumers who skip our components and declare raw resources. Isolated
because `@pulumi/policy` has no documented offline test harness.

**Acceptance criteria**
- [ ] `policy/index.ts` defines a `PolicyPack` with `enforcementLevel: "mandatory"`
- [ ] `policy/rules/no-service-account-keys.ts` rejects any `gcp.serviceaccount.Key`
- [ ] A repeatable test harness exercises a rule offline; **if none is achievable, stop and report before falling back to pure-predicate testing**

**Verification**
- [ ] `pnpm --filter @runway/gcp-components test -t "policy"` passes
- [ ] A fixture stack declaring `serviceaccount.Key` is rejected; one using `SecureServiceAccount` passes clean
- [ ] Violation message names the resource and the remediation

**Dependencies:** Task 3
**Files:** `policy/index.ts`, `policy/rules/no-service-account-keys.ts`, `test/policy/setup.ts`, `test/policy/no-service-account-keys.test.ts`
**Scope:** M

---

### ✅ Checkpoint 2: Walking Skeleton
- [ ] One component complete across all three layers — defaults, assertions, policy rule, mapping rows
- [ ] Negative paths proven: over-privileged role throws, raw `serviceaccount.Key` is rejected
- [ ] Test suite still runs offline with no credentials
- [ ] **The component pattern is settled — Tasks 6 and 8 are repetition, not invention**
- [ ] `conventions/` and the test harness are frozen; parallel streams may open
- [ ] Human review before proceeding

---

## Phase 3: Remaining Components

Stream A (Tasks 6–7) and Stream B (Tasks 8–10) are independent and may run in parallel.

### Task 6: `SecureArtifactRepository` — Stream A
Docker repository with immutable tags and vulnerability scanning on by default.

**Acceptance criteria**
- [ ] `format: "DOCKER"`, `dockerConfig.immutableTags: true`, `vulnerabilityScanningConfig.enablementConfig: "INHERITED"`
- [ ] `cleanupPolicies` retains N most recent and deletes untagged beyond the agreed age
- [ ] `kmsKeyName` accepted as an optional CMEK arg but not required
- [ ] Exported from `src/index.ts` with mapping rows added

**Verification**
- [ ] `pnpm --filter @runway/gcp-components test -t "SecureArtifactRepository"` passes
- [ ] A named test asserts each of the four defaults on resolved outputs
- [ ] Constructing with only required args yields the fully hardened configuration

**Dependencies:** Task 3 (conventions)
**Files:** `src/artifact-registry/secure-artifact-repository.ts`, `src/index.ts`, `test/artifact-registry/secure-artifact-repository.test.ts`, `docs/control-mapping.md`
**Scope:** M
**Blocked on:** Open question 5 — retention count and untagged age

---

### Task 7: Artifact Registry policy rule — Stream A
**Acceptance criteria**
- [ ] Rule rejects any `artifactregistry.Repository` without `immutableTags`
- [ ] Registered in the pack; violation message names the remediation

**Verification**
- [ ] `pnpm --filter @runway/gcp-components test -t "policy"` passes
- [ ] Fixture with a non-immutable repository is rejected; `SecureArtifactRepository` passes clean

**Dependencies:** Tasks 5, 6
**Files:** `policy/rules/require-immutable-tags.ts`, `policy/index.ts`, `test/policy/require-immutable-tags.test.ts`
**Scope:** S

---

### Task 8: `SecureContainerService` — Stream B
Cloud Run v2 service, private by default, with the runtime identity enforced by the type system.

**Acceptance criteria**
- [ ] `ingress: "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"`, `deletionProtection: true`, `defaultUriDisabled: true` by default
- [ ] `serviceAccount` is a **required** arg typed as `SecureServiceAccount` — the default compute SA is unreachable through the API
- [ ] No `allUsers` invoker binding emitted; `template.vpcAccess` omitted entirely per planning assumption 5
- [ ] Binary Authorization opt-in, not default-on (planning assumption 1)

**Verification**
- [ ] `pnpm --filter @runway/gcp-components test -t "SecureContainerService"` passes
- [ ] A named test per default, asserting resolved output values
- [ ] Omitting `serviceAccount` is a **compile-time** failure — verified by a type-level test, not a runtime one

**Dependencies:** Task 3
**Files:** `src/container-service/secure-container-service.ts`, `src/index.ts`, `test/container-service/secure-container-service.test.ts`, `docs/control-mapping.md`
**Scope:** M

---

### Task 9: Justified `publicAccess` opt-out — Stream B
The escape-hatch convention that makes every deliberate deviation greppable and auditable. The
single most reusable decision in the spec — it gets its own slice so its negative paths are proven,
not appended.

**Acceptance criteria**
- [ ] `publicAccess?: false | { justification: string }`; a bare `true` is a type error
- [ ] Supplying it flips ingress to `ALL`, emits the `allUsers` invoker binding, **and** records the justification as a resource label
- [ ] Empty or whitespace-only justification throws at construction

**Verification**
- [ ] `pnpm --filter @runway/gcp-components test -t "publicAccess"` passes
- [ ] Test proves the label is present and carries the justification text — auditable via `gcloud` without reading source
- [ ] Type-level test proves `publicAccess: true` does not compile

**Dependencies:** Task 8
**Files:** `src/container-service/secure-container-service.ts`, `test/container-service/public-access.test.ts`, `docs/control-mapping.md`
**Scope:** S

---

### Task 10: Cloud Run policy rule — Stream B
**Acceptance criteria**
- [ ] Rule rejects any raw `cloudrunv2.Service` with `ingress: "INGRESS_TRAFFIC_ALL"` lacking a justification label
- [ ] A service built via `SecureContainerService` with a justified `publicAccess` passes clean

**Verification**
- [ ] `pnpm --filter @runway/gcp-components test -t "policy"` passes
- [ ] Both fixtures behave as specified — this is the rule that proves the opt-out and the pack agree

**Dependencies:** Tasks 5, 9
**Files:** `policy/rules/no-unjustified-public-ingress.ts`, `policy/index.ts`, `test/policy/no-unjustified-public-ingress.test.ts`
**Scope:** S

---

### ✅ Checkpoint 3: Components Complete
- [ ] All three components exported, hardened, and covered by named tests
- [ ] Policy pack carries a rule per component and rejects every bypass fixture
- [ ] Full suite runs offline in under 30s
- [ ] Human review — **component APIs are frozen here**; re-read them before Task 15, which was planned against assumptions rather than real signatures

---

## Phase 4: Enforcement and Integration

### Task 11: Control-mapping completeness gate
Make the spec's central claim mechanically true: a control without a test is not a control.

**Acceptance criteria**
- [ ] A test parses `docs/control-mapping.md` and asserts every row names a test that exists in the suite
- [ ] The gate fails on a row naming a nonexistent test, and on a hardened default with no row
- [ ] Failure output names the offending row and what is missing

**Verification**
- [ ] `pnpm --filter @runway/gcp-components test -t "control mapping"` passes
- [ ] Deliberately adding a bogus row makes it fail; removing the row makes it pass again
- [ ] Every existing row resolves to a passing test

**Dependencies:** Tasks 7, 10
**Files:** `test/control-mapping.test.ts`, `docs/control-mapping.md`
**Scope:** S

---

### Task 12: Integration preview against a real GCP project — 🚫 BLOCKED
The only task needing credentials. Pulumi mocks return synthetic values, so until this runs, every
hardening claim is *asserted* rather than *verified against GCP*.

**Blocked on:** written confirmation that `project-4da1a7fd-3681-4524-853` (or another project) is a
disposable sandbox. **No GCP call will be made before that.**

**Acceptance criteria**
- [ ] `pulumi preview --policy-pack packages/gcp-components/policy` on a fixture stack succeeds with zero violations
- [ ] The plan contains exactly three resource groups — service account, artifact repository, Cloud Run service
- [ ] Nothing in the plan is publicly reachable
- [ ] Any divergence between mocked assertions and the real provider is recorded as a follow-up

**Verification**
- [ ] `pulumi preview` exits 0
- [ ] Plan output reviewed by a human before any `pulumi up` is even discussed
- [ ] Runs as a nightly job, never on the PR gate

**Dependencies:** Task 11
**Files:** `test/integration/fixture-stack/`, CI workflow
**Scope:** S

---

### ✅ Checkpoint 4: Module Complete
- [ ] Every success criterion in [SPEC-gcp-components.md](../SPEC-gcp-components.md#success-criteria) is met
- [ ] Project-wide Definition of Done satisfied for every task
- [ ] Package publishes with an independent semver tag
- [ ] `runway-cli` can depend on a pinned, published version
- [ ] Human sign-off

---

# Part 2: runway-cli

Begins after Checkpoint 4. Spec: [SPEC-runway-cli.md](../SPEC-runway-cli.md).

## Phase 5: Scaffold Foundation

### Task 13: Build-out test harness
Every later task is verified by scaffolding into a temp directory and building the result for real.
That harness must first solve two hard problems: resolving unpublished workspace packages, and
installing fast enough to sit on a PR gate.

**Acceptance criteria**
- [ ] Helper scaffolds a project into a temp dir, runs `npx projen && pnpm install && pnpm build && pnpm test && pnpm lint`, and returns structured pass/fail with captured output
- [ ] Unpublished `@runway/gcp-components` and `@runway/cli` resolve via pnpm `workspace:`/`file:` protocol; the production path uses exact published versions
- [ ] Temp dirs are cleaned up on both success and failure
- [ ] A deliberately broken fixture makes the harness fail with the underlying build error surfaced, not swallowed

**Verification**
- [ ] `pnpm --filter @runway/cli test -t "build-out harness"` passes
- [ ] Harness completes in under 60s using a warm pnpm store
- [ ] Failure output names the failing command and shows its stderr

**Dependencies:** Checkpoint 4
**Files:** `packages/runway-cli/test/harness/build-out.ts`, `packages/runway-cli/test/harness/build-out.test.ts`
**Scope:** M — highest-risk task in Part 2; the bootstrapping paradox lands here

---

### Task 14: `RunwayServiceProject` — a repo that builds
Walking skeleton. The projen project type emitting the minimum that builds, tests, and lints. No
infra, no container, no CI yet — those are later slices onto a proven base.

**Acceptance criteria**
- [ ] `RunwayServiceProject` subclasses `projen.typescript.TypeScriptProject` and is exported from the package
- [ ] Emits `.projenrc.ts`, `src/index.ts` (health endpoint only), `test/index.test.ts` (one passing test), `README.md`
- [ ] Generated `.projenrc.ts` imports the project type by name, so the repo can regenerate itself later
- [ ] Zero `TODO` markers, commented-out code, or "delete this if unused" scaffolding in any emitted file

**Verification**
- [ ] Build-out harness: scaffolded repo passes `npx projen && pnpm install && pnpm build && pnpm test && pnpm lint` unmodified
- [ ] Test asserts the exact emitted file tree — no extra files
- [ ] `grep -rE "TODO|FIXME|XXX" <scaffold>` returns nothing

**Dependencies:** Task 13
**Files:** `src/templates/runway-service-project.ts`, `src/files/README.md.ts`, `src/index.ts`, `test/templates/runway-service-project.test.ts`
**Scope:** M

---

### ✅ Checkpoint 5: Scaffold Foundation
- [ ] A scaffolded repo builds, tests, and lints unmodified
- [ ] The bootstrapping paradox is solved — workspace and published resolution both proven
- [ ] Build-out gate runs fast enough for CI; **if it exceeds ~3 min, decide now whether it moves to a merge queue**
- [ ] Human review before proceeding

---

## Phase 6: Scaffold Content

Streams C, D, and E are independent and may run in parallel.

### Task 15: `infra/` composing gcp-components — Stream C
The load-bearing artifact. This is the worked example every team copies, so it must demonstrate
correct composition and never raw resources.

**Re-read the real `gcp-components` API before starting** — this task was planned before those
signatures existed.

**Acceptance criteria**
- [ ] Emits `infra/Pulumi.yaml` and `infra/index.ts` composing `SecureServiceAccount` + `SecureArtifactRepository` + `SecureContainerService`
- [ ] Zero raw `gcp.*` resource declarations
- [ ] `@runway/gcp-components` pinned to an exact published version
- [ ] GCP project and region come from Pulumi config, never baked in as generated literals

**Verification**
- [ ] Build-out harness: generated `infra/index.ts` typechecks against real component types
- [ ] `grep -E "new gcp\." <scaffold>/infra/index.ts` returns nothing
- [ ] `grep -rE "project-[0-9a-f]{8}|europe-west" <scaffold>/infra/index.ts` returns nothing — no hardcoded identifiers

**Dependencies:** Task 14
**Files:** `src/files/pulumi-yaml.ts`, `src/files/infra-index.ts`, `src/templates/runway-service-project.ts`, `test/templates/infra.test.ts`
**Scope:** M

---

### Task 16: Service skeleton and Dockerfile — Stream D
**Acceptance criteria**
- [ ] Dockerfile is multi-stage, distroless base, runs as a non-root user, no build tooling in the final layer
- [ ] `src/index.ts` serves a health endpoint and nothing else — no sample REST API, no database layer
- [ ] Container image builds from the scaffolded repo without edits

**Verification**
- [ ] `docker build` on the scaffolded repo succeeds
- [ ] `docker run` responds 200 on the health endpoint
- [ ] `docker inspect` confirms a non-root `USER`

**Dependencies:** Task 14
**Files:** `src/files/dockerfile.ts`, `src/files/service-index.ts`, `src/templates/runway-service-project.ts`, `test/templates/container.test.ts`
**Scope:** M

---

### Task 17: Generated CI workflow — Stream E
**Acceptance criteria**
- [ ] Emits a GitHub Actions workflow running build, test, lint, and `pulumi preview` on PR
- [ ] `pulumi preview` step fails closed with an actionable message when GCP credentials are absent
- [ ] Workflow references the CrossGuard policy pack from `@runway/gcp-components`
- [ ] No credentials, project IDs, or secrets baked into the generated workflow

**Verification**
- [ ] Test asserts workflow shape — job names, step order, policy-pack flag present
- [ ] Workflow YAML parses and validates (`actionlint` or equivalent)
- [ ] `grep -rE "AIza|-----BEGIN|projects/[0-9]+" <scaffold>/.github` returns nothing

**Dependencies:** Task 14
**Files:** `src/templates/runway-service-project.ts`, `src/files/ci-workflow.ts`, `test/templates/ci.test.ts`
**Scope:** S

---

### ✅ Checkpoint 6: Scaffold Content Complete
- [ ] Scaffolded repo builds, containerises, and its infra typechecks against real components
- [ ] Generated stack composes components only — zero raw `gcp.*`
- [ ] No secrets, project IDs, or regions baked into any generated file
- [ ] Human review before proceeding

---

## Phase 7: CLI Surface

### Task 18: CLI entry point — `runway new` — 🚫 BLOCKED
**Blocked on:** SPEC.md Open Question 5. A global `bin`, an `npx` entry, and a projen external
project type produce materially different code here. Deliberately the only task that depends on
this answer — everything before it is distribution-agnostic.

**Acceptance criteria**
- [ ] `runway new <name> --gcp-project <id> --region <r>` scaffolds via `RunwayServiceProject`
- [ ] `src/cli.ts` handles parsing and dispatch only; no scaffolding logic
- [ ] Invalid service names are rejected with an actionable message before any file is written
- [ ] Scaffold `git init`s and makes one initial commit (per plan recommendation — confirm)

**Verification**
- [ ] Build-out harness end to end through the real CLI entry point, not the project type directly
- [ ] Invalid-name cases exit non-zero and write nothing (`ls` on target confirms empty)
- [ ] `--help` documents every flag

**Dependencies:** Task 14 (+ Checkpoint 6 for a complete scaffold)
**Files:** `src/cli.ts`, `src/commands/new.ts`, `test/commands/new.test.ts`
**Scope:** M

---

### Task 19: Scaffold guardrails
Destructive-write protection. Separated from Task 18 so the refusal paths are proven rather than
appended to a task that already "works".

**Acceptance criteria**
- [ ] `runway new` into a non-empty directory refuses and writes nothing unless `--force` is passed
- [ ] `--dry-run` prints the file tree and writes nothing
- [ ] Never writes outside the target directory; a traversal attempt in the name is rejected
- [ ] Never runs `git push` or `pulumi up`

**Verification**
- [ ] `pnpm --filter @runway/cli test -t "guardrails"` passes
- [ ] Non-empty-dir test asserts the pre-existing file is byte-identical afterwards
- [ ] `--dry-run` test asserts the target directory is still empty
- [ ] Traversal fixture (`../escape`) is rejected

**Dependencies:** Task 18
**Files:** `src/commands/new.ts`, `src/safety/target-dir.ts`, `test/commands/guardrails.test.ts`
**Scope:** S

---

### Task 20: `runway doctor`
Independent of all scaffolding — may run any time after Task 13.

**Acceptance criteria**
- [ ] Reports node, pnpm, pulumi, and gcloud presence and version against required minimums
- [ ] Reports gcloud auth status without printing the account address or any token
- [ ] Every failure line carries a concrete fix instruction
- [ ] Exits non-zero if any required tool is missing or below minimum

**Verification**
- [ ] `pnpm --filter @runway/cli test -t "doctor"` passes
- [ ] Tests stub each tool as missing, outdated, and current; assert exit code and message per case
- [ ] Output contains no credential material

**Dependencies:** Task 13
**Files:** `src/commands/doctor.ts`, `src/doctor/tool-checks.ts`, `test/commands/doctor.test.ts`
**Scope:** S

---

### ✅ Checkpoint 7: CLI Complete
- [ ] `runway new` and `runway doctor` both work end to end
- [ ] Every destructive path refuses safely and writes nothing
- [ ] Distribution question resolved and the shipped entry point matches it
- [ ] Human review before proceeding

---

## Phase 8: Enforcement and Acceptance

### Task 21: Idempotence and minimality gate
Makes the spec's two structural constraints mechanically true rather than review-enforced.

**Acceptance criteria**
- [ ] Test runs `npx projen` twice in a scaffolded repo and asserts zero diff on the second run
- [ ] Test counts generated lines excluding lockfiles and projen-generated config, and fails above 200
- [ ] Failure output names the largest contributing files, so the fix is obvious

**Verification**
- [ ] `pnpm --filter @runway/cli test -t "idempotence"` and `-t "minimality"` pass
- [ ] Adding a deliberate 300-line file makes the budget test fail and name it
- [ ] **If the real scaffold cannot meet 200 lines, stop and revise the number deliberately — do not quietly raise the threshold**

**Dependencies:** Tasks 15, 16, 17, 19
**Files:** `test/scaffold/idempotence.test.ts`, `test/scaffold/minimality.test.ts`
**Scope:** S

---

### Task 22: End-to-end acceptance — 🚫 PARTLY BLOCKED
Proves [SPEC.md Success Criteria](../SPEC.md#success-criteria) 1–3 as executable checks.

**Blocked on:** criterion 3 needs the sandbox GCP project confirmation. Criteria 1 and 2 are
offline and can complete now.

**Acceptance criteria**
- [ ] Clean-clone check: `npx projen && pnpm build && pnpm test` passes with no GCP credentials present
- [ ] `runway new demo` output passes its own build, test, and lint unmodified
- [ ] *(blocked)* `pulumi preview` on the generated repo plans exactly three resource groups, nothing publicly reachable
- [ ] Both packages publish with independent semver tags

**Verification**
- [ ] Full suite green from a fresh clone with credentials explicitly unset
- [ ] *(blocked)* `pulumi preview` output reviewed by a human before any `pulumi up` is discussed
- [ ] `npm pack --dry-run` on both packages shows the expected file list and no stray sources

**Dependencies:** Tasks 12, 21
**Files:** `test/acceptance/`, CI workflow
**Scope:** M

---

### ✅ Checkpoint 8: Initiative Complete
- [ ] Every success criterion in [SPEC.md](../SPEC.md#success-criteria) met and demonstrated
- [ ] Every success criterion in both module specs met
- [ ] Definition of Done satisfied for all 22 tasks
- [ ] A developer with no prior GCP knowledge can run one command and land a private, hardened Cloud Run service
- [ ] Human sign-off
