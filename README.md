# Forge

**A design system for products.** Origin Platform Labs LLC.

Forge composes a client product from versioned business capabilities according to a
declarative manifest. Instead of buttons and modals, the components are capabilities —
taking payments, reading documents, scheduling crews, syncing to accounting software.
Instead of composing a screen, you compose a product.

Client applications are **assembled from versioned capabilities**, never copied from a
previous client. Two numbers define success:

- **< 1 hour** of human time to stand up a client on an existing vertical template
- **1 command** to plan a capability upgrade across the entire fleet

---

## Status: Phase 0 — awaiting review

No engine code has been written. This is the pre-code deliverable the brief calls for in
*How to Start*: the architecture, both schemas, and the kernel specified against the
capability schema as the reference example.

| Artifact | Path |
|---|---|
| Architecture, lifecycle, state format, prior-art study, positions on the hard problems | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| Capability specification schema | [`schemas/capability.schema.json`](schemas/capability.schema.json) |
| Manifest schema | [`schemas/manifest.schema.json`](schemas/manifest.schema.json) |
| The kernel — 11 capabilities, the reference example | [`catalog/kernel/`](catalog/kernel/) |
| Annotated reference manifest | [`examples/acme.forge.yaml`](examples/acme.forge.yaml) |
| Agent brief | [`docs/brief.md`](docs/brief.md) |

**Six open questions are listed in [`ARCHITECTURE.md` §14](ARCHITECTURE.md#14-open-questions-for-review).**
One of them — the ORM choice — blocks Phase 1 and should be settled at review.

## Assumptions

Decided at kickoff. Rationale and reversal cost in [`ARCHITECTURE.md` §0](ARCHITECTURE.md#0-assumptions-stated-explicitly).

| | |
|---|---|
| Generated applications | Next.js (App Router) + TypeScript + PostgreSQL |
| `forge` CLI | Go |
| Cloud target (Phase 4) | Google Cloud Platform |

## Verify

`tools/validate.py` checks that both schemas are legal JSON Schema Draft 2020-12, that
every kernel capability validates against the capability schema, that the annotated
manifest validates against the manifest schema, and that the kernel is internally
consistent — no unknown dependencies, no unpublished required events, no contract-version
mismatches, no entity-name collisions, and no registration into an undeclared capability.

```
pip install jsonschema pyyaml
python3 tools/validate.py
```

This is a stand-in for `forge validate` until the Go engine exists. It already implements
checks 1, 2, 3, 8, 11, and part of 9.3 from [`ARCHITECTURE.md` §6](ARCHITECTURE.md#6-validation);
it caught one real inconsistency in the kernel while it was being written.

## The two rules that make this real

**Nothing undeclared.** A capability may not read another capability's tables, import its
internals, or call it directly unless the relationship is declared in its specification.
Enforced in CI by static analysis, not by code review norms.

**Every declared pair gets a contract test.** If `pay.subscriptions` declares that it
consumes `identity.user.deleted`, a test proving that behavior runs on every change to
either capability. This is the connective work being priced as systems integration, and it
is automated rather than rediscovered per client.

## Repository layout

```
ARCHITECTURE.md            the design document
schemas/                   capability and manifest JSON Schemas
catalog/kernel/            the 11 kernel capabilities
examples/                  annotated reference manifest
tools/validate.py          schema and consistency checks
docs/                      brief and prose catalog
```

Planned additions per [`ARCHITECTURE.md` §12](ARCHITECTURE.md#12-repository-layout):
`packages/` (the npm runtime half of each capability), `templates/` (the generated half),
`cmd/forge/` and `internal/` (the Go engine), `catalog/snapshots/`.

## What is deliberately not here yet

Phase 1 is the kernel plus `pay.card` and `pay.invoices` on one codegen provider, with
`forge init | validate | plan | apply | catalog show`. Three-way merge, ejection, remote
state, cloud providers, `forge quote`, and `forge fleet` are Phases 3–5. The brief is
explicit that a working narrow path beats a broad half-built one — the failure mode to
avoid is an elegant general-purpose engine that never composes a real product.
