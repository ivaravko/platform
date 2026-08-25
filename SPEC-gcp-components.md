# Spec: gcp-components

Module `gcp-components` of the [Platform capability map](SPEC.md#capability-map). **Build first — no dependencies.**
Shared toolchain, code style, and boundaries are inherited from [SPEC.md](SPEC.md); this spec adds only what is module-specific.

## Objective

A versioned TypeScript library of Pulumi `ComponentResource`s for GCP, where the secure
configuration is the one you get by default and every insecure configuration requires a named,
justified opt-out.

**Why a library rather than a template.** Templates fork on first use and never receive a fix
again. A library propagates a hardening change to every consumer via a version bump. The entire
value of this module is that guardrail changes travel.

**v1 scope (approved): service runtime only.** Cloud Run service, Artifact Registry repository,
least-privilege runtime service account. Data stores, networking, and secrets/messaging are
explicitly deferred — a deployable Cloud Run service is the smallest thing that makes `runway-cli`
verifiable end to end.

## Components

### `SecureServiceAccount`
Dedicated runtime identity. Wraps `gcp.serviceaccount.Account`.

- **Never exposes key creation.** `gcp.serviceaccount.Key` is not constructible through this
  component and the policy pack rejects it stack-wide. Workload Identity only.
- **Role allowlist.** Roles are granted from an explicit vetted set. `roles/owner`, `roles/editor`,
  and any `*Admin` role throw at construction time.
- Exposes `.email` as `pulumi.Output<string>` for consumption by `SecureContainerService`.

### `SecureArtifactRepository`
Wraps `gcp.artifactregistry.Repository`. Verified arg surface: `format`, `dockerConfig`,
`cleanupPolicies`, `kmsKeyName`, `vulnerabilityScanningConfig`, `mode`.

- `format: "DOCKER"`, `mode` standard.
- `dockerConfig.immutableTags: true` — a pushed tag can never be repointed.
- `vulnerabilityScanningConfig.enablementConfig: "INHERITED"` (verified enum: `INHERITED` | `DISABLED`).
- `cleanupPolicies` — keep N most recent, delete untagged older than 30 days.
- `kmsKeyName` optional; CMEK supported but not required in v1 (no KMS component until v2).

### `SecureContainerService`
Wraps `gcp.cloudrunv2.Service`. Verified arg surface includes `ingress`, `deletionProtection`,
`binaryAuthorization`, `iapEnabled`, `defaultUriDisabled`, `invokerIamDisabled`, and
`template.{serviceAccount,vpcAccess,executionEnvironment,encryptionKey}`.

- `ingress: "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"` by default (verified enum: `ALL` |
  `INTERNAL_LOAD_BALANCER` | `INTERNAL_ONLY` | `UNSPECIFIED`).
- `template.serviceAccount` is a **required** arg typed as `SecureServiceAccount` — the type system
  makes falling back to the default compute service account impossible.
- `deletionProtection: true`.
- No `allUsers` invoker IAM binding is ever emitted implicitly.
- `defaultUriDisabled: true` whenever ingress is not `ALL`.
- Public exposure requires `publicAccess: { justification: string }`, which simultaneously flips
  ingress to `ALL`, emits the `allUsers` invoker binding, and records the justification as a
  resource label — so it is auditable from `gcloud` without reading the source.

## Hardening: Enforcement and Proof

Three layers, per the approved decision:

1. **Safe defaults in constructors** — the component emits the hardened configuration.
2. **Unit assertions** — a Pulumi-mocked test per control proves the default holds. Catches
   regressions in *our* code.
3. **CrossGuard policy pack** (`packages/gcp-components/policy`) — catches the bypass case where a
   consumer declares a raw `gcp.*` resource and skips our components entirely. Built with
   `PolicyPack` + `validateResourceOfType` from `@pulumi/policy` (verified API).
   `enforcementLevel: "mandatory"`.
4. **`docs/control-mapping.md`** — one row per control: control → source standard → component →
   test name → policy rule.

> **Open, blocking on the mapping doc only:** the CIS GCP Foundations Benchmark has no Cloud Run or
> Artifact Registry section, so most v1 controls have no honest CIS ID. See
> [SPEC.md Open Question 1](SPEC.md#open-questions). Components and tests do not depend on this
> resolution; only the mapping doc's `Source` column does.

## Commands

```bash
npm run build --workspace @runway/gcp-components
npm test --workspace @runway/gcp-components -- --coverage
npm run lint --workspace @runway/gcp-components -- --fix

# Policy pack against a consuming stack
pulumi preview --policy-pack packages/gcp-components/policy
```

## Project Structure

```
packages/gcp-components/
├─ src/
│  ├─ index.ts                       → Public entry point; the only import surface
│  ├─ conventions/
│  │  ├─ naming.ts                   → Resource name derivation
│  │  └─ labels.ts                   → Mandatory label set (owner, env, managed-by)
│  ├─ service-account/
│  │  ├─ secure-service-account.ts
│  │  └─ role-allowlist.ts
│  ├─ artifact-registry/
│  │  └─ secure-artifact-repository.ts
│  └─ container-service/
│     └─ secure-container-service.ts
├─ policy/
│  ├─ index.ts                       → PolicyPack definition
│  └─ rules/                         → One file per rule
└─ test/                             → Mirrors src/ and policy/
```

## Testing Strategy

- `pulumi.runtime.setMocks()` in a shared `test/setup.ts`; no network, no credentials.
- One `describe` block per component; one named `it` per hardening control, named after its
  control-mapping row so the doc and the suite stay in lockstep.
- Assert on resolved `Output` values, not on constructor arguments.

```ts
it("defaults ingress to internal load balancer only", async () => {
  const sa = new SecureServiceAccount("t-sa", { accountId: "t" });
  const svc = new SecureContainerService("t", {
    location: "europe-west1",
    image: "europe-west1-docker.pkg.dev/p/r/api:v1",
    serviceAccount: sa,
  });
  await expect(resolve(svc.service.ingress))
    .resolves.toBe("INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER");
});
```

- **Negative tests are mandatory**: each opt-out has a test proving the unsafe path is reachable
  *only* through the justified form, and a policy test proving the raw resource is rejected.
- Role allowlist gets a table-driven test over `roles/owner`, `roles/editor`, `roles/iam.serviceAccountAdmin`.

## Boundaries

Inherits [SPEC.md](SPEC.md#boundaries). Module-specific additions:

**Always**
- Export every component from `src/index.ts`; consumers never deep-import.
- Add the control-mapping row, the unit test, and the policy rule in the same commit as the default.

**Ask first**
- Adding a component outside the approved v1 scope.
- Introducing a `@pulumi/gcp` resource whose hardened default is not obvious.

**Never**
- Expose `gcp.serviceaccount.Key` through any public API.
- Default any component to public ingress or to the default compute service account.
- Let a test create real GCP resources.

## Success Criteria

1. `npm test --workspace @runway/gcp-components` passes offline with no `GOOGLE_APPLICATION_CREDENTIALS`.
2. All three components exported from `src/index.ts` with full TSDoc on every args member.
3. Every control-mapping row resolves to a passing named test; zero rows without tests.
4. Policy pack rejects: raw `cloudrunv2.Service` with `ingress: "INGRESS_TRAFFIC_ALL"`; any
   `serviceaccount.Key`; any `artifactregistry.Repository` without `immutableTags`.
5. A stack using only these three components passes `pulumi preview --policy-pack` with zero violations.
6. Constructing `SecureServiceAccount` with `roles/owner` throws with an actionable message.

## Open Questions

1. Binary Authorization on by default (requires attestor plumbing) or opt-in for v1? See
   [SPEC.md Open Question 4](SPEC.md#open-questions).
2. Mandatory label set — which keys are required, and should a missing `owner` label throw or warn?
3. Cloud Run `template.vpcAccess`: v1 has no networking module, so egress is unconfigured. Accept a
   pre-existing connector name as an optional arg, or leave the field entirely absent until v2?
