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

## Status: Phase 1, engine complete

An empty directory to a rendered client application in two commands. The resolution
pipeline, plan/apply lifecycle, state, drift detection, and per-file ejection all work;
applying twice is a verified no-op and rendering is byte-identical across runs.

The `@forge/*` runtime packages that the generated wiring imports are **not implemented
yet**, so the generated app does not boot. That is the remaining Phase 1 work and it is
ordinary application development against interfaces the specifications already pin down.

| Artifact | Path |
|---|---|
| Architecture, lifecycle, state format, prior-art study, positions on the hard problems | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| Capability specification schema | [`schemas/capability.schema.json`](schemas/capability.schema.json) |
| Manifest schema | [`schemas/manifest.schema.json`](schemas/manifest.schema.json) |
| The kernel — 11 capabilities, the reference example | [`catalog/kernel/`](catalog/kernel/) |
| Phase 1 capabilities — `pay.card`, `pay.invoices` and their closure | [`catalog/pay/`](catalog/pay/), [`catalog/docs/`](catalog/docs/), [`catalog/data/`](catalog/data/), [`catalog/ops/`](catalog/ops/) |
| The `forge` CLI | [`cmd/forge/`](cmd/forge/) |
| Engine — resolution, validation, diagnostics | [`internal/`](internal/) |
| Annotated reference manifest | [`examples/acme.forge.yaml`](examples/acme.forge.yaml) |
| Phase 1 reference product | [`examples/phase1/forge.yaml`](examples/phase1/forge.yaml) |
| Agent brief | [`docs/brief.md`](docs/brief.md) |

## Assumptions

Decided at kickoff. Rationale and reversal cost in [`ARCHITECTURE.md` §0](ARCHITECTURE.md#0-assumptions-stated-explicitly).

| | |
|---|---|
| Generated applications | Next.js (App Router) + TypeScript + PostgreSQL |
| ORM | Drizzle — plain-SQL migrations that three-way merge and read in a plan |
| `forge` CLI | Go |
| Cloud target (Phase 4) | Google Cloud Platform |
| Multi-tenancy | Repository-layer scoping, with generated cross-tenant leak tests |
| Distribution | pnpm workspace in Phase 1, private registry from Phase 2 |

## Try it

```
go build -o forge ./cmd/forge

# Empty directory to a rendered application, in two commands.
mkdir /tmp/acme
./forge init --target-dir /tmp/acme --product acme --client "Acme LLC" \
             --capabilities pay.card,pay.invoices
./forge apply -f /tmp/acme/forge.yaml --target-dir /tmp/acme

# Then, in any order:
./forge plan  -f /tmp/acme/forge.yaml --target-dir /tmp/acme   # the diff, mutates nothing
./forge drift -f /tmp/acme/forge.yaml --target-dir /tmp/acme   # hand-edits to generated files
./forge graph -f /tmp/acme/forge.yaml                          # the resolved graph
./forge quote -f /tmp/acme/forge.yaml                          # priced proposal
./forge catalog show pay.card                                  # full specification
```

`init` reads the specifications to scaffold every credential the selected capabilities
need — including the ones pulled in transitively, which are exactly the ones an operator
would not think to look for.

`graph` shows the resolver doing the work that matters: two capabilities are named in the
manifest, three more (`docs.generation`, `data.files`, `ops.queue`) are pulled in
transitively with the chain that caused each addition, and `ops.queue` supersedes the
kernel's in-process queue while keeping its interface intact.

`apply` is the only command that mutates anything.

## What it produces

56 files for the Phase 1 product: **24 managed** (hash-tracked, overwritten on apply,
drift reported) and **32 seeded** (slot stubs and skeleton files that belong to the client
the moment they are written). Managed output is 820 lines, with the largest single
capability at 260 against a 400-line budget — see
[`ARCHITECTURE.md` §9.1](ARCHITECTURE.md#91-generated-code-will-be-edited-by-humans) for
the measurement, including the categorisation error the first measurement exposed.

## Test

```
go test ./...                  # engine: resolution, validation, determinism, end to end
python3 tools/validate.py      # schemas and catalog consistency (needs jsonschema, pyyaml)
```

The Go tests cover the parts the brief singles out as silently corrupting a client:
dependency resolution, upgrade substitution and interface satisfaction, conflict
detection, apply ordering, plan diffing, state persistence and concurrent-write
rejection, idempotency, drift, ejection, and determinism across repeated runs. Two of them
are guardrails rather than assertions — the generation budget, and the rule that
capability output must not scale with the client's data model.

`tools/validate.py` checks the shipped catalog against the shipped schema and caught two
real inconsistencies while the kernel was being written.

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
catalog/                   capability specifications, one JSON file each
cmd/forge/                 CLI entry point
internal/
  spec/                    typed view of a capability specification
  catalog/                 loading and schema validation
  manifest/                forge.yaml parsing, with line numbers for diagnostics
  resolve/                 closure, upgrade substitution, apply ordering
  validate/                the checks in ARCHITECTURE.md section 6
  diag/                    diagnostics carrying file, line, and fix
examples/                  reference manifests
tools/validate.py          schema and catalog consistency checks
docs/                      brief and prose catalog
```

Planned additions per [`ARCHITECTURE.md` §12](ARCHITECTURE.md#12-repository-layout):
`packages/` (the npm runtime half of each capability), `templates/` (the generated half),
`internal/plan/`, `internal/state/`, `internal/render/`, `internal/provider/`, and
`catalog/snapshots/`.

## What is deliberately not here yet

`plan`, `apply`, and `init` need the codegen provider, which is the next piece of Phase 1.
Three-way merge, ejection, remote state, cloud providers, and `forge fleet` are Phases 3–5.
The brief is explicit that a working narrow path beats a broad half-built one — the failure
mode to avoid is an elegant general-purpose engine that never composes a real product.
