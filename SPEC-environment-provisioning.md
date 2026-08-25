# Spec: environment-provisioning

Module `environment-provisioning` of the [Platform capability map](SPEC.md#capability-map).
**Build third — after `runway-cli`, before `service-stacks`.**
Shared toolchain, code style, and boundaries are inherited from [SPEC.md](SPEC.md).

## Objective

Adopt two existing GCP projects as a service's staging and production environments, and establish
the identity boundary between them, such that **a developer holding every credential they
legitimately possess still cannot deploy to production**.

That sentence is the whole module. Everything else is mechanism.

**Users**
- *Platform engineers* — hold `roles/resourcemanager.projectIamAdmin` on the two projects, run this
  once per service, and are accountable for the boundary being real rather than nominal. They do
  **not** need org or billing rights: this module never creates a project.
- *Service developers* — never run this. They consume its output as configuration and experience it
  as "staging works from my laptop, production does not".

**Success looks like:** a developer with `roles/run.admin` on staging, authenticated as themselves,
runs `pulumi up --stack production` and receives `403 PERMISSION_DENIED` from Google — not from our
CLI, not from a lint rule, and not from a code review.

### Why this is a module and not a step

The other two modules cannot be *verified* without a real project, a real state bucket, and real IAM
to fail against. And this module could be replaced wholesale — by Terraform, or by a documented
console runbook — without rewriting a line of `service-stacks` or `release-path`. That
replaceability is what makes the boundary real rather than decorative.

## Adoption, not creation

The projects pre-exist. `runway bootstrap` is handed two project ids and provisions the environment
*into* them. This was chosen deliberately: creating projects needs org and billing rights that most
organisations will not grant a CLI, and it puts the tool in the business of managing the resource
with the widest blast radius in GCP.

**Adoption buys a smaller ask and inherits a problem.** A project we create is empty and its IAM is
exactly what we set. A project we adopt has a history — and that history may already violate the
control this module exists to enforce. If the production project already grants a developers group
`roles/editor`, then EP-01 is false on the day we finish, our own bindings are all correct, and
nobody notices.

So adoption makes auditing a requirement rather than a nicety, and adds a sixth control:

| Id    | Control                                                                                       |
|-------|-----------------------------------------------------------------------------------------------|
| EP-06 | Bootstrap **fails** if the adopted production project already grants a deploy-capable role to any human principal, listing every offending binding |

EP-06 refuses rather than repairs. Silently stripping a pre-existing binding could lock out the team
that granted it, and this module has no way to know why it exists — a bootstrap that quietly removes
someone's access is worse than one that stops and asks. Remediation is a decision for a human who
knows the project's history.

## The enforcement claim, stated precisely

Six controls carry the entire guarantee. Each has exactly one named test.

| Id    | Control                                                                                          | Why it matters |
|-------|--------------------------------------------------------------------------------------------------|----------------|
| EP-01 | The production project grants **no deploy role to any human principal** — no user, no group        | Without this the rest is theatre |
| EP-02 | The production deploy role is granted **only** to the CI federated identity, scoped to one repository and one branch | An unscoped pool lets any repo in the org deploy your production |
| EP-03 | CI authenticates by **Workload Identity Federation**; no service account key is created, ever      | [SPEC.md](SPEC.md#boundaries) forbids SA keys, and a key is a credential that can leave CI |
| EP-04 | The staging project grants deploy to a **developers group**, not to individuals                    | Offboarding is a group removal, not an IAM archaeology exercise |
| EP-05 | State buckets are **versioned and separately access-controlled per environment**                   | Whoever can write production state can forge production infrastructure |

**EP-02 is the one that is easy to get wrong.** A Workload Identity Pool with a permissive attribute
condition — or none — lets *any* GitHub repository mint tokens for your production deployer. The
binding must assert both `repository` and `ref`:

```
principalSet://iam.googleapis.com/projects/<n>/locations/global/workloadIdentityPools/<pool>/
  attribute.repository/<org>/<repo>
```

with the provider's attribute condition additionally pinning `assertion.ref == 'refs/heads/main'`.
Repository alone is insufficient: a pull request from a fork runs in the repository's context.

## Tech Stack

Inherits [SPEC.md](SPEC.md#tech-stack). Module-specific:

| Concern              | Choice                                    |
|----------------------|-------------------------------------------|
| Provisioning         | Pulumi, same as everything else            |
| State for *this* stack | Local backend on first run, then migrated into the bucket it creates |
| GCP APIs             | `cloudresourcemanager` (read + IAM), `iam`, `sts`, `storage`, `serviceusage` |

**The bootstrap paradox, and its answer.** This module creates the state bucket that every other
stack uses — so its own first run has nowhere to store state. It runs against a local backend, then
migrates into the bucket it just created (`pulumi state upgrade` / `login gs://…` and re-import).
The alternative — a hand-made bucket outside Pulumi — trades one unmanaged resource for a simpler
first run, and is the fallback if migration proves fragile.

## Commands

```bash
# Adopt two existing projects as a service's environments.
# Requires projectIamAdmin on both. No org or billing rights.
runway bootstrap <service-name> \
  --staging-project <project-id> \
  --production-project <project-id> \
  --github-repo <org>/<repo> \
  --region europe-west1

# Audit the adopted projects without changing anything (EP-06 precondition)
runway bootstrap <service-name> --staging-project … --production-project … --audit

# Show what would be created, write nothing
runway bootstrap <service-name> --dry-run

# Emit the config block the service repo consumes, for an existing pair
runway bootstrap <service-name> --print-config
```

Developing the module:
```bash
npm run build --workspace @runway/environment-provisioning
npm test --workspace @runway/environment-provisioning -- --coverage
```

## Project Structure

```
packages/environment-provisioning/
├─ src/
│  ├─ index.ts                  → Public surface
│  ├─ service-environment.ts    → The component: one adopted project, its IAM, its state prefix
│  ├─ audit.ts                  → EP-06: refuse a production project with human deploy bindings
│  ├─ workload-identity.ts      → Pool, provider, and the repository/ref-scoped binding
│  └─ roles.ts                  → The deploy role set, one definition consumed by both environments
└─ test/                        → Mirrors src/
```

`ServiceEnvironment` is the unit, not `Environment` — one instance per environment, composed twice
by the caller. Two instances of a reviewed component beats one component with an `isProduction`
branch, because the branch is where the boundary silently softens.

## Code Style

Inherits [SPEC.md](SPEC.md#code-style). The module-specific convention is that **human access to
production is not an option**:

```ts
export interface ServiceEnvironmentArgs {
  /** Service this environment belongs to, e.g. "checkout". */
  readonly service: pulumi.Input<string>;

  /** Environment name. Determines the deploy-identity model — see `deployableBy`. */
  readonly environment: "staging" | "production";

  /**
   * Who may deploy here.
   *
   * Production accepts only a federated CI identity: there is no variant of this
   * type that grants a human deploy access to production. Making that a type error
   * rather than a review comment is the point of the discriminated union.
   */
  readonly deployableBy:
    | { readonly humans: { readonly group: pulumi.Input<string> } }
    | { readonly ci: WorkloadIdentityBinding };
}
```

A `production` environment constructed with `deployableBy: { humans: … }` must fail at
construction with a message naming EP-01 — the type steers, the runtime check enforces.

## Testing Strategy

| Level       | What it does                                                                   | Gate |
|-------------|--------------------------------------------------------------------------------|------|
| Unit        | Pulumi mocks: assert the emitted IAM bindings per environment                    | Blocking |
| Negative    | A `production` environment with a human principal throws, naming the control      | Blocking |
| Attribute   | The WIF binding asserts both `repository` and `ref`; a repository-only binding fails | Blocking |
| Audit       | EP-06: a fixture project whose IAM already grants a human `roles/editor` causes bootstrap to fail and names the binding | Blocking |
| Integration | `pulumi preview` against a real sandbox org                                       | Blocking before first production use |

- Every control EP-01…EP-05 has exactly one named test. A control without a test is not a control.
- **The integration test is not optional for this module.** Mocked IAM assertions prove we *emitted*
  a binding; they cannot prove Google *enforces* it. Until a real `403` has been observed, the
  central claim is unverified — and this module's whole value is that claim.

### The test that matters

Deploy nothing. Authenticate as a developer principal, attempt `pulumi preview --stack production`,
and assert `403`. Everything else in this spec is scaffolding around that one observation.

## Boundaries

Inherits [SPEC.md](SPEC.md#boundaries). Module-specific:

**Always**
- Grant production deploy to exactly one federated principal, scoped to repository *and* ref.
- Grant staging deploy to a group, never to an individual.
- Version state buckets and access-control them per environment.
- Record every new binding as an EP-* control with a named test.

**Ask first**
- Granting any human principal any write role in a production project.
- Widening the WIF attribute condition.
- Adding a third environment — the two-environment assumption is load-bearing in `release-path`.

**Never**
- Create or delete a GCP project. This module adopts; project lifecycle belongs to whoever owns the
  org, and conflating the two puts a CLI in charge of the widest blast radius in GCP.
- Silently remove a pre-existing IAM binding. Refuse and report (EP-06); the team that granted it
  may depend on it, and this module cannot know why it exists.
- Create a service account key. Federation or impersonation, always.
- Reuse one project for both environments — it collapses the boundary this module exists to build.
- Grant `roles/owner` or `roles/editor` to a deploy identity.
- Run this against a project not designated as a sandbox until
  [SPEC.md open question 3](SPEC.md#open-questions) is answered in writing.

## Success Criteria

1. `runway bootstrap demo --staging-project … --production-project …` adopts both projects and
   provisions a WIF pool, a versioned state bucket, and the bindings for EP-01…EP-05.
2. **A developer authenticated as themselves receives `403` from `pulumi preview --stack production`
   against a real project.** Observed, not asserted.
3. That same developer succeeds against `--stack staging`.
4. `gcloud iam service-accounts keys list` returns no user-managed keys in either project.
5. The WIF binding names both a repository and a ref; a test proves a repository-only binding is
   rejected.
6. `--dry-run` prints the plan and creates nothing.
7. Re-running against an existing pair is idempotent — no duplicated bindings, no error.
8. **Adopting a production project that already grants a human a deploy-capable role fails**, names
   every offending binding, and changes nothing (EP-06).
9. No GCP project is created or deleted by any code path in this module.

## Open Questions

1. ~~Does `runway bootstrap` create projects, or adopt existing ones?~~ **Resolved: adopt.** See
   [Adoption, not creation](#adoption-not-creation). Creation is not an opt-in either — it is a
   Never, because a half-supported creation path is worse than none.
2. **Where does the bootstrap stack's own state live long-term?** Migrating into the bucket it
   creates is elegant and slightly circular. A hand-made bucket is duller and more robust.
3. **One WIF pool per service, or one per org?** Per-service is more isolated and multiplies
   objects; per-org is tidier and makes the attribute condition the only thing standing between
   services. Per-service is the safer default; confirm.
4. **How does a team remediate an EP-06 failure?** The module refuses and reports, which is right,
   but it leaves the operator holding a list of bindings and no guidance. A documented runbook is
   probably enough; a `--fix` flag would re-introduce exactly the silent removal EP-06 forbids.
5. **Does production allow *any* human break-glass path?** EP-01 says no. Real incidents sometimes
   say otherwise. If a break-glass role is wanted, it should be specified deliberately — time-boxed,
   alerting, and audited — rather than appearing later as an exception nobody reviewed.
6. **What does this module do about the existing prerequisite gap?** `service-stacks` needs
   `SecureServiceAccount` and `SecureArtifactRepository`, which have no spec. They are not this
   module's job, but nothing downstream ships without them.
