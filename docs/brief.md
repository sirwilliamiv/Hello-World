# Agent Brief: Forge

**A design system for products**

Origin Platform Labs LLC | Greenfield, nothing exists yet

---

## The Mental Model

A UI design system does not let you draw anything. It gives you a fixed set of components, each with a documented purpose, a typed API, defined states, and rules about what it may contain and what it may sit inside. You compose interfaces from that set. When the set is insufficient, you extend the system deliberately rather than drawing something one-off.

Forge is that, one level up. Instead of buttons and modals, the components are business capabilities: taking payments, reading documents, scheduling crews, syncing to accounting software. Instead of composing a screen, you compose a product.

**The constraint is the point.** A product may only be built from capabilities in the catalog. If a client needs something outside it, that is a signal to either extend the catalog properly or price the work as custom, not to improvise inside a client repository. Design systems fail the same way: the moment people start drawing one-off components, consistency dies and maintenance cost compounds.

Terraform supplies the mechanics for this. Design system discipline supplies the rules.

| From design systems | From Terraform |
|---|---|
| A fixed, documented catalog | Declarative desired state |
| Typed component APIs | Module inputs, outputs, and validation |
| Tokens rather than one-off values | Variables and workspaces |
| Composition rules and slots | Dependency graph resolution |
| Variants of a base component | Capabilities that upgrade kernel primitives |
| Versioned releases and changelogs | Semantic versioning, lock files, state |
| Storybook as the living catalog | Plan output as the living diff |

---

## Why This Exists

The business sells custom software at $40,000 to $70,000 per engagement, assembled from a library of pre-built capabilities. The margin thesis is that the second client in a vertical costs a fraction of the first and the fifth is close to configuration.

That only holds if composition is systematic. Copying a previous client's repository produces forks that diverge within weeks. A year later, an authentication security patch has to be hand-applied to twenty codebases that no longer resemble each other.

Forge makes client applications **assembled from versioned capabilities** rather than copied. Targets: under one hour of human time to stand up a client on an existing template, and a single command to roll a capability upgrade across the entire fleet.

---

## Core Concepts

**Manifest.** One declarative file per product. The only artifact a human edits during routine onboarding. Declares identity, branding, selected capabilities with version constraints, client-specific domain entities, integration targets, and environments. Rich enough to also drive a proposal and a price.

**Capability.** A versioned package equivalent to a design system component. Owns its schema, migrations, code templates, configuration schema, environment requirements, seed data, tests, UI surfaces, and its declared relationships to other capabilities. Never copied into a client repository. Imported as a dependency.

**Kernel.** The primitives every capability depends on, equivalent to the tokens and base elements of a design system. Identity, organizations, permissions, events, audit, money, and background work. Present in every product without exception.

**Provider.** A pluggable backend that makes something real: code generation, cloud infrastructure, DNS, or configuration of an external service.

**Plan.** A computed, human-readable diff between declared and actual state. Mutates nothing. Non-negotiable.

**State.** A durable record of what was built: capability versions, resources created, generated file inventory with content hashes, migration history. Remote with locking.

**Workspace.** One isolated instance of a product, typically one per client per environment.

---

## The Capability Specification

This is the heart of the system and the first thing to build. A design system component is worthless without its documentation; the same is true here. **Every capability must declare, in machine-readable form, exactly what it interacts with.** The dependency graph, the plan output, the contract tests, the integration pricing, and the client-facing documentation are all derived from these declarations rather than maintained separately.

Every capability ships a specification containing:

| Field | Meaning |
|---|---|
| `id` | Stable identifier, namespaced |
| `version` | Semantic version of this capability package |
| `kernel_range` | Compatible kernel versions, expressed as a range |
| `name` | Human label used in proposals and client documentation |
| `trigger` | The buyer-facing sentence describing when this is needed |
| `price` | List price, so the manifest can produce a quote |
| `tier` | `kernel`, `capability`, or `upgrade` |
| `requires` | Hard dependencies with version ranges. Apply fails without them |
| `enhances` | Optional relationships that unlock behavior when both are present |
| `conflicts` | Capabilities that cannot coexist, with the reason |
| `upgrades` | The kernel primitive or capability this replaces, if any |
| `owns` | Data entities this capability defines and is the sole writer for |
| `extends` | Entities owned elsewhere that this capability adds fields to |
| `publishes` | Events emitted, each with its own contract version and payload schema |
| `consumes` | Events subscribed to, with the contract versions handled, and whether required |
| `exposes` | Interfaces, API routes, and UI surfaces made available to other capabilities |
| `external` | Third-party services, and which credentials are needed |
| `config` | Typed configuration schema with defaults |
| `slots` | Named extension points where client-specific logic may be inserted |
| `surfaces` | Where this appears in the application and admin interfaces |
| `tests` | Smoke test templates generated when this capability is enabled |
| `migrations` | Forward and rollback scripts, including the upgrade script required by any major bump |
| `integration_weight` | Contribution to the systems integration premium |

