# Forge Architecture

**Origin Platform Labs LLC**
Status: **Phase 1, engine complete.** The resolution pipeline, plan/apply lifecycle,
state, drift detection, and per-file ejection all work end to end on the codegen provider.
The `@forge/*` runtime packages the generated wiring imports are not yet implemented, so
the generated application does not boot — see §13.

Phase 0's six open questions are decided in §14. The generation budget in §4, flagged
there as the load-bearing unproven assumption, has now been measured — §9.1.

---

## 0. Assumptions, stated explicitly

The brief asks for expensive-to-reverse decisions to be surfaced rather than chosen
silently. These four were put to the client and answered. They are recorded here because
every later decision leans on them.

| Decision | Choice | Why it is expensive to reverse |
|---|---|---|
| Generated application stack | **Next.js (App Router) + TypeScript + PostgreSQL** | The kernel's schema, every capability's UI surface, and every code template are written against it. Changing it is a rewrite of the catalog, not of the engine. |
| `forge` CLI implementation | **Go** | Terraform's lineage: a single static binary, no runtime on operator machines, cheap concurrency for fleet fan-out. Reversible at real but bounded cost — the engine is ~15% of total system effort. |
| Phase 4 cloud target | **Google Cloud Platform** | Cloud Run + Cloud SQL + Secret Manager + Cloud DNS. Reversible behind the provider interface (§11), which is why the provider interface is defined in Phase 1 even though no cloud provider is built until Phase 4. |
| Catalog source of truth | `catalog/` in this repository | Single repository, capabilities as packages within it, per the brief's constraints. |

Two consequences of the Next.js choice that shape everything downstream:

1. **TypeScript on both sides of the boundary.** Event payload schemas, capability
   configuration schemas, and manifest-declared client entities all compile to TypeScript
   types. A contract violation is a type error at build time, not a runtime surprise. This
   is a significant advantage over the Rails path and we should spend it deliberately.
2. **Next.js has no engine, generator, or migration primitive.** Rails would have given us
   engines, `rails g`, and Active Record migrations for free. We must supply all three.
   §4 and §5 are about paying that bill in the cheapest possible way.

---

## 1. What Forge is

Forge composes a client product from versioned capability packages according to a
declarative manifest. It is a design system whose components are business capabilities.

The success condition is not an elegant engine. It is this pair of numbers:

- **< 1 hour** of human time to stand up a new client on an existing vertical template.
- **1 command** to plan a capability upgrade across every workspace in the fleet.

Everything in this document is subordinate to those two numbers. Where a design choice is
elegant but costs fleet upgradability, fleet upgradability wins.

### The failure mode we are designing against

The brief names it: *becoming a one-shot generator*. Every scaffolding tool in §5 started
where we are starting and ended up unable to safely touch a project again after the first
run. They did not fail because their authors were careless. They failed because the amount
of code they generated grew until three-way merging it became unreliable, at which point
"regenerate" and "don't regenerate" were both wrong and users chose "don't."

The structural defense is in §4.

---

## 2. Domain model

Seven nouns. They map onto the brief's Core Concepts, with the resolution products (Graph,
Lock, Plan) made explicit because they are what the engine actually manipulates.

```
Catalog ──contains──▶ Capability ──has──▶ Specification (catalog/**/*.capability.json)
   │                                             │
   │ snapshot                                    │ requires/enhances/conflicts/upgrades
   ▼                                             ▼
CatalogSnapshot (immutable, dated)          DependencyGraph
   │                                             │
   └──────────────┐                              │
                  ▼                              ▼
Manifest ─────▶ Resolution ────────────────▶ ResolvedGraph + Lock
(forge.yaml)      │                              │
                  │                              ▼
                  │                          DesiredState
                  ▼                              │
              Workspace ──has──▶ State ──────────┤
              (client×env)      (actual)         │
                                                 ▼
                                               Plan  ──apply──▶ Providers
                                            (a diff)              (codegen, cloud,
                                                                   dns, secrets)
```

### Capability

A versioned package. Two physical halves, and the split is the most important structural
decision in the system:

- **The runtime half** is an npm package (`@forge/pay-card`) containing all of the
  capability's actual implementation: models, services, React components, API handlers,
  event handlers. It is **imported** by the client application. It is never copied.
- **The generated half** is the minimum wiring that cannot live inside a package:
  migration files, route mounting, configuration binding, environment variable schema,
  entity registration, and slot stubs. This is written into the client repository.

The runtime half upgrades by changing one line in `package.json`. Only the generated half
requires merge machinery. **Therefore the generated half must be kept small on purpose.**
See §4.

### Kernel

The eleven `kernel.*` capabilities in `catalog/kernel/`. Always present, never listed in a
manifest, sole definer of shared primitives (`User`, `Organization` when present, `Money`,
`AuditEntry`, the event bus, the design tokens). No other capability may define these.

### Provider

A pluggable backend that makes something real. Four kinds, of which only the first exists
in Phase 1:

