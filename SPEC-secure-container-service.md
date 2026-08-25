# Spec: SecureContainerService (Cloud Run)

First component of module [`gcp-components`](SPEC-gcp-components.md) in the
[Platform capability map](SPEC.md#capability-map). Toolchain, code style, and boundaries are
inherited from [SPEC.md](SPEC.md); this spec adds only what is specific to the Cloud Run component.

**Verified against `@pulumi/gcp@9.35.1`** — every arg, enum, and nested type named below was read
from the shipped `.d.ts`, not from memory. [SPEC.md](SPEC.md#tech-stack) pins `9.35.0`; bump it.

## Objective

A Pulumi `ComponentResource` wrapping `gcp.cloudrunv2.Service` such that the default construction
is private, runs under a caller-supplied user-managed service account, and cannot be made publicly
reachable without a justification string that is recorded on the resource itself.

**Who it is for:** service developers who will type `new SecureContainerService(...)` and read no
security documentation. Every control below must hold for someone who passes only the three
required args.

**Why this component first.** It is the one resource in v1 scope that a service cannot do without,
and it is where the module's central claim is either true or false: that the insecure path costs
more keystrokes than the secure one.

## Scope Decisions

Four decisions were taken before writing this spec. They are recorded here because each one
contradicts something a reader would otherwise assume from [SPEC-gcp-components.md](SPEC-gcp-components.md).

### 1. ~~The service account is an email string~~ — it is a `SecureServiceAccount`

**Superseded in D4, which is the outcome this decision was always waiting for.** The original text
recorded a deliberate reduction: `SecureServiceAccount` did not exist, so v1 accepted
`serviceAccountEmail: pulumi.Input<string>` and validated it at runtime — trading a compile-time
guarantee for a runtime one, and recording the debt.

The argument is now `serviceAccount: SecureServiceAccount`. A `SecureServiceAccount`'s email is
derived from an account id and a project, so it is always user-managed: the Google-managed default
identities are **unreachable rather than rejected**. There is no value of this argument that names
one, which is the guarantee [SPEC-gcp-components.md](SPEC-gcp-components.md) promised from the
start.

**The untestable half went with it.** The string form needed validation inside `apply` for `Output`
inputs, and a throw there is observable only as a rejected promise — `Output` exposes no rejection
path publicly, and its internal one leaks unhandled rejections that vitest treats as fatal. That
gap was documented in C4 and closed only by the integration run. With no string to validate there is
no `apply`-time check left, so the gap does not exist rather than being worked around. A
`@ts-expect-error` assertion, mutation-tested, holds the argument shut.

**The runtime check remains where it still matters.** `assertUserManagedServiceAccount` is unchanged
and still backs CR-04's policy rule, because a consumer writing a raw `gcp.cloudrunv2.Service`
bypasses the type system entirely. The type guards this component; the policy pack guards the rest.

### 2. v1 exposes Binary Authorization, and nothing else optional

Approved v1 surface: **Binary Authorization, opt-in.** `vpcAccess`, CMEK (`template.encryptionKey`),
and IAP (`iapEnabled`) are **out of v1** and must not appear in the args interface — not as
optional fields, not commented out.

**Correction to [SPEC.md Open Question 4](SPEC.md#open-questions).** That question assumes Binary
Authorization "requires an attestor". At this API level it does not. The verified type is:

```ts
interface ServiceBinaryAuthorization {
  breakglassJustification?: pulumi.Input<string | undefined>;
  policy?: pulumi.Input<string | undefined>;   // projects/{p}/platforms/cloudRun/{policy-name}
  useDefault?: pulumi.Input<boolean | undefined>;
}
```

No attestor field exists. The resource selects the project's default policy or names one by path;
attestors are configured on the *policy*, out of band. Open Question 4 should be closed on those
terms rather than answered as written.

It stays opt-in regardless: `useDefault: true` fails every deployment in a project that has no
BinAuthz policy configured, which is not a default a library may impose.

**`breakglassJustification` is never settable through this component.** It is the documented
mechanism for bypassing the policy. Exposing it would hand consumers an escape hatch from a control
the component exists to apply.

### 3. The justification is recorded in `description`, not in a label

[SPEC-gcp-components.md](SPEC-gcp-components.md) states that public exposure "records the
justification as a resource label — so it is auditable from `gcloud` without reading the source."

**A justification cannot be a label value.** GCP label values are limited to lowercase letters,
digits, `-` and `_`, max 63 characters. Any real sentence is rejected by the API, so the component
as specified would fail at deploy time on its own escape hatch.

What is specified instead — the auditability goal is met, the mechanism changes:

| Field | Value | Purpose |
|---|---|---|
| `description` | `"Public access justified: <justification>"` | Free text. Survives verbatim. |
| `labels["runway-public"]` | `"true"` | Label-safe. Makes `gcloud run services list --filter` work. |

Both appear only on the public path. `gcloud run services describe` shows the reason; the label
makes every public service in a project greppable without reading any source. That was the point.

### 4. Control mapping cites CIS only where CIS genuinely covers the control

Per the decision on [SPEC.md Open Question 1](SPEC.md#open-questions), `docs/control-mapping.md`
carries a `Source` column citing CIS where a control genuinely exists and Google's Cloud Run
security guidance otherwise.

**Binding rule for that column:** a CIS citation must name the benchmark version *and* control
number, and must be verified against the published benchmark before the row is committed. An
unverified citation is not downgraded to a vaguer CIS reference — it is replaced by the Google
guidance URL. **No control ID is ever inferred from a control's subject matter.**

The CIS GCP Foundations Benchmark has no Cloud Run section. Its IAM section is the only plausible
anchor here, and only for CR-04 (rejecting Google-managed default identities, which carry broad
project roles). That single candidate is marked `CIS: to verify` until someone reads the benchmark;
every other row cites Google. If verification does not happen, the row cites Google and loses
nothing.

## Component Contract

```ts
export interface SecureContainerServiceArgs {
  /** Region, e.g. "europe-west1". */
  readonly location: pulumi.Input<string>;

  /** Fully-qualified image reference. Digest-pinned in production. */
  readonly image: pulumi.Input<string>;

  /**
   * Runtime identity. Must be a user-managed service account
   * (`<id>@<project>.iam.gserviceaccount.com`). Google-managed default identities are
   * rejected — see CR-04.
   */
  readonly serviceAccountEmail: pulumi.Input<string>;

  /**
   * Expose the service to the public internet. Opt-out from the hardened default.
   * The justification is written to the service description and is required, not decorative.
   * @default false
   */
  readonly publicAccess?: false | { readonly justification: string };

  /**
   * Allow `pulumi destroy` to delete this service. Opt-out from the hardened default.
   * @default true (protected)
   */
  readonly deletionProtection?: true | { readonly disableJustification: string };

  /**
   * Binary Authorization. Opt-in: absent by default, because `useDefault` fails every
   * deployment in a project with no BinAuthz policy configured.
   * `breakglassJustification` is deliberately not exposed.
   */
  readonly binaryAuthorization?:
    | { readonly useDefault: true }
    | { readonly policy: pulumi.Input<string> };
}
```

**Emitted configuration.**

| Field | Private default | Public path (`publicAccess` set) |
|---|---|---|
| `ingress` | `INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER` | `INGRESS_TRAFFIC_ALL` |
| `defaultUriDisabled` | `true` | `false` |
| `deletionProtection` | `true` | `true` |
| `invokerIamDisabled` | never set | never set |
| `template.serviceAccount` | validated email | validated email |
| `description` | unset | `"Public access justified: …"` |
| `labels["runway-public"]` | unset | `"true"` |
| `ServiceIamMember(allUsers)` | not emitted | emitted, `roles/run.invoker` |

Verified enum: `ingress` accepts `INGRESS_TRAFFIC_ALL`, `INGRESS_TRAFFIC_INTERNAL_ONLY`,
`INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER`. **`INGRESS_TRAFFIC_UNSPECIFIED` is output-only** — it is
returned when no revision is active and must never be passed as input.
[SPEC-gcp-components.md](SPEC-gcp-components.md) lists the enum in short form (`ALL`,
`INTERNAL_LOAD_BALANCER`, …); the wire values carry the `INGRESS_TRAFFIC_` prefix.

**`invokerIamDisabled` is never exposed and never set.** It disables the IAM permission check on
`run.routes.invoke` — it makes a service callable with no invoker role at all, which is a wider
hole than `allUsers` and is invisible in an IAM policy dump. It has no legitimate use in this
component and the policy pack rejects it stack-wide.

**Exposed members:** `service: gcp.cloudrunv2.Service`, `uri: pulumi.Output<string>`,
`isPublic: boolean`. `uri` carries a TSDoc caveat that on the private path `defaultUriDisabled` is
`true`, so the value is present but not publicly resolvable.

**A default-constructed service is not reachable, on purpose.** With ingress restricted to an
internal load balancer and no networking module in v1, nothing routes to it until the consumer adds
a load balancer. That is the secure default working as designed, and the TSDoc says so — otherwise
the first developer to hit it will "fix" it with `publicAccess`.

## Hardening Controls

One row here, one row in `docs/control-mapping.md`, one named test, one policy rule.

| ID | Control | Enforced by | Source |
|---|---|---|---|
| CR-01 | Ingress defaults to internal load balancer only | default + policy | Google |
| CR-02 | Public exposure requires a non-empty justification | type + constructor | Google |
| CR-03 | No `allUsers` / `allAuthenticatedUsers` invoker binding unless public | default + policy | Google |
| CR-04 | Runtime SA required; Google-managed defaults rejected | validation + policy | CIS: to verify |
| CR-05 | `invokerIamDisabled` never set | not exposed + policy | Google |
| CR-06 | `deletionProtection` on unless justified | default | Google |
| CR-07 | `defaultUriDisabled` true whenever ingress is not `ALL` | default | Google |
| CR-08 | Justification recorded on the resource (`description` + label) | constructor | Google |
| CR-09 | Binary Authorization opt-in; breakglass never exposed | not exposed + policy | Google |

**Three enforcement layers, per the module spec.** Defaults in the constructor; Pulumi-mocked unit
assertions catching regressions in our code; a CrossGuard `PolicyPack`
(`enforcementLevel: "mandatory"`) catching the bypass case where a consumer declares a raw `gcp.*`
resource and skips the component entirely.

Policy rules in this component's slice, via `validateResourceOfType`:

- `gcp:cloudrunv2/service:Service` with `ingress: "INGRESS_TRAFFIC_ALL"` and no justification in
  `description` → **fail** (CR-01, CR-03)
- `gcp:cloudrunv2/service:Service` with `invokerIamDisabled: true` → **fail** (CR-05)
- `gcp:cloudrunv2/service:Service` whose `template.serviceAccount` is absent or not
  `*.iam.gserviceaccount.com` → **fail** (CR-04). The API types this field
  `Input<string | undefined>`, so omitting it is legal and silently yields the default compute SA.
  This rule is the only thing standing between a raw resource and that outcome.
- `gcp:cloudrunv2/serviceIamMember:ServiceIamMember` with `member` in
  `{allUsers, allAuthenticatedUsers}` and `role: "roles/run.invoker"`, where the target service
  carries no justification in `description` → **fail** (CR-03)
- `binaryAuthorization.breakglassJustification` set on any service → **fail** (CR-09)

**The rules key on intrinsic facts, not on the `runway-public` label — decided, see
[Open Questions](#open-questions) 2.** `ingress: ALL` and an `allUsers` invoker binding *are* what
make a service public: they cannot be stripped to evade a rule, because stripping them makes the
service private, which is the outcome the control wants. A label cannot carry that weight. It is a
self-asserted claim, and the consumer the policy pack exists to catch — the one hand-writing a raw
`gcp.*` resource — can add `labels: { "runway-public": "true" }` in two seconds and buy a silent
pass with no justification anywhere.

Keying on `description` does not make forgery impossible, and does not pretend to. It makes forgery
*cost a written justification*, which is the behaviour the control is trying to produce in the first
place. **`runway-public` remains only a filtering convenience** — it is what makes
`gcloud run services list --filter` useful, and it is not evidence of anything.

**Scope limit, stated plainly:** CrossGuard runs at `pulumi preview`/`up`. Nothing here detects a
`gcloud` edit made between deployments. That needs a detective control (Cloud Asset Inventory,
Security Command Center) and is out of v1 scope.

**Running the pack requires an isolated install — a correctness constraint, not packaging detail.**
Pulumi's policy-pack runner hardcodes ts-node on (`cmd/run-policy-pack/index.js:110`) and ignores
`PulumiPolicy.yaml`, so `typescript: false` does nothing there. It resolves `typescript` from
`@pulumi/pulumi`'s location and falls back to its vendored 3.8.3 only if that `require` **throws**.
TypeScript 7 imports fine but has no compiler API, so the fallback never fires and ts-node dies on
`ts.sys.readFile`.

**Correction to an earlier statement of this constraint.** C7 recorded it as *"the pack must be
consumed from a tree where `typescript` does not resolve"*. That was a location-dependent accident —
true only while the pack happened to sit outside any tree containing TypeScript. The real
requirement is narrower and more useful: **the nearest resolvable `typescript` must have a compiler
API.** Measured both ways: an isolated directory *inside* a TypeScript 7 repo fails when it contains
no TypeScript (resolution walks up and finds 7), and succeeds when it contains TypeScript 5.

`npm run policy:install --workspace @runway/gcp-components` creates that tree. Three properties of it
are load-bearing, each verified by a failure rather than by reasoning, and each asserted by test
because the failure mode is silent — the pack simply never loads and the stack goes unenforced:

| Property | Why | What happens without it |
|---|---|---|
| Its own `typescript@5.x`, **not** the repo's 7 | The runner needs a compiler API | `ts.sys.readFile` crash |
| Its own `@pulumi/pulumi` | Resolution starts from *its* location | Finds the consumer's TypeScript 7 |
| `--install-links` | npm **symlinks** a local package; Node resolves through the real path | Pack lands back in the monorepo, TypeScript 7 again |
| Outside `node_modules/` | `npm ci` deletes `node_modules` | Works locally, gone in CI |

**Verified end to end against a TypeScript 7 consumer**: a compliant program passes with
`✅ runway-gcp`, and a raw `gcp.cloudrunv2.Service` with `ingress: ALL` and a forged `runway-public`
label fails the preview with two mandatory violations.

**Deployed and verified on real infrastructure** (`enduring-badge-506610-u9`, `europe-west1`).
Both services reached `Ready=True`, so the hardened defaults do not merely plan — they run:

| Control | Private service | Public service |
|---|---|---|
| CR-01 ingress | `internal-and-cloud-load-balancing` | `all` |
| CR-03 invoker IAM | **no bindings at all** | exactly one `allUsers` → `roles/run.invoker` |
| CR-04 runtime identity | `runway-api@…iam.gserviceaccount.com` | same |
| CR-07 default URI | **no URL assigned at all** | URL served, HTTP 200 |
| CR-08 justification | no description, no label | description verbatim, `runway-public: true` |

**CR-06 was also proven the other way: `pulumi destroy` refused.** The first teardown attempt
failed with *"cannot destroy service without setting deletion_protection=false"*, both services
survived, and removal required the justified opt-out
(`deletionProtection: { disableJustification: … }`) followed by a re-apply — which is precisely the
escape hatch's purpose. **One wrinkle worth knowing: the failed destroy was not a no-op.** It
deleted the unprotected `ServiceIamMember` before failing on the services, leaving the public
service still `ingress: all` but no longer invokable. A blocked teardown leaves partial state, so it
is not safe to treat a failed `destroy` as "nothing happened".

**CR-06 is weaker than its name suggests, and this is where that surfaced.** The GCP v2 API returns
`deletionProtection: null` for both services while Pulumi state records `true`. It is a
**provider-side field**, not a GCP one: it blocks `pulumi destroy` / `terraform destroy` and nothing
else. `gcloud run services delete` and the Cloud Console are unaffected. The control is real, but it
guards the IaC path only — it is not a property of the resource, and the mapping doc says so.

**Verified end to end** against `enduring-badge-506610-u9`: a stack of two
`SecureContainerService` instances planned six resources and passed with zero violations, and a
stack of four raw `gcp.cloudrunv2.Service` resources failed `pulumi preview` with four mandatory
violations — including a service carrying a forged `runway-public: "true"` label, which bought it
nothing.

## Commands

Run from the repo root after the `packages/*` restructure.

```bash
npm run build --workspace @runway/gcp-components
npm test  --workspace @runway/gcp-components -- --coverage
npm test  --workspace @runway/gcp-components -- -t "SecureContainerService"
npx oxlint --type-aware --deny-warnings
npx tsc --noEmit

# Policy pack against a consuming stack (needs a stack; not part of the PR gate)
pulumi preview --policy-pack packages/gcp-components/policy
```

## Project Structure

**This component's arrival triggers the `packages/*` restructure** approved for
[SPEC.md](SPEC.md#project-structure). The repo root is currently the single package `@runway/cli`;
it moves to `packages/runway-cli`, and the root `package.json` becomes a private workspace root
whose `workspaces` array is hand-wired via `package.addField` — projen has a `PnpmWorkspaceConfig`
component and no npm equivalent, a cost [SPEC.md](SPEC.md#tech-stack) already records.

```
platform/
├─ .projenrc.ts                        → declares both subprojects (parent + outdir)
├─ package.json                        → private workspace root; hand-wired `workspaces`
├─ docs/
│  └─ control-mapping.md               → CR-01 … CR-09
└─ packages/
   ├─ gcp-components/
   │  ├─ src/
   │  │  ├─ index.ts                   → the only import surface
   │  │  └─ container-service/
   │  │     ├─ secure-container-service.ts
   │  │     └─ service-account-email.ts   → the positive-rule validator
   │  ├─ policy/
   │  │  ├─ index.ts                   → PolicyPack definition
   │  │  └─ rules/cloud-run.ts
   │  └─ test/
   │     ├─ setup.ts                   → pulumi.runtime.setMocks()
   │     ├─ container-service/secure-container-service.test.ts
   │     └─ policy/cloud-run.test.ts
   └─ runway-cli/                      → moved, unchanged
```

`conventions/` is **not** created by this component. [SPEC.md](SPEC.md#capability-map) defers it
until there is a second consumer; one component's label set is not yet a convention.

## Code Style

Inherits [SPEC.md](SPEC.md#code-style) — named exports, `readonly` doc-commented args, `runway:gcp:`
type strings, `{ parent: this }` on every child, `registerOutputs` at the end, no `any`, no `!`
outside tests. The one pattern specific to this component:

```ts
const USER_MANAGED_SA = /^[a-z][-a-z0-9]{4,28}[a-z0-9]@[a-z0-9-]+\.iam\.gserviceaccount\.com$/;

const GOOGLE_MANAGED_HINTS: readonly [RegExp, string][] = [
  [/^\d+-compute@developer\.gserviceaccount\.com$/, "the default Compute Engine service account"],
  [/@appspot\.gserviceaccount\.com$/, "the default App Engine service account"],
  [/^\d+@cloudbuild\.gserviceaccount\.com$/, "the default Cloud Build service account"],
];

/** Throws unless `email` is a user-managed service account. CR-04. */
export function assertUserManagedServiceAccount(email: string): void {
  if (USER_MANAGED_SA.test(email)) return;

  const hint = GOOGLE_MANAGED_HINTS.find(([pattern]) => pattern.test(email))?.[1];
  throw new Error(
    hint === undefined
      ? `serviceAccountEmail must be a user-managed service account ` +
        `(<id>@<project>.iam.gserviceaccount.com), got "${email}".`
      : `serviceAccountEmail is ${hint}, which carries broad project-level roles. ` +
        `Create a dedicated service account and grant it only the roles this service needs.`,
  );
}
```

The regex also enforces GCP's own service-account ID rule — 6–30 characters, leading letter,
trailing alphanumeric — so a malformed ID is rejected before it reaches the API. Verified against
12 cases including both length boundaries.

**Errors name the fix, not just the fault.** "Create a dedicated service account and grant it only
the roles this service needs" is the whole point of the control; a developer who reads only the
error message should still end up in the right place.

## Testing Strategy

Inherits [SPEC-gcp-components.md](SPEC-gcp-components.md#testing-strategy).

- `pulumi.runtime.setMocks()` in `test/setup.ts`. **No test in the PR gate touches GCP or needs
  credentials.** Line coverage floor 80%; control-mapping completeness is separate and absolute.
- One `describe` per component, one `it` per control, **named after its control-mapping row** so
  the doc and the suite stay in lockstep and a missing control is a missing test name.
- Assert on resolved `Output` values, never on constructor arguments — asserting what we passed in
  proves nothing about what the provider receives.

```ts
it("CR-01: defaults ingress to internal load balancer only", async () => {
  const svc = new SecureContainerService("t", {
    location: "europe-west1",
    image: "europe-west1-docker.pkg.dev/p/r/api:v1",
    serviceAccountEmail: "api@p.iam.gserviceaccount.com",
  });
  await expect(resolve(svc.service.ingress))
    .resolves.toBe("INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER");
});
```

**Negative tests are mandatory, not optional coverage.** Every control needs a test proving the
unsafe state is unreachable except through the justified form, plus a policy test proving the raw
resource is rejected. A control with only a happy-path test is untested.

Specific cases this component must carry:

- Table-driven rejection over the three Google-managed default identities **and** a plausible
  non-SA email, each asserting the message names the fix.
- `serviceAccountEmail` as a plain string throws **synchronously**; as an `Output` it rejects
  **during resolution**. Both paths asserted — this is the documented asymmetry from
  [Scope Decision 1](#1-the-service-account-is-an-email-string--it-is-a-secureserviceaccount).
- `publicAccess: { justification: "" }` is rejected. An empty string satisfies the type and defeats
  the control.
- The public path emits exactly one `ServiceIamMember`; the private path emits zero.
- The justification round-trips into `description` **verbatim**, and `labels["runway-public"]`
  is a valid GCP label value.

## Boundaries

Inherits [SPEC.md](SPEC.md#boundaries) and
[SPEC-gcp-components.md](SPEC-gcp-components.md#boundaries). Component-specific:

**Always**
- Land the control-mapping row, the unit test, and the policy rule in the **same commit** as the
  default they describe.
- Export from `packages/gcp-components/src/index.ts`; consumers never deep-import.
- Edit `.projenrc.ts` and run `npx projen` — never hand-edit a generated file.

**Ask first**
- Adding any arg beyond the six specified — particularly `vpcAccess`, `encryptionKey`, or
  `iapEnabled`, all explicitly cut from v1.
- Changing a hardened default or adding an escape hatch.
- Bumping `@pulumi/gcp` — enum values and nested types are re-verified, not assumed.

**Never**
- Expose `invokerIamDisabled` or `binaryAuthorization.breakglassJustification` through any public API.
- Default to public ingress, or let `template.serviceAccount` fall through to a Google-managed default.
- Accept a `publicAccess` justification that is empty or whitespace-only.
- Weaken a default to make a test pass.
- Create real GCP resources from a test.

## Success Criteria

1. `npm test --workspace @runway/gcp-components` passes offline with no
   `GOOGLE_APPLICATION_CREDENTIALS` present.
2. A `SecureContainerService` built from the three required args alone emits: ingress
   `INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER`, `defaultUriDisabled: true`,
   `deletionProtection: true`, no `ServiceIamMember`, no `description`, no `runway-public` label.
3. Each of the three Google-managed default identities and one malformed email throws, and each
   message names the corrective action.
4. `publicAccess: { justification: "handles public webhooks from Stripe" }` emits ingress
   `INGRESS_TRAFFIC_ALL`, exactly one `allUsers` `roles/run.invoker` binding, that sentence
   verbatim in `description`, and `runway-public: "true"`.
5. All nine CR-* rows in `docs/control-mapping.md` resolve to a passing test of the same name.
   Zero rows without tests; zero tests without rows.
6. The policy pack fails a stack declaring a raw `gcp.cloudrunv2.Service` with
   `ingress: "INGRESS_TRAFFIC_ALL"`, and a second one with no `template.serviceAccount`.
7. A stack using only this component passes `pulumi preview --policy-pack` with zero violations.
8. `npx projen` twice produces zero diff after the `packages/*` restructure, and
   `packages/runway-cli` still builds, tests, and lints unchanged.

## Open Questions

1. ~~**When does `serviceAccountEmail` become `SecureServiceAccount`?**~~ **RESOLVED in D4 —
   before publishing, as a clean break with no overload.** With no consumers it was a one-line
   change; after publishing it would have been a migration. Keeping both forms would have kept the
   untestable `apply`-time path alive for the string one, which was the main thing worth removing.
2. ~~**Does `publicAccess` need to survive `gcloud` label edits?**~~ **RESOLVED.** The rules key on
   intrinsic facts — `ingress: ALL`, an `allUsers`/`allAuthenticatedUsers` invoker binding — with a
   non-empty `description` justification as the required evidence. The sharper problem was not the
   one this question asked: *removing* the label is the harmless direction (the rule fires, and the
   next `pulumi up` restores it). *Adding* it to a raw resource was the silent bypass, and it was
   available to exactly the consumer the policy pack targets. `runway-public` is now documented as
   a filtering convenience and nothing more. See the note under
   [Hardening Controls](#hardening-controls).
3. **Does `tasks/plan.md` get rewritten now?** It scopes the current prototype to `runway-cli` only
   and calls `gcp-components` out of scope. This spec inverts that order. Phase 2/3 of the skill is
   a separate gate — flagging rather than assuming.
4. **Two corrections belong upstream in [SPEC-gcp-components.md](SPEC-gcp-components.md)**: the
   justification-as-label mechanism (impossible, §3 above) and the Binary Authorization attestor
   premise (no such field, §2 above). Hardened-default changes are "ask first", so those edits are
   proposed, not made.