Two rules make this real:

**Nothing undeclared.** A capability may not read another capability's tables, import its internals, or call it directly unless the relationship is declared. Enforce this in CI with static analysis. This is the equivalent of a design system forbidding a component from reaching into another component's internal styles.

**Every declared pair gets a contract test.** If `billing.subscriptions` declares that it consumes `identity.user.deleted`, a test proving that behavior runs on every change to either capability. This is the connective work being priced as systems integration, and it should be automated rather than rediscovered per client.

---

## Versioning

Four separate things carry versions. Conflating them is a design error that surfaces later as an unupgradeable fleet.

### 1. The capability package

Semantic versioning per capability, independently released with its own changelog. This independence is what makes fleet upgrades possible: bumping `pay.subscriptions` produces a plan only for clients who have it.

- **Patch:** internal fix, no schema or contract change
- **Minor:** additive only. New optional fields, new events, new slots. Existing consumers keep working untouched
- **Major:** breaking change to owned schema, exposed interfaces, or published event payloads. **A major bump must ship its own migration script.** A major without a migration fails publication

### 2. The event contract

Versioned separately from the capability that publishes it, because the two change at different rates. A capability can go 2.x to 3.x internally without altering what it emits, and a payload can change without a capability rewrite.

- Publishers declare the contract version of each event they emit
- Consumers declare which contract versions they handle
- A publisher emitting a version no consumer in the resolved graph supports is a validation error, not a runtime surprise
- Deprecated event versions are emitted alongside their replacement for one full major cycle, then removed

### 3. The kernel

Every capability declares a compatible kernel range. This is the constraint that actually gates a fleet-wide upgrade, since the kernel is the only thing present in every product.

- A kernel major is a coordinated event requiring every capability to publish a compatible release first
- Validation rejects a manifest whose resolved capability set has no kernel version satisfying all declared ranges
- Kernel majors should be rare and planned. Treat frequency as a design smell

### 4. The catalog

A dated, immutable snapshot pinning the exact set of capability versions known to work together, verified by the full contract test suite. Clients are pinned to a catalog snapshot rather than to floating versions, which is what makes a build reproducible eight months later.

### Per client

A lock file records the resolved versions of the kernel, every capability, every event contract, and the catalog snapshot. `forge fleet` reads lock files across all workspaces to answer the operational question: who is behind, on what, and by how much.

### The part version numbers do not solve

Code templates version with their capability, but the generated code lives in a client repository and may have been edited. An upgrade is therefore a three-way merge between the previous template, the new template, and the client's current file.

Version numbers tell you an upgrade is available. They do not tell you whether it can be applied cleanly. That is the drift and ejection machinery in Phase 3, and it is the real work of upgrading a fleet.

---

## Composition Rules

A design system encodes what may sit inside what. Forge needs the same, enforced at validation time before anything is built.

- **Kernel is mandatory and implicit.** Never listed in a manifest, always present.
- **Dependencies resolve automatically, and the plan says so.** Selecting Recurring Billing pulls in Card Payments and Invoices. The plan shows the additions and their prices so nothing is a surprise commercially or technically.
- **Upgrades replace, they do not stack.** Durable Background Processing replaces the kernel's in-process queue. Fine-Grained Permissions replaces the kernel's basic roles. Two capabilities occupying the same slot is a validation error.
- **Conflicts fail loudly at validate, never at apply.**
- **Integration weight is computed, not estimated.** The premium comes from counting declared cross-capability relationships in the resolved graph, which makes the commercial model a direct output of the technical one.
- **Client-specific entities are declared in the manifest, not invented in code.** They participate in permissions, audit, search, and reporting automatically because they are declared.

---

## The Hard Problems

Address these in writing before significant code. They determine whether this succeeds.

### Generated code will be edited by humans

Terraform manages resources nobody hand-edits. Forge manages source code that will be edited within a week of delivery, because every client has logic no capability anticipated.

- Enforced boundary between generated and custom code
- Generated files hash-tracked in state; a mismatch is drift, surfaced in plan, never silently overwritten
- Capabilities expose named slots so customization has a sanctioned location
- A documented ejection path: what it does, what is lost, how state records it

Study Rails generators, Nx, Cookiecutter with cruft, and create-react-app ejection. Write down what worked and what did not, and why most scaffolding tools became one-shot generators that could never safely touch the code again. Becoming a one-shot generator is this project's primary failure mode, because it would leave the fleet upgrade problem unsolved.

### Upgrading a capability across a live fleet

The core reason the system exists.

- A version bump produces a per-client plan showing exactly what changes
- Migrations run forward with a tested rollback
- Breaking changes require a migration script shipped by the capability itself
- Batch operations with per-client dry runs and isolated failure
- Clients pinned to old versions keep working and are visibly flagged

