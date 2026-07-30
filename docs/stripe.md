# Stripe setup

Everything needed to take a real test-mode card payment in a Forge-generated
product, and to verify the guarantees `pay.card` claims.

Nothing here is Stripe-specific configuration you invent. `pay.card`'s
specification (`catalog/pay/pay.card.capability.json`) already declares exactly
which credentials exist, what each is for, and which routes and events they
drive. This document is that declaration, made runnable.

---

## Before you start: one thing that is not built yet

The manifest binds credentials by **name**, never by value:

```yaml
integrations:
  stripe:
    credentials:
      STRIPE_SECRET_KEY:     { secret_ref: acme/stripe_secret_key }
      STRIPE_WEBHOOK_SECRET: { secret_ref: acme/stripe_webhook_secret }
```

`forge validate` checks that every credential a capability requires is **bound**
to some `secret_ref`. It does not read values, which is deliberate — §9.4.

**But nothing resolves a `secret_ref` to a value yet.** The secrets provider is
an interface with no implementation (`internal/provider/` contains `codegen`
only). Until it exists, the manifest binding is documentation and the actual
values come from the environment, as described below. That gap is Phase 1's last
piece of secret handling and is what §9.4 means by "Phase 1 ships a `file`
secrets provider".

Practically: keep the `secret_ref` bindings — validation requires them and they
are the record of what this product needs — and set the values in `.env.local`.

---

## 1. Get test-mode keys

1. Create a Stripe account at <https://dashboard.stripe.com/register>. No
   business details are needed for test mode.
2. Confirm the dashboard says **Test mode** (toggle, top right). Test keys begin
   `sk_test_`; a key beginning `sk_live_` moves real money.
3. **Developers → API keys** → reveal the **Secret key**. That is
   `STRIPE_SECRET_KEY`.

Do not use the Publishable key here. `pay.card` never sends the secret key to a
browser; the publishable key is only needed if you mount Stripe Elements in
`PaymentForm`, which is client-side and separate.

---

## 2. Get a webhook signing secret

`pay.card` exposes a webhook receiver at `/api/webhooks/stripe` and **verifies
the signature before parsing the payload** — an unsigned or mis-signed request
is rejected with 400 without being read. That verification needs a signing
secret, which differs depending on how events reach you.

### Local development — Stripe CLI (recommended)

```bash
# https://docs.stripe.com/stripe-cli#install
stripe login
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

`stripe listen` prints a secret beginning `whsec_`. **That is your
`STRIPE_WEBHOOK_SECRET` for local development** — it is specific to the CLI
session, not the one shown in the dashboard. It changes each time unless you
pass `--load-from-webhooks-api`.

Leave that command running. It forwards live test-mode events to your machine.

### Deployed environments — dashboard endpoint

**Developers → Webhooks → Add endpoint**, URL
`https://<your-domain>/api/webhooks/stripe`. Subscribe to at least:

| Event | Why `pay.card` needs it |
|---|---|
| `payment_intent.succeeded` | publishes `payment.succeeded`, which `pay.invoices` consumes to mark an invoice paid |
| `payment_intent.payment_failed` | publishes `payment.failed` |
| `charge.refunded` | publishes `payment.refunded`, which raises a credit note |
| `payment_method.attached` | publishes `payment.method.added` |

Reveal the endpoint's **Signing secret** — that is `STRIPE_WEBHOOK_SECRET` for
that environment. Each endpoint has its own; they are not interchangeable.

---

## 3. Set the environment

The generated app validates its environment at boot from
`src/generated/env.ts`, which is derived from the resolved capability graph — so
the required set depends on which capabilities the manifest selects. For the
reference product (`pay.card` + `pay.invoices` and their closure):

```bash
cd apps/reference
cp .env.example .env.local
```

