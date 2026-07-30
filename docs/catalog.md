# Capability Catalog — placeholder

**This file is a placeholder and needs the real document committed over it.**

The Forge Capability Catalog (version 0.1) — the prose document defining the kernel, all
Part Two capabilities, their declared interactions, prices, and the composition notes — was
supplied as a chat message rather than as a file, so it is not reproduced here. Rather than
retype ~700 lines and risk a transcription error in the document that is the specification
this engine must satisfy, it is flagged for direct commit.

**Action required:** commit the source catalog document to this path.

## What already depends on it

The catalog has been used, from the supplied text, to derive:

- Every field in [`schemas/capability.schema.json`](../schemas/capability.schema.json),
  including the `capabilitySelector` mechanism that makes relationships such as *"every
  capability owning personal data"* machine-readable, and the `registers` mechanism that
  makes the `automation.rules` action list and the `ai.agents` tool list derivable from the
  resolved graph.
- All eleven kernel specifications in [`catalog/kernel/`](../catalog/kernel/).
- The validation table in [`ARCHITECTURE.md` §6](../ARCHITECTURE.md#6-validation), whose
  checks 4, 5, 8, 9, and 10 are the catalog's *"validation errors, not warnings"* list.
- The `mandatory: true` contract-test flag, for the catalog's eight mandatory pairs.
- The Phase 1 capability choice (`pay.card` + `pay.invoices`), made because that pair
  exercises a real `requires` edge, a publisher/consumer pair, an `enhances` relationship,
  external credentials, slots, and a mandatory contract test.

## Machine-readable form

`docs/catalog.md` is the prose source of truth for humans. The machine-readable form the
engine actually reads is one `*.capability.json` per capability under
[`catalog/`](../catalog/), validated against the capability schema. The two must not
diverge: from Phase 2, `forge catalog` renders the prose view *from* the JSON, and this
document becomes generated rather than maintained.

Part Two capabilities are added to `catalog/` per the build sequence — `pay.card` and
`pay.invoices` in Phase 1, the remainder in Phase 2.