| Provider | Phase | Responsibility |
|---|---|---|
| `codegen` | 1 | Render templates into a client repository, run migrations, install packages |
| `cloud` | 4 | GCP: Cloud Run service, Cloud SQL instance, Artifact Registry, IAM |
| `dns` | 4 | Cloud DNS records, managed certificates |
| `secrets` | 1 (interface) / 4 (impl) | Resolve `secret_ref` names to values at apply time only |

The `secrets` provider interface exists in Phase 1 even though only a local development
implementation ships, because retrofitting secret handling is how credentials end up in
committed files. See §9.4.

### Workspace

One isolated instance of a product: one client, one environment. `acme/production`,
`acme/staging`. Each has its own state, its own lock file, and its own resolved manifest
overlay. Fleet operations iterate over workspaces.

### Plan

A computed diff between desired and actual state. Mutates nothing, ever. `plan`,
`validate`, `catalog`, `graph`, `quote`, `outdated`, and `drift` are all read-only, and
this is enforced structurally: `provider.ReadOnly` wraps a provider so that `Apply`
panics, and providers return actions from `Plan` rather than performing them. A provider
that mutates during a plan therefore fails loudly in tests rather than quietly in a
client's repository.

### State

The durable record of what was built. §7.

---

## 3. The resolution pipeline

Every command that needs to understand a product runs the same pipeline. `plan` and
`apply` differ only in what happens after step 7.

```
1. LOAD        Parse forge.yaml. Validate against manifest.schema.json.
2. PIN         Resolve the catalog snapshot. Fail if unpinned and not --latest.
3. CLOSE       Compute the requires-closure. Every dependency pulled in is recorded
               with its reason chain ("pay.subscriptions → pay.invoices → docs.generation").
4. SUBSTITUTE  Apply upgrades. ops.queue supersedes kernel.work; access.rebac supersedes
               kernel.access; comms.email supersedes kernel.mail; audit.history
               supersedes kernel.audit.
5. RESOLVE     Select concrete versions satisfying every declared range. Intersect all
               kernel_range constraints. Emptiness here is a validation error naming the
               two capabilities whose ranges do not overlap.
6. VALIDATE    Twelve checks, §6. All of them run; errors accumulate; nothing short-circuits.
               A single command run reports every problem, not the first one.
7. REFRESH     Read state. Hash every tracked generated file on disk. Query providers for
               actual resource state. Produce ActualState.
8. DIFF        DesiredState − ActualState → Plan.
9. RENDER      Human-readable plan.       ── plan stops here ──
10. APPLY      Execute in graph order with checkpointing.
```

### Upgrade substitution, precisely

The catalog says both `kernel.work` and `ops.queue` active is a validation error. But the
kernel is always present, so "active" needs a definition.

An upgrade **takes over the slot** occupied by the capability it upgrades. The upgraded
capability's *exposed interface* survives; its *implementation* is replaced. When
`ops.queue` is present, `kernel.work`'s `enqueue()` and `schedule()` still exist and every
consumer still calls them — they are now backed by a durable queue.

This yields a validation rule that the brief implies but does not state, and it is the
rule that makes upgrades safe:

> **An upgrade must satisfy the full exposed interface of the capability it upgrades.**
> `access.rebac` declaring `upgrades: kernel.access` must expose `can(user, action,
> resource)` with a compatible signature. Validation compares the two `exposes` blocks and
> fails on any interface present in the upgraded capability and absent from the upgrader.

Without this rule, enabling Fine-Grained Permissions silently breaks every capability that
called `can()`. With it, the failure is a validation error naming the missing interface.

### Wildcard and selector relationships

The catalog contains relationships that are not to a specific capability: `audit.history`
consumes *every event in the system*; `org.teams` extends *every tenant-scoped entity*;
`data.privacy` enhances *every capability owning personal data*.

These are declared as **selectors**, not prose. The schema permits a relationship target to
be a capability id, a glob (`pay.*`), or one of a closed set of derived selectors:

`all`, `owns_data`, `owns_personal_data`, `owns_listable_data`, `owns_tenant_scoped_data`,
`has_protected_resources`, `performs_async_work`, `notifies_humans`, `publishes_events`

Selectors are evaluated against the *resolved* graph. This is what makes
`forge graph` and the integration-weight computation possible without hand-maintained
lists, and it is why `owns` entries carry `personal_data`, `tenant_scoped`, and
`listable` flags.

### Integration weight is computed

The brief requires the premium to be counted, not estimated. The definition:

```
weight(product) = Σ capability.integration_weight
                + Σ 1 for each (publisher, consumer) event pair realised in the graph
                + Σ 2 for each realised `enhances` relationship
                + Σ 3 for each mandatory contract test pair present
```

`forge quote` prints the term breakdown, not just the total, so a proposal can justify the
integration line item to a buyer.

---

## 4. The generated-code surface

This is the section that determines whether the project succeeds.

### The governing principle

> **Every line Forge generates is a line that may be hand-edited and must later be
> three-way merged. The generated surface is a liability to be minimised, not a feature to
> be expanded.**