### Capabilities must agree on shared concerns

Independent capabilities each defining a user, a customer, or an audit event produce an incoherent product.

- Kernel owns the shared primitives, and only kernel may define them
- Capabilities communicate through the declared event contract rather than direct coupling
- Contract tests between every declared pair, run in CI
- Conflicting definitions detected at schema resolution

### Secrets never touch the manifest

The manifest is committed and may be shared. Credentials are referenced by name and resolved from a secrets provider at apply time. Design this in from the first commit.

---

## Command Surface

```
forge init <product>              interactive manifest scaffold
forge validate                    schema, graph, conflict, and credential checks
forge plan                        compute and display the diff, mutate nothing
forge apply                       execute with confirmation
forge apply --target=<capability> operate on one capability
forge catalog                     browse the capability catalog
forge catalog show <id>           full specification including all interactions
forge graph                       render the resolved dependency graph
forge quote                       produce a priced proposal from the manifest
forge drift                       report hand-edits to generated files
forge capability new|publish      author and publish a capability
forge capability upgrade <id>     plan and apply a version bump
forge catalog snapshot            pin and publish a verified catalog version
forge catalog diff <a> <b>        compare two catalog snapshots
forge outdated                    report versions behind for this workspace
forge workspace new|select|list   manage client and environment instances
forge fleet plan|apply            batch operations across all workspaces
forge fleet status                version compliance across every client
forge test                        run generated smoke and contract tests
forge state show|list|rm          inspect and repair state
forge import <resource>           bring an existing system under management
```

`forge catalog` and `forge graph` are the equivalent of Storybook. They are how a human understands the system, and they should be good.

---

## Build Sequence

Ship a working narrow path before broadening.

**Phase 1: Prove the loop.** Capability specification format, manifest schema, validation, local state, dependency resolution, plan and apply against the kernel plus two trivial capabilities on one code generation provider. Success is a manifest producing a running application, with re-apply changing nothing.

**Phase 2: Make the catalog real.** Authoring format, local registry, semantic versioning, lock file, typed inputs and outputs, full kernel, contract tests between declared pairs, `forge catalog` and `forge graph`.

**Phase 3: Survive humans.** Drift detection, slots, ejection, three-way merge on upgrade, useful conflict reporting.

**Phase 4: Real infrastructure.** Cloud provider covering environments, database, secrets, DNS, certificates, deployment, and monitoring. Remote state with locking.

**Phase 5: Fleet.** Batch upgrades, version compliance reporting, per-client smoke tests promoted into ongoing synthetic monitoring.

**Phase 6: Speed.** Interactive init, branding and copy generation, vertical templates that preselect capability sets, seed data generation.

AI generation belongs in Phase 6 and nowhere earlier. Everything before it is deterministic on purpose. Identical manifest and versions produce byte-identical output, or the system cannot be debugged when a client is down.

---

## Constraints

- **Determinism above all.** Any nondeterminism is a defect.
- **Nothing mutates outside apply.** Plan, validate, catalog, graph, and drift are read-only.
- **Fail before starting, not halfway through.** Validate credentials, permissions, and compatibility up front. A partial apply is the worst outcome.
- **Errors name the file, the line, and the fix.**
- **Single repository, capabilities as packages within it.** Split only when something needs its own release lifecycle.
- **Test the engine, not only the output.** Dependency resolution, diffing, and state handling need real coverage. Those are the parts that silently corrupt a client.
- **The catalog is closed.** Adding a capability is a deliberate act with a specification, tests, documentation, and a price. There is no informal path.

---

## Deliverables for Phase 1

1. `ARCHITECTURE.md` covering the domain model, plan and apply lifecycle, state format, and a written position on each hard problem above.
2. Capability specification JSON Schema, with the kernel specified against it as the reference example.
3. Manifest JSON Schema with an annotated example.
4. Working CLI implementing `init`, `validate`, `plan`, `apply`, and `catalog show`.
5. Kernel plus two dependent capabilities, end to end, with their declared interactions enforced by contract tests.
6. Tests covering dependency resolution, plan diffing, state persistence, and idempotency.
7. One command from empty directory to running application.

---

## How to Start

Do not write code first.

1. Read the accompanying capability catalog. It defines every component in the system and every declared interaction between them. It is the specification this engine has to satisfy, and the domain model should fall out of it.
2. Study how Terraform, Pulumi, Nx, and Rails generators handle the generated-versus-custom boundary. Write down what worked and what did not.
3. Produce `ARCHITECTURE.md` and both schemas. Stop and get review.
4. Then start Phase 1.

State assumptions explicitly, especially the target application framework and cloud provider. Surface expensive-to-reverse decisions as questions rather than choosing silently.

The failure mode to avoid is an elegant general-purpose engine that never composes a real product. Optimize relentlessly for the first working end-to-end path.