Required:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `postgresql://forge@localhost:5433/forge_reference` |
| `QUEUE_URL` | the same Postgres URL — `ops.queue`'s default driver is `postgres`, so no second service |
| `STRIPE_SECRET_KEY` | `sk_test_…` from step 1 |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` from step 2 |
| `STORAGE_BUCKET` | any local directory, e.g. `.storage` — `data.files`' `local` driver |
| `STORAGE_CREDENTIALS` | `local` (unused by the local driver, but the schema requires a value) |
| `MAIL_DSN` | `console://` — prints messages instead of sending them |

Optional, commented out in `.env.example`: `MAIL_FROM_ADDRESS`,
`SCANNER_ENDPOINT`, `ERROR_TRACKING_DSN`, `METRICS_ENDPOINT`. Their capabilities
declare them optional and run without them.

**`SCANNER_ENDPOINT` deserves a note.** With no scanner configured, `data.files`
holds every upload in `quarantined` and never publishes `file.uploaded` — which
is correct behaviour, not a bug: an unscanned file is never accessible. For
local work set `scan_policy: skip` in the manifest, which validation permits
**only** for the `local` provider.

---

## 4. Run it

```bash
# from the repository root, once
pnpm install

cd apps/reference
pnpm migrate     # 14 migrations, dependency-ordered; safe to re-run
pnpm dev         # http://localhost:3000
```

In a second terminal, if you are using the CLI:

```bash
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

A third terminal for background work, if you are exercising anything
asynchronous (document rendering, file scanning, dunning):

```bash
cd apps/reference && pnpm worker
```

---

## 5. Verify a real charge

Stripe's test cards: <https://docs.stripe.com/testing>

| Card | Behaviour |
|---|---|
| `4242 4242 4242 4242` | succeeds |
| `4000 0000 0000 0002` | declined — exercises `payment.failed` |
| `4000 0025 0000 3155` | requires 3D Secure authentication |

Any future expiry, any CVC, any postcode.

Trigger an event without a UI:

```bash
stripe trigger payment_intent.succeeded
```

What should happen, and what each step proves:

1. The webhook arrives at `/api/webhooks/stripe`. The signature is verified
   **before** `JSON.parse` — there are tests that spy on `JSON.parse` and assert
   it is never called for an unsigned, mis-signed, wrong-secret, or stale
   payload.
2. `pay.card` records a `Charge` (append-only) and publishes `payment.succeeded`
   exactly once. Stripe retries webhooks, so redelivery is collapsed by
   `ON CONFLICT (provider, external_id) DO NOTHING`.
3. `pay.invoices` consumes it and marks the matching invoice paid — once. That
   is guarded by `UNIQUE (invoice_id, charge_id)` on the receipt, applied inside
   the same transaction as the balance change, so a redelivered event cannot
   double-apply.

Check the results:

```bash
psql -p 5433 -h /tmp -U forge -d forge_reference \
  -c "select id, amount_minor, currency, status from charge order by id desc limit 5;"
psql -p 5433 -h /tmp -U forge -d forge_reference \
  -c "select name, contract_version, occurred_at from events order by occurred_at desc limit 5;"
```

---

## 6. Run the tests that need credentials

Most of `pay.card`'s suite needs no Stripe account — it runs against a fake
whose `constructEvent` reproduces Stripe's real HMAC-then-parse ordering, which
is what makes the "rejected before parsing" assertion non-circular.

```bash
pnpm --filter @forge/pay-card test        # 49 tests, no credentials needed
```

One smoke test is declared `requires_credentials: true` — *test-mode charge
succeeds*. To run the full set against real Stripe:

```bash
STRIPE_SECRET_KEY=sk_test_… pnpm --filter @forge/pay-card test
```

---

## 7. What `pay.card` guarantees, and how to check each

These are declared in the specification and enforced in code — worth verifying
yourself rather than taking on trust.

**Card data is never stored.** No column in any owned table can hold a PAN;
`last4` carries a database `CHECK` bounding it to four digits; a Luhn-based
guard rejects anything PAN-shaped on the write path; and `PaymentForm` renders
no `<input>` at all — Stripe Elements mounts into a placeholder.

```bash
psql -p 5433 -h /tmp -U forge -d forge_reference -c "\d payment_method"
```

**Secrets never leave the process.** They are held in a module-private closure,
never exported, never persisted, never placed in an event payload. Tests scan
exports, published events, persisted rows, all console output, and every SQL
statement.

```bash
psql -p 5433 -h /tmp -U forge -d forge_reference \
  -c "select payload from events where payload::text ilike '%sk_test%';"   # expect 0 rows