Budget: **under 400 lines of generated code per capability**, and it should mostly be
declarations. If a capability's templates exceed that, the excess belongs in its npm
package behind a configuration option or a slot. This budget is checked in CI at
`forge capability publish` time and a breach requires an explicit waiver in the spec.

### Three zones

Every file in a client repository is in exactly one zone, and the zone determines what
`apply` may do to it.

| Zone | Location | Forge may | On hand-edit |
|---|---|---|---|
| **Managed** | `forge/**`, `src/generated/**` | Overwrite freely | Drift — reported, never silently overwritten |
| **Seeded** | `src/app/**`, `src/slots/**` (on first create only) | Create once, then never touch | Nothing. It belongs to the client repo now |
| **Custom** | everywhere else | Nothing, ever | Nothing |

Managed files carry a header:

```ts
// ┌───────────────────────────────────────────────────────────┐
// │ GENERATED BY FORGE — DO NOT EDIT                           │
// │ capability: pay.card@2.1.0   template: routes.ts@2.0.0     │
// │ Edits are reported by `forge drift` and will conflict on   │
// │ upgrade. Customise via the `beforeCharge` slot instead.    │
// └───────────────────────────────────────────────────────────┘
```

The header names the sanctioned alternative. A generated-code warning that does not tell
you where to put your change is a warning people route around.

### Slots

Slots are the sanctioned location for client-specific logic and the pressure valve that
keeps the managed zone from being edited. A capability declaring
`slots: [{ name: "beforeCharge", ... }]` causes Forge to generate, **once**, a seeded stub:

```ts
// src/slots/pay.card/beforeCharge.ts
import type { BeforeChargeSlot } from '@forge/pay-card'

// Seeded by Forge. This file is yours — Forge will not modify it again.
export const beforeCharge: BeforeChargeSlot = async (ctx) => {
  return ctx.proceed()
}
```

The slot's *type* lives in the npm package and therefore upgrades with the package. If a
major version changes a slot signature, the client's implementation fails to compile —
which is exactly the outcome we want, because it is loud, local, and fixable.

Slot coverage is a design obligation on capability authors, not a nicety. **A capability
whose slots do not cover the customisation clients actually request will have its managed
files edited, and the fleet will fragment there.** Slot adequacy is reviewed at
`forge capability publish` and revisited whenever a drift report shows repeated edits to
the same managed file across clients — that pattern is the signal to add a slot.

### Drift

State records, for every managed file: the template id and version, the SHA-256 of the
content Forge wrote (`generated_hash`), and the zone. `forge drift` and the refresh phase
of every plan re-hash the file on disk.

- `current_hash == generated_hash` → clean.
- `current_hash != generated_hash` → **drifted**. Reported. Never silently overwritten.

A drifted file blocks `apply` on that file by default. `--accept-drift` overwrites it
(recording the overwrite in state), `--adopt` moves it to the seeded zone permanently, and
`forge eject <file>` does the same thing deliberately with a state record.

### Ejection

Per-file, never whole-project. This is the direct lesson of `create-react-app eject` (§5).

`forge eject <path>` moves a file from managed to seeded, records
`{ ejected_at_version, ejected_from_template, reason }` in state, and stops managing it.
The rest of the product continues to upgrade normally. `forge fleet status` reports ejected
files per workspace so we can see where the fleet is fragmenting before it becomes
expensive.

What is lost, stated plainly so it can go in client documentation: an ejected file no
longer receives capability upgrades, bug fixes, or security patches for that file's
concern. Re-adopting means discarding local changes.

---

## 5. Prior art

The brief requires this study before code. What follows is what each tool got right, what
it got wrong, and what we take.

### Terraform

**Worked.** Plan/apply separation as a non-negotiable ritual — the industry learned to
trust infrastructure automation because it could see the diff first. State as an explicit,
inspectable artifact rather than an inference. Providers as a stable extension seam.
`.terraform.lock.hcl` making builds reproducible.

**Did not work for our case.** Terraform manages resources nobody hand-edits. Its entire
drift story is "reality disagrees with me, I will make reality agree." Applied to source
code that a client's developer edited on Tuesday, that is data loss. `terraform import` is
also notoriously painful, which is a warning about our `forge import`.

**Taken.** The lifecycle, the state model, the provider seam, the lock file, the read-only
guarantee. **Rejected:** the drift resolution policy. Ours reports and blocks.

### Pulumi

**Worked.** Real languages give real abstraction, loops, and type checking over
infrastructure. The stack/config separation maps cleanly onto our workspace/manifest split.

**Did not work.** Once desired state is a program rather than data, the diff is only as
comprehensible as the program, and you cannot mechanically derive a proposal, a price, or
a dependency graph from it. The brief requires the manifest to drive a quote.

**Taken.** Stack/config separation. **Rejected:** desired state as code. The manifest stays
declarative data.

### Nx

The closest prior art for the actual hard problem, and the most instructive.

**Worked.** `nx migrate` splits upgrading into two steps: bump the package versions, then
run the codemods that the new versions shipped with. Migrations ship *with the package that
needs them*, which is exactly our "a major bump must ship its own migration script" rule.
`migrations.json` is reviewable before it runs.

