# Spec: environment-provisioning

Module `environment-provisioning` of the [Platform capability map](SPEC.md#capability-map).
**Build third — after `runway-cli`, before `service-stacks`.**
Shared toolchain, code style, and boundaries are inherited from [SPEC.md](SPEC.md).

## Objective

Adopt existing GCP projects as a service's environments and establish the identity boundary between
them, such that **a developer holding every credential they legitimately possess still cannot deploy
to production**.

That sentence is the whole module. Everything else is mechanism.

A service adopts staging first and production when it is ready, so the boundary arrives with the
production project rather than at bootstrap — see [Staging first](#staging-first-and-the-drift-it-invites).

**Users**
- *Platform engineers* — hold `roles/resourcemanager.projectIamAdmin` on each adopted project, run this
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

The projects pre-exist. `runway bootstrap` is handed their ids and provisions the environments
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

### Refusing well

A refusal is only as good as what the operator can do next, and this one hands them a security
decision about a project they may not have set up. So the message carries the whole decision, not
just the verdict:

```
EP-06: acme-checkout-prd already grants deploy access to human principals.

  group:platform-team@acme.com     roles/editor
  user:dana@acme.com               roles/run.admin

Adopting it would leave EP-01 unenforced — a developer could deploy to production
by hand, which is the one thing this environment exists to prevent.

Nothing was changed. To proceed, either remove these bindings, or adopt a
different project as production.
```

Three properties make that useful rather than merely correct: it names **every** offending binding
so the operator sees the full scope in one pass; it says **what would be untrue** rather than citing
a control id at someone who has never read this spec; and it states plainly that **nothing was
changed**, so no one goes looking for partial damage.

**There is no `--fix`.** A flag that strips the bindings would put the silent removal back, one
`--yes` away, and the operator who most wants it is the one least likely to know why the binding
exists. Refusal is the feature.

## Staging first, and the drift it invites

`--production-project` is optional because that is how teams actually adopt: get staging working,
prove the loop, add production when there is something worth protecting. Forcing both up front makes
the first run harder than it needs to be, on the day the team has least appetite for it.

**But a staging-only service has no boundary at all.** The module's objective — a developer cannot
deploy to production — is *vacuously* true when there is no production. Every control except EP-04
and EP-05 is inert. That is fine as a waypoint and dangerous as a destination, because of a specific
and very common failure:

> A team bootstraps staging, ships to it, and starts serving real traffic from it. Production never
> arrives. The environment everyone depends on is now the one with human deploy access, no CI-only
> path, and no digest promotion — precisely the configuration this module exists to prevent.

Nothing in a tool can stop a team deciding staging is good enough. What it can do is refuse to let
that happen *silently*:

| Id    | Control                                                                                     |
|-------|---------------------------------------------------------------------------------------------|
| EP-07 | A service with no production environment is reported as **incomplete** by `--print-config` and on every bootstrap run, naming what is not yet enforced |

EP-07 is a report, not a refusal. Refusing would block the adoption path the option exists to
support. The point is that "we only have staging" should be a fact someone has read, not a state
nobody noticed.

**Adding production later is a first-class path, not a re-run.** `runway bootstrap --production-project`
against a service that already has staging must add the production environment, the WIF pool and its
bindings, and leave staging's IAM and state untouched. That is a different operation from idempotent
re-application and gets its own test.

## The enforcement claim, stated precisely

Seven controls carry the entire guarantee. Each has exactly one named test.

| Id    | Control                                                                                          | Why it matters |
|-------|--------------------------------------------------------------------------------------------------|----------------|
| EP-01 | The production project grants **no deploy role to any human principal** — no user, no group        | Without this the rest is theatre |
| EP-02 | The production deploy role is granted **only** to the CI federated identity, scoped to one repository and one branch | An unscoped pool lets any repo in the org deploy your production |
| EP-03 | CI authenticates by **Workload Identity Federation**; no service account key is created, ever      | [SPEC.md](SPEC.md#boundaries) forbids SA keys, and a key is a credential that can leave CI |
| EP-04 | The staging project grants deploy to a **developers group**, not to individuals                    | Offboarding is a group removal, not an IAM archaeology exercise |
| EP-05 | State buckets are **versioned and separately access-controlled per environment**                   | Whoever can write production state can forge production infrastructure |

**When production is absent**, EP-01, EP-02, EP-03 and EP-06 are inert — there is nothing to
enforce them against — and EP-07 reports that fact. EP-04 and EP-05 apply to staging from the first
run.

**EP-02 is the one that is easy to get wrong.** A Workload Identity Pool with a permissive attribute
condition — or none — lets *any* GitHub repository mint tokens for your production deployer. The
binding must assert both `repository` and `ref`:

```
principalSet://iam.googleapis.com/projects/<n>/locations/global/workloadIdentityPools/<pool>/
  attribute.repository/<org>/<repo>
```

with the provider's attribute condition additionally pinning `assertion.ref == 'refs/heads/main'`.
Repository alone is insufficient: a pull request from a fork runs in the repository's context.

### Identity federation is per service

Each service gets its own Workload Identity Pool and provider, living **in that service's production
project** — not one shared pool for the organisation.

The argument is entirely about what happens when EP-02 is got wrong, which is the likeliest mistake
in this module. With a shared pool, a single permissive attribute condition exposes *every* service's
production to any repository in the org; the condition becomes the only thing standing between
unrelated teams. With a per-service pool the same mistake exposes one service, and it is the service
whose team made it. Blast radius follows ownership.

The cost is more objects — one pool and one provider per service — which is immaterial when they sit
one-per-project rather than accumulating in a shared one.

Two consequences worth stating rather than discovering:

- **The pool arrives with production.** A staging-only service has no pool at all, which is
  consistent with EP-07: the boundary exists once there is something to protect.
- **Pool ids are reserved after deletion.** GCP soft-deletes workload identity pools and providers
  and holds the id for roughly 30 days, so tearing a service down and re-bootstrapping it under the
  same name will fail on a name collision, not on permissions. The error is confusing enough that
  the module should detect a soft-deleted pool and say so plainly, offering `undelete` rather than a
  raw `ALREADY_EXISTS`. **Confirm the retention window against current GCP docs at implementation
  time** — the behaviour is long-standing but the number is worth checking rather than trusting.

## Tech Stack

Inherits [SPEC.md](SPEC.md#tech-stack). Module-specific:

| Concern                | Choice                                                              |
|------------------------|---------------------------------------------------------------------|
| Provisioning           | Pulumi, same as everything else                                      |
| State for *this* stack | The org bootstrap-state bucket — hand-made, once ever (see below)    |
| State for service stacks | Per-service, per-environment buckets that this module creates      |
| GCP APIs               | `cloudresourcemanager` (read + IAM), `iam`, `sts`, `storage`, `serviceusage` |

### The bootstrap paradox, and its answer

This module creates the state buckets every service stack uses, so its own first run has nowhere to
store state. The resolution is to notice these are **two different problems wearing one name**:

```
gs://<org>-runway-bootstrap-state/     hand-made, once ever, org-wide
  demo/                                  ← provisioning stack state
  checkout/

gs://demo-staging-state/               created BY bootstrap, Pulumi-managed
gs://demo-production-state/            created BY bootstrap, Pulumi-managed
```

Only the first is circular, and only the first is unmanaged. It is created once for the entire
organisation by a documented command, not once per service:

```bash
gcloud storage buckets create gs://<org>-runway-bootstrap-state \
  --project <platform-project> --location <region> --uniform-bucket-level-access
gcloud storage buckets update gs://<org>-runway-bootstrap-state --versioning
```

**Why not migrate from a local backend.** It sounds tidier — every resource Pulumi-managed, no
exceptions — and it is worse in the two ways that matter. The migration runs once per service, so it
is the least-exercised path in the module and will be broken when it is needed. And in between the
two steps, the state describing production's security boundary sits on a laptop. A half-completed
migration leaves a bucket nobody has a record of creating.

**Why not one bucket for everything.** Collapsing service state into the same bucket would remove
the hand-made resource entirely, but per-environment access control then becomes IAM conditions on
object prefixes rather than a bucket boundary. EP-05 exists because whoever can write production
state can forge production infrastructure; a prefix condition is a weaker fence than a bucket, and
this is not the control to economise on.

Accepting exactly one unmanaged resource is the honest trade. Every IaC system has a bootstrap
resource that predates it; the goal is to make it *one*, org-wide, versioned, and written down —
not to pretend it does not exist.

## Commands

`--staging-project` is required. `--production-project` is **optional**: a service may adopt staging
alone and add production later. See [Staging first](#staging-first-and-the-drift-it-invites).

```bash
# Staging only. The common starting point.
# Requires projectIamAdmin on the staging project.
runway bootstrap <service-name> \
  --staging-project <project-id> \
  --github-repo <org>/<repo> \
  --region europe-west1

# Both environments, which is where a service is meant to end up.
runway bootstrap <service-name> \
  --staging-project <project-id> \
  --production-project <project-id> \
  --github-repo <org>/<repo> \
  --region europe-west1

# Add production to a service that already has staging. Must not disturb staging.
runway bootstrap <service-name> --production-project <project-id>

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
│  ├─ workload-identity.ts      → Per-service pool and provider, repository/ref-scoped binding
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
| Staging-only| Bootstrap with no `--production-project` succeeds, provisions staging, and reports the service incomplete (EP-07) | Blocking |
| Later-add   | Adding production to a staging-only service provisions it and leaves staging's IAM and state byte-identical | Blocking |
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
- Create the org bootstrap-state bucket. It is the one resource this module deliberately leaves
  unmanaged; creating it from inside the stack that stores its state there is the circularity the
  two-tier design exists to avoid. Fail with the command instead.
- Create or delete a GCP project. This module adopts; project lifecycle belongs to whoever owns the
  org, and conflating the two puts a CLI in charge of the widest blast radius in GCP.
- Silently remove a pre-existing IAM binding. Refuse and report (EP-06); the team that granted it
  may depend on it, and this module cannot know why it exists.
- Add a `--fix`, `--force` or `--yes` escape from EP-06. The refusal is the feature; an override
  reintroduces the silent removal one flag away.
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
8. Bootstrap **fails with an actionable message** if the org bootstrap-state bucket does not exist,
   printing the `gcloud storage buckets create` command that fixes it. It does not create the bucket
   itself — that is the one resource this module deliberately does not manage.
9. The WIF pool and provider live in the service's own production project; no pool is shared
   between services, and re-bootstrapping over a soft-deleted pool fails with an actionable message
   rather than `ALREADY_EXISTS`.
10. **Adopting a production project that already grants a human a deploy-capable role fails**, names
   every offending binding, and changes nothing (EP-06).
11. No GCP project is created or deleted by any code path in this module.
12. Bootstrap **succeeds with `--staging-project` alone**, and reports the service as incomplete,
    naming the controls not yet in force (EP-07).
13. Adding `--production-project` later provisions production and leaves staging's IAM bindings and
    state bucket unchanged — verified by comparing before and after, not by inspection.

## Open Questions

1. ~~Does `runway bootstrap` create projects, or adopt existing ones?~~ **Resolved: adopt.** See
   [Adoption, not creation](#adoption-not-creation). Creation is not an opt-in either — it is a
   Never, because a half-supported creation path is worse than none.
2. ~~Where does the bootstrap stack's own state live long-term?~~ **Resolved: a hand-made org
   bootstrap-state bucket, with per-environment service state buckets created by this module.** See
   [The bootstrap paradox](#the-bootstrap-paradox-and-its-answer).
3. ~~One WIF pool per service, or one per org?~~ **Resolved: one per service**, in that service's
   production project. See [Identity federation is per service](#identity-federation-is-per-service).
4. ~~How does a team remediate an EP-06 failure?~~ **Resolved: the module refuses and never
   repairs.** No `--fix` flag. Remediation is a human decision, and the refusal is what makes it
   one — see [Refusing well](#refusing-well).
5. ~~Does production allow *any* human break-glass path?~~ **Out of scope.** EP-01 stands as
   written: no human principal holds a deploy role in production. Should an incident later require
   one, it is a deliberate amendment to EP-01 with its own review — not a door this spec leaves ajar.
6. **What counts as a "deploy-capable role"?** EP-06 cannot be implemented without the answer, and
   a too-narrow definition lets the check pass while a human still holds effective deploy access.
   `roles/owner` and `roles/editor` are obvious; `roles/run.admin` and `roles/iam.serviceAccountUser`
   are the ones that actually matter for Cloud Run. Custom roles are the hard part — deciding by
   role name is unreliable, so the check may need to expand each binding to its permission set and
   look for the deploy verbs. `roles.ts` is where the answer lives.
7. **What does this module do about the existing prerequisite gap?** `service-stacks` needs
   `SecureServiceAccount` and `SecureArtifactRepository`, which have no spec. They are not this
   module's job, but nothing downstream ships without them.