```

**Money is integer minor units.** `£12.34` is `1234`. A float anywhere in a
money path is a defect; `Money.of` rejects a non-integer amount before Stripe is
called.

**Charges and refunds are append-only.** Corrections are refunds and credit
notes, never edits — enforced at the repository layer.

**Anything that moves money requires approval.** `charge` and `refund` carry
frozen `.agent` metadata classifying them `moves_money`, and the annotation
helper *forces* `approval: 'always'` for that consequence and throws if a caller
tries to declare otherwise. When `ai.agents` is added, that rule is mechanical
rather than documentary.

---

## 8. Customising behaviour

Do not edit the generated `src/generated/pay.card/config.ts` — `forge drift`
will report it and an upgrade will conflict. Two sanctioned routes:

**Manifest configuration**, for anything the specification anticipates:

```yaml
capabilities:
  - id: pay.card
    config:
      statement_descriptor: ACME RESTORATION   # max 22 chars, appears on the customer's statement
      capture_method: manual                   # authorise now, capture later
      allowed_currencies: [USD, GBP]
```

**Slots**, for client-specific logic. Three are seeded into
`src/slots/pay.card/`; each is yours the moment it is written and Forge never
touches it again:

| Slot | Runs | Typical use |
|---|---|---|
| `beforeCharge` | before submission to Stripe | fraud screening, spend limits — returning a rejection prevents the charge |
| `afterCharge` | after success, before `payment.succeeded` | bookkeeping, external notification |
| `receiptCustomization` | when a receipt is rendered | content beyond branding tokens |

```ts
// src/slots/pay.card/beforeCharge.ts
export const beforeCharge: BeforeChargeSlot = async (ctx) => {
  if (ctx.amount.amountMinor > 500_000 && ctx.customer.isNew) {
    return ctx.reject('manual review required above £5,000 for new customers')
  }
  return ctx.proceed()
}
```

`ctx.proceed()` means "carry on as you would have" — every slot in the catalog
has it, which is what lets the seeded stub compile and behave correctly before
anyone writes anything.

---

## 9. Going to production

- **Use a live key only when you mean it.** `sk_live_` moves real money. Keys are
  per-environment: the manifest's `environments` block gives each its own
  `secret_ref` prefix so staging and production cannot share one.
- **Each deployed environment needs its own webhook endpoint** and therefore its
  own signing secret. A staging secret will not verify production events.
- **Stripe retries failed webhooks** for up to three days. The receiver is
  idempotent by design, so retries are safe — but a webhook endpoint returning
  500 for a real bug will accumulate a backlog that all arrives at once when
  fixed.
- **`allowed_currencies` is enforced**, so a charge in a currency the manifest
  does not list is rejected before reaching Stripe.
- When the GCP provider lands (Phase 4), `STRIPE_SECRET_KEY` resolves from Secret
  Manager via the `secret_ref` in the manifest, and nothing changes in the
  generated code — it already reads from the validated environment schema.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `pay.card: STRIPE_SECRET_KEY is not set` | The key is validated at first use of the Stripe client, not at import — so this appears on the first charge, not at boot. Check `.env.local`. |
| Webhook returns 400 with no detail | The signature did not verify, and the body is deliberately uninformative so it cannot be probed. Usually the CLI's `whsec_` differs from the dashboard's. |
| Webhook returns 200 but nothing happens | The event type is not one `pay.card` subscribes to. See the table in step 2. |
| `next build` fails on a missing variable | It should not — the env schema skips validation during the build phase, since building is not running. If it does, that is a bug worth reporting. |
| Uploads stay `quarantined` | No `SCANNER_ENDPOINT`. Correct behaviour: an unscanned file is never accessible. Set `scan_policy: skip` locally. |