**Did not work.** The codemods are AST transforms, and AST transforms are brittle against
code that has drifted from the idiom they expect. Nx's practical answer is that you stay
inside Nx conventions or migration stops working — acceptable for a monorepo tool the team
chose, unacceptable for twenty client repositories with twenty different developers.

**Taken.** Migrations shipped with the version that requires them; the reviewable
migration plan. **Rejected:** AST codemods as the *primary* merge mechanism. They are the
escape hatch for cases patching cannot express (§9.2), not the default.

### Rails generators, and why Rails apps actually upgrade

**The instructive part is that generators are not the upgrade mechanism.** `rails g
scaffold` is one-shot and forgets. Rails applications survive major upgrades because of
**engines**: versioned, packaged, mounted units of functionality upgraded by changing a
gem version. Devise ships authentication as a dependency, not as a pile of copied
controllers, which is why upgrading Devise is a bundle update rather than an archaeology
project.

`rails app:update` handles the small residue that *must* live in the app — config files,
initializers — with an interactive three-way-ish merge. It is noisy and mildly hated, and
that is the honest price of the residue.

**Taken.** The whole architecture of §2: capabilities are engines (npm packages), not
scaffolds. The generated residue is `app:update`'s territory and we keep it small for
exactly the reason `app:update` is unpleasant. **Rejected:** interactive per-file conflict
resolution, which does not scale to a fleet.

### Cookiecutter + cruft

**Worked.** `.cruft.json` records the template commit the project was generated from.
Upgrading computes the diff between the old and new template *renderings* and applies it as
a patch. This is the right general mechanism: it is semantic-free, it degrades gracefully
to standard conflict markers, and a developer already knows how to resolve those.

**Did not work.** No understanding of renames or moves. Conflicts are frequent when
projects diverge, and cruft offers no policy for handling them at scale — you resolve them
by hand, per project.

**Taken.** Patch-based three-way merge as the default upgrade mechanism, and the recorded
template version that makes it possible. **Added:** a fleet-level conflict *queue* with a
deterministic non-interactive policy, because "resolve by hand per project" is the thing we
are being paid to eliminate.

### create-react-app eject

**Did not work, and is the cautionary tale.** Ejection is all-or-nothing and irreversible.
One config tweak means the entire toolchain lands in your repository and the project can
never receive an upgrade again. Users learned to fear the button, then adopted
`react-app-rewired` to avoid pressing it — a whole ecosystem devoted to routing around a
design mistake.

**Taken.** Ejection is per-file, recorded in state, and does not affect anything else.
`react-app-rewired`'s existence is the argument for slots: people will find a way to
customise, and if the sanctioned path is catastrophic they will build an unsanctioned one.

### Yeoman

**Did not work at scale.** Per-file interactive conflict prompts. Fine for one developer
scaffolding one project; impossible across twenty workspaces in a batch operation.

**Taken as a constraint.** Every merge decision must have a deterministic non-interactive
default so `forge fleet apply` can run unattended, with anything genuinely ambiguous
deferred to a queue rather than a prompt.

### Synthesis

The design that falls out of this study:

1. **Rails engines** for the bulk — capabilities are dependencies, so most upgrading is a
   version bump with no merge at all.
2. **cruft's patch-based three-way merge** for the small generated residue — semantic-free,
   degrades to conflict markers a developer understands.
3. **Nx's shipped migrations** for what patching cannot express — schema changes, data
   backfills, and structural rewrites, shipped by the capability that requires them.
4. **Per-file ejection** as the escape hatch, because CRA proved that all-or-nothing
   ejection is not an escape hatch, it is an exit.
5. **Non-interactive by default with a conflict queue**, because Yeoman proved prompts do
   not scale to a fleet.

---

## 6. Validation

Twelve checks. All run; errors accumulate; the command reports every failure in one pass.
Every error names the file, the line, and the fix, per the brief's constraints.

| # | Check | Source |
|---|---|---|
| 1 | Manifest conforms to `manifest.schema.json` | Schema |
| 2 | Every capability spec conforms to `capability.schema.json` | Schema |
| 3 | Requires-closure resolves; no missing capability | Graph |
| 4 | No conflict pair both active, with the declared reason surfaced | Catalog |
| 5 | No two capabilities occupy the same upgrade slot | Catalog |
| 6 | Every upgrade satisfies the exposed interface of what it upgrades | §3 |
| 7 | Kernel range intersection across all resolved capabilities is non-empty | Brief §3 |
| 8 | Every consumed event has a publisher in the graph emitting a contract version the consumer handles | Brief §2 |
| 9 | Every required external credential is declared and present in the secrets provider (presence only — never read) | §9.4 |
| 10 | Every capability owning personal data declares export and deletion handlers, when `data.privacy` is enabled | Catalog |
| 11 | Every manifest-declared entity resolves; no name collision with a capability-owned entity | Composition rules |
| 12 | Every mandatory contract test for a realised pair exists in the catalog snapshot | Catalog Part Three |

