# Control Mapping

One row per hardening control in [`@runway/gcp-components`](../packages/gcp-components). Each row
names the external guidance it rests on, the component that applies it, the tests that prove it, and
the policy rule that catches consumers who bypass the component entirely.

**This file is checked by a test, in both directions.** A control without a row fails, and a row
without a test fails — see `packages/gcp-components/test/control-mapping.test.ts`. A mapping
document that has drifted from its suite is worse than no document, because it reads as proof.

## On the `Source` column

Per the rule agreed in [SPEC-secure-container-service.md](../SPEC-secure-container-service.md#4-control-mapping-cites-cis-only-where-cis-genuinely-covers-the-control):
a CIS citation must name the benchmark version *and* control number, and must be verified against
the published benchmark before the row is committed. **No control ID is ever inferred from a
control's subject matter.**

**Every row below therefore cites Google, and none cites CIS.** The CIS GCP Foundations Benchmark
has no Cloud Run section at all. Its IAM section is the only plausible anchor here, and only for
CR-04 — but the benchmark has not been read against these rows, so citing it would be exactly the
inference the rule forbids. If someone verifies the IAM controls on over-privileged and default
service accounts against a named benchmark version, CR-04's source should be updated to cite both.

Every URL below returned HTTP 200 when this file was written.

## Controls

| Control | Requirement | Source | Enforced in | Tests | Policy rule |
|---|---|---|---|---|---|
| CR-01 | Ingress defaults to internal load balancer only | [Cloud Run: restricting ingress](https://cloud.google.com/run/docs/securing/ingress) | `SecureContainerService` | `CR-01: …` | `cr01-cr03-public-ingress-requires-justification` |
| CR-02 | Public exposure requires a non-empty justification | [Cloud Run: managing access](https://cloud.google.com/run/docs/securing/managing-access) | `SecureContainerService` | `CR-02: …` | — |
| CR-03 | No `allUsers` invoker binding without a justification | [Cloud Run: managing access](https://cloud.google.com/run/docs/securing/managing-access) | `SecureContainerService` | `CR-03: …` | `cr03-public-invoker-binding-requires-justification` |
| CR-04 | Runtime identity is a user-managed service account | [Cloud Run: service identity](https://cloud.google.com/run/docs/securing/service-identity), [IAM: service account best practices](https://cloud.google.com/iam/docs/best-practices-service-accounts) | `assertUserManagedServiceAccount` | `CR-04: …` | `cr04-runtime-service-account-is-user-managed` |
| CR-05 | `invokerIamDisabled` is never set | [Cloud Run: managing access](https://cloud.google.com/run/docs/securing/managing-access) | `SecureContainerService` | `CR-05: …` | `cr05-invoker-iam-never-disabled` |
| CR-06 | Deletion protection on unless justified — **IaC path only**, see Known gaps | [Cloud Run: managing services](https://cloud.google.com/run/docs/managing/services) | `SecureContainerService` | `CR-06: …` | — |
| CR-07 | Default URI resolution disabled when not public | [Cloud Run: restricting ingress](https://cloud.google.com/run/docs/securing/ingress) | `SecureContainerService` | `CR-07: …` | — |
| CR-08 | The justification is recorded on the resource | [Cloud Run: managing access](https://cloud.google.com/run/docs/securing/managing-access) | `SecureContainerService` | `CR-08: …` | — |
| CR-09 | Binary Authorization opt-in; breakglass never exposed | [Binary Authorization overview](https://cloud.google.com/binary-authorization/docs/overview), [using breakglass](https://cloud.google.com/binary-authorization/docs/using-breakglass) | `SecureContainerService` | `CR-09: …` | `cr09-binary-authorization-breakglass-forbidden` |

## Reading the columns

- **Tests** — every test whose title carries the control id. The convention is enforced by the
  completeness test rather than by review: a control id that appears in no test title fails, and a
  control id in a test title that appears in no row fails.
- **Policy rule** — the CrossGuard rule covering the bypass case, or `—` where the control is
  enforced only by the component's own construction. Four controls have no rule, deliberately:
  CR-02 and CR-08 are properties of *how* the component records a justification and have no meaning
  for a hand-written resource; CR-06 and CR-07 are defaults whose absence is a weaker posture, not
  an exposure, and blocking on them would make the pack reject stacks that are merely conservative
  in a different way.

## Known gaps

- **CR-06 guards the IaC path only.** `deletionProtection` is a provider-side field, not a GCP API
  field: the v2 API returns `null` for a deployed service while Pulumi state records `true`. It
  blocks `pulumi destroy` and `terraform destroy`; `gcloud run services delete` and the Cloud
  Console delete the service regardless. Confirmed against a real deployment.

- **The stack-scoped CR-03 rule is not exercised end to end offline.** It resolves a binding to its
  service through the engine's dependency graph, and `pulumi.runtime.setMocks` supplies none. It is
  covered by explicit dependency fixtures; proving it against a real plan needs the integration tier
  ([SPEC.md Open Question 3](../SPEC.md#open-questions), the sandbox project, is unanswered).
- **No CIS citations**, for the reason above. This is a deliberate gap, not an oversight.