Checks 4, 5, 8, 9, and 10 are the catalog's explicit "validation errors, not warnings"
list. Check 8 is the one that catches the most expensive class of bug: it turns *"the
subscription capability emits v2 payloads that the accounting sync does not understand"*
from a 2am production incident into a message printed before anything was built.

Warnings, not errors: a capability declaring `performs_async_work` running on `kernel.work`
rather than `ops.queue` (the catalog asks for a warning here, escalating to an error only
for `docs.extraction`, `automation.rules`, and integration capabilities).

---

## 7. State

One JSON document per workspace. Canonical form: keys sorted, two-space indent, LF, no
trailing whitespace — so that state diffs are reviewable in git and byte-stable across
runs.

```jsonc
{
  "state_version": 1,
  "workspace": "acme/production",
  "forge_version": "0.1.0",
  "serial": 47,                      // bumped every apply; the optimistic-lock token
  "manifest_hash": "sha256:…",       // detects manifest edits since last apply
  "catalog_snapshot": "2026-07-15",

  "lock": {
    "kernel": "1.4.2",
    "capabilities": { "pay.card": "2.1.0", "pay.invoices": "1.3.1" },
    "event_contracts": { "payment.succeeded": 2, "invoice.created": 1 },
    "templates":      { "pay.card:routes.ts": "2.0.0" }
  },

  "files": [
    {
      "path": "src/generated/pay.card/routes.ts",
      "zone": "managed",
      "capability": "pay.card",
      "template": "routes.ts",
      "template_version": "2.0.0",
      "generated_hash": "sha256:…",   // what Forge wrote
      "rendered_inputs_hash": "sha256:…" // for deterministic re-render check
    },
    {
      "path": "src/slots/pay.card/beforeCharge.ts",
      "zone": "seeded",
      "capability": "pay.card",
      "seeded_at": "2.0.0"
    }
  ],

  "ejected": [
    { "path": "src/generated/pay.card/webhook.ts",
      "ejected_from_template": "webhook.ts@1.9.0",
      "ejected_at_capability_version": "1.9.0",
      "reason": "client-specific fraud screening" }
  ],

  "migrations": [
    { "capability": "pay.card", "id": "20260701_create_charges",
      "applied_serial": 12, "checksum": "sha256:…", "rollback_available": true }
  ],

  "resources": [
    { "provider": "gcp", "type": "cloud_run_service", "id": "…", "attributes": { } }
  ],

  "outputs": { "app_url": "https://acme.example.com" }
}
```

Deliberately absent: **any secret value**, and any timestamp inside `files` (timestamps
would make state churn on every run and defeat reviewability). `serial` orders applies;
wall-clock times live in an append-only audit log alongside state, not in state itself.

**Backend.** Phase 1: local `.forge/state.json`. Phase 4: a GCS object per workspace, with
locking via object generation preconditions (`ifGenerationMatch`) — no separate lock table,
no lease to leak. A stale `serial` fails the write and the operator is told to re-plan.

**Repair.** `forge state show|list|rm` for inspection and surgical removal. Every mutating
state operation writes the prior version to `.forge/state.backups/<serial>.json` first.

---

## 8. Versioning and the lock file

Four independently versioned things, per the brief. What the engine does with each:

1. **Capability package** — semver. Major requires a shipped migration; publication fails
   without one. Minor is additive-only, enforced by diffing the new spec against the
   previous version: a removed event, a removed exposed interface, a narrowed config type,
   or a changed slot signature in a minor bump fails publication.
2. **Event contract** — integer version per event, independent of the capability. Publishers
   declare what they emit; consumers declare what they handle; check 8 proves the graph is
   satisfiable. A deprecated version is emitted alongside its replacement for one full
   major cycle, tracked in state so we can see when it is safe to remove.
3. **Kernel** — every capability declares `kernel_range`. Resolution intersects them. A
   kernel major is a coordinated release event; the catalog snapshot cannot be published
   until every capability has a compatible release.
4. **Catalog snapshot** — dated, immutable, verified by the full contract test suite.
   Clients pin to a snapshot. This is what makes a build reproducible eight months later.

The per-workspace lock file records the resolved value of all four. `forge fleet status`
reads lock files across every workspace and answers the operational question: who is
behind, on what, and by how much.

**What versions do not solve**, restated because it is the crux: a version number tells you
an upgrade exists. It does not tell you whether it applies cleanly to a repository someone
has been editing. That is §9.2.

---

## 9. Positions on the hard problems

### 9.1 Generated code will be edited by humans

**Position: minimise the generated surface, then make what remains honest about being
generated.**

The primary defense is architectural, not procedural: capabilities ship as npm packages, so
90%+ of a capability's code is never in the client repository and cannot be edited. The
400-line-per-capability generation budget (§4) is enforced in CI.

For the residue: three zones, hash tracking, drift reported and never silently overwritten,
slots as the sanctioned customisation path, per-file recorded ejection.

**Measured, and the risk was real.** The Phase 1 product (kernel + `pay.card` +
`pay.invoices` + their closure) generates **820 lines of managed code across 24 files**,
plus 32 seeded files the client owns outright.

| Attributed to | 0 client entities | 12 client entities × 8 fields |
|---|---|---|
| `kernel.data` (worst capability) | 260 | 260 |
| `kernel.events` | 95 | 95 |
| `kernel.admin` | 47 | 59 |
| `<client>` | 12 | 504 |

The first measurement put `kernel.data` at **664 lines — a clear breach** — because the
client-entity registrations and their SQL were rendered inside `kernel.data`'s templates.
That was a categorisation error, not a budget failure: those files are *the client's data
model rendered*, and they change when the manifest changes, not when a capability
upgrades. They now render as `<client>` (`internal/render/product.go`) and are measured
against a separate rule.

**Capability output must stay flat against the client's data model.** That property is
what makes the budget hold at all, and it is enforced by a test
(`TestCapabilityOutputDoesNotScaleWithClientEntities`) that fails if any capability grows
by more than 50 lines when twelve client entities are added.

The Phase 6 capabilities named as the original risk — `ops.formbuilder`, `ops.reporting`,
`integrate.publicapi` — are still unmeasured, because they are not built. They must follow
the same rule: anything derived from client declarations renders as `<client>`, and
anything that genuinely cannot be kept flat moves to build-time generation (a Next.js
plugin rendering into `.next/` from the manifest, never into the repository) rather than
raising the budget.

### 9.2 Upgrading a capability across a live fleet

**Position: a four-tier merge strategy, tried in order, with anything unresolved deferred
to a queue rather than a prompt.**

| Tier | Applies to | Mechanism |
|---|---|---|
| 1 | Package-only change | `package.json` version bump. No merge. The common case. |
| 2 | Clean managed file | Re-render the template and overwrite. Hash matched, so nothing is lost. |
| 3 | Drifted managed file | Three-way merge: `git merge-file <current> <old-rendering> <new-rendering>`. Re-rendering the *old* template with the *current* inputs is what makes this exact rather than approximate. |
| 4 | Structural change patching cannot express | A codemod shipped by the capability's migration, Nx-style. Rare and expensive to author, which is the correct incentive. |

Unresolved tier-3 conflicts do not stop the fleet run. The workspace is marked
`conflicted`, its changes are rolled back, and it lands in a conflict queue with the merge
output attached. Other workspaces continue. This is the Yeoman lesson (§5).

`forge fleet plan` runs the whole pipeline through step 9 for every workspace and reports
the aggregate: *N clean, M requiring merge, K conflicted, J pinned to an old version.* No
mutation. `forge fleet apply` executes with per-workspace isolation — one client's failure
never touches another's — and a `--batch` size so a bad upgrade is caught on three clients
rather than twenty.

Database migrations run forward with a tested rollback. A capability major without a
rollback script fails publication.

### 9.3 Capabilities must agree on shared concerns

**Position: sole kernel ownership, events as the only coupling, and static analysis that
makes the rule mechanical rather than cultural.**

- Only the kernel defines `User`, `Organization`, `Money`, `AuditEntry`, and the event bus.
  Check 11 fails a manifest entity or capability entity that collides.
- Cross-capability communication is via `kernel.events` or an explicitly `exposes`-declared
  interface. Nothing else.
- **Enforcement is a CI step, not a code review norm.** ESLint `no-restricted-imports`
  generated per capability from the resolved graph: `@forge/pay-card` may import
  `@forge/kernel-money` (declared in `requires`) and nothing else. `dependency-cruiser`
  catches deep-path imports that reach past a package's public entry point. Raw SQL
  touching another capability's tables is caught by a repository-layer allowlist derived
  from `owns`.
- The **`registers`** mechanism handles the contribution pattern that appears repeatedly in
  the catalog: capabilities registering permissions with `kernel.access`, relation schemas
  with `access.rebac`, metric definitions with `ops.reporting`, actions with
  `automation.rules`, tools with `ai.agents`, nav items with `kernel.ui`. Rather than six
  bespoke mechanisms, a capability declares
  `registers: [{ registry: "ops.reporting:metrics", entries: [...] }]`, and the target must
  declare a matching `exposes` entry of kind `registry`. This is why `automation.rules`'s
  action list and `ai.agents`'s tool list can be derived from the resolved graph, as the
  catalog requires.
- Every declared pair gets a contract test, generated from the declaration and run in CI on
  any change to either side. The catalog's eight mandatory pairs are marked
  `mandatory: true` and their absence is validation check 12.

### 9.4 Secrets never touch the manifest

**Position: the manifest holds names; only the secrets provider holds values; state never
holds either.**

The manifest's `secret_ref` type is a name and nothing else:

```yaml
integrations:
  stripe:
    secret_key:      { secret_ref: "acme/production/stripe_secret_key" }
    webhook_secret:  { secret_ref: "acme/production/stripe_webhook_secret" }
```

- `validate` checks **presence and readability**, never value. It calls
  `secrets.exists(ref)`. A missing credential fails before anything is built — the brief's
  "fail before starting, not halfway through."
- `apply` resolves values in memory, passes them to providers, and never writes them to
  state, to a generated file, or to a log. Provider inputs are redacted in plan output by
  type, not by pattern-matching on key names.
- Generated code reads secrets from the environment at runtime. Forge generates the
  *environment variable schema* (a Zod schema, failing fast at boot on a missing variable)
  and never the values.
- Phase 1 ships a `file` secrets provider reading from an untracked `.forge/secrets.json`,
  and a `.gitignore` entry is generated on `forge init`. Phase 4 ships GCP Secret Manager.

Designed in from the first commit, per the brief.

---

## 10. Determinism

The brief makes any nondeterminism a defect. Concretely:

- Template rendering takes only `(template, template_version, resolved_inputs)`. No clock,
  no random source, no environment, no network. `rendered_inputs_hash` in state lets us
  prove a re-render was input-identical.
- Map iteration is sorted by key before rendering. Go's randomised map order would
  otherwise produce byte-different output across runs.
- Generated files contain no timestamps, no UUIDs, and no machine identifiers. Identifiers
  that must be stable are derived: `uuidv5(namespace, workspace + capability + logical_name)`.
- The formatter (Prettier) version is pinned in the catalog snapshot, because a formatter
  upgrade would otherwise rewrite every managed file and register as fleet-wide drift.
- **CI asserts it.** Every catalog snapshot renders the reference product twice in
  different working directories and byte-compares. A difference fails the snapshot.

AI generation is Phase 6 and is confined to producing *manifest content* (branding, copy,
seed data) which a human reviews and commits. It never enters the rendering path. Identical
manifest plus identical versions produces byte-identical output, or a down client cannot be
debugged.

---

## 11. Provider interface

Defined in Phase 1, with only `codegen` implemented, so that Phase 4 is an addition rather
than a refactor.

```go
type Provider interface {
    Name() string
    Schema() *jsonschema.Schema           // provider config, validated at load
    Validate(ctx, Config) []Diagnostic    // read-only preflight
    Refresh(ctx, []Resource) ([]Resource, error)  // read-only
    Plan(ctx, Desired, Actual) ([]Action, error)  // read-only, MUST NOT mutate
    Apply(ctx, Action) (Resource, error)          // the only mutating method
}
```

`Plan` returning actions rather than performing them is what makes the read-only guarantee
structural. Read-only commands wrap providers in a decorator whose `Apply` panics, so a
provider that violates the contract fails loudly in tests rather than quietly in
production.

---

## 12. Repository layout

```
forge/
├── ARCHITECTURE.md
├── schemas/
│   ├── capability.schema.json      # the capability specification format
│   └── manifest.schema.json        # the product manifest format
├── catalog/
│   ├── kernel/*.capability.json    # the 11 kernel capabilities
│   ├── pay/, org/, docs/, ...      # Part Two capabilities, added per phase
│   └── snapshots/2026-07-15.json   # immutable pinned version sets
├── packages/                       # the runtime half: npm packages
│   ├── kernel-data/  kernel-identity/  kernel-events/  …
│   └── pay-card/  pay-invoices/  …
├── templates/                      # the generated half, per capability
│   └── pay.card/{migrations,routes.ts.tmpl,slots/}
├── cmd/forge/                      # Go CLI entry point
├── internal/
│   ├── manifest/  catalog/  resolve/  plan/  state/  render/  merge/
│   └── provider/{codegen,gcp,dns,secrets}/
├── examples/acme.forge.yaml        # annotated reference manifest
└── docs/
    ├── brief.md
    └── catalog.md                  # the prose catalog (source of truth for Part Two)
```

Single repository, per the brief's constraints. The npm packages in `packages/` are
published to a private registry; splitting a capability into its own repository happens
only when it genuinely needs an independent release lifecycle.

---

## 13. Phase 1 scope and exit criteria

Per the brief: the kernel plus two trivial capabilities, one codegen provider, on one
end-to-end path.

**The two capabilities: `pay.card` and `pay.invoices`.** Chosen deliberately over an easier
pair, because between them they exercise every mechanism that matters:

- a genuine `requires` edge (`pay.invoices` → `docs.generation` → `data.files`)
- a real publisher/consumer pair (`payment.succeeded` → `pay.invoices`)
- an `enhances` relationship (`pay.card` enhances `pay.invoices`)
- external credentials (Stripe) exercising the secrets path
- slots (`beforeCharge`, `numberingScheme`) exercising the seeded zone
- a mandatory contract test
- a non-trivial migration

If the engine composes these two correctly, it composes the catalog. If we picked two
capabilities with no relationship, Phase 1 would prove nothing about the part that is hard.

**Exit criteria, all required:**

1. `forge init` → `forge apply` from an empty directory produces a Next.js application that
   boots, connects to Postgres, serves a login page, and takes a Stripe test-mode payment.
2. `forge apply` a second time reports **no changes** and writes no files. Idempotency is
   the single most important Phase 1 signal.
3. `forge plan` after a hand-edit to a managed file reports drift and refuses to overwrite.
4. `forge validate` on a manifest selecting `pay.invoices` without its dependency prints an
   error naming the file, the line, and the fix.
5. Rendering the reference product twice byte-compares equal.
6. Engine test coverage on dependency resolution, plan diffing, state persistence, and
   idempotency — the parts that silently corrupt a client.

Deliberately **not** in Phase 1: three-way merge, ejection, remote state, any cloud
provider, `forge quote`, `forge fleet`. Those are Phases 3–5. The brief is explicit that a
working narrow path beats a broad half-built one.

---

## 14. Decisions taken at review

All six questions raised at the Phase 0 review are resolved. The ORM was decided by the
client; the remaining five were decided here, with the reasoning recorded so a later
reversal knows what it is overturning.

### 14.1 ORM: Drizzle — *decided by client*

Migrations are plain SQL, so they are three-way mergeable, readable in a plan, and
reviewable by anyone who reads SQL. The schema is TypeScript that composes across packages,
which is what lets each capability own its own tables in its own npm package.

The rejected alternative matters: Prisma's single-file `schema.prisma` would have to be
*generated by merging every capability's schema plus every manifest-declared client
entity*. That is a large, constantly-changing managed file sitting in the client
repository — precisely the shape §4 says to avoid, and it would have been the single
biggest merge-conflict source in the system.

Consequences: migrations are `.sql` files under each capability, applied by an ordered
runner keyed on the migration ledger in `kernel.data`. Drizzle's own `drizzle-kit` diffing
is **not** used to author migrations — capability migrations are hand-written and reviewed,
because a generated diff cannot express a data backfill and cannot be rolled back.

### 14.2 Multi-tenancy: repository-layer scoping

Confirmed as the catalog states. `org.teams` adds an organization reference to every
entity flagged `tenant_scoped`, and every query goes through `kernel.data`'s `Repository<T>`,
which binds the tenant predicate. A capability cannot issue an unscoped query without
bypassing the repository, which the static-analysis rules in §9.3 already forbid.

Postgres row-level security was considered as defense-in-depth and **rejected for now**.
RLS depends on a session variable being set correctly on every connection, and with a
pooled serverless runtime (Cloud Run to Cloud SQL through a pooler) a leaked or unset
session variable is both easy to cause and silent. A misconfigured RLS policy would give us
the *appearance* of a second layer while the real enforcement stayed in the repository.
Revisit in Phase 4 when the connection topology is fixed and testable.

The enforcement that ships instead: a **generated cross-tenant leak test per capability
per owned entity**, asserting that a query issued in tenant A's context returns nothing
belonging to tenant B. Generated from `owns[].tenant_scoped`, so it cannot be forgotten.

### 14.3 Package distribution: workspace in Phase 1, private registry from Phase 2

Two-step, because the two phases need different things.

Phase 1 uses a pnpm workspace with the generated app as a member. Capability changes are
picked up without a publish cycle, which is what makes engine iteration fast.

From Phase 2, capabilities publish to a private npm registry (GCP Artifact Registry,
matching the cloud decision) and client repositories depend on published versions. This is
non-negotiable before the first real client: a client repository that can only build inside
our monorepo is not a deliverable we can hand over, and version pinning is meaningless if
the dependency is a workspace symlink.

### 14.4 Client repositories: one per client, upgrades land as pull requests

One GitHub repository per client under our organisation. `forge fleet apply` opens a pull
request per workspace rather than pushing to the default branch — already the schema
default in `repository.upgrade_strategy`.

The reasoning is that a fleet upgrade is the highest-risk operation in the system, and a PR
gives us a reviewable diff, CI on the client's own test suite, and a revert path that is
one click rather than a state repair. `direct_push` remains available for environments
where the ceremony is not worth it, such as a client's `development` workspace.

### 14.5 Quoted capabilities do not participate in computed weight

A `price.model: quoted` capability — today only `integrate.custom` — is **excluded** from
the automatic integration-weight computation, and `forge quote` emits it as a separate
proposal line requiring a human figure.

The reason is that the computation in §3 counts *declared* relationships, and a quoted
capability's defining property is that its relationships are not yet known — its `slots`
field is the entire implementation. Feeding a placeholder weight into a computed premium
would produce a number with the appearance of derivation and none of the substance, which
is worse than an obvious blank. `forge quote` fails rather than guessing if a quoted
capability is present and no manual figure was supplied.

### 14.6 Contract tests live in the catalog; smoke tests live in the client

Confirmed as proposed.

**Contract tests** are defined by a declared pair, so they belong to the catalog and run in
our CI against a synthetic product on every change to either capability. This catches a
contract regression *before release*, which is the only time it is cheap. Running them
per-client would mean discovering the same breakage twenty times, after shipping.

**Smoke tests** are generated into the client repository and run in that client's CI,
because what they prove is client-specific: that *this* client's Stripe credentials work,
that *this* client's declared entities migrate, that *this* client's configured
integrations are reachable. From Phase 5 they are promoted into ongoing synthetic
monitoring.

The one deliberate overlap: **cross-tenant leak tests are generated client-side as well**
(§14.2), because they depend on the client's resolved entity set, and a leak is the one
failure severe enough to justify testing twice.
