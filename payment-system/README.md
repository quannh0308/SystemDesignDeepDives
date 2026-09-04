# payment-system

A Stripe-style payment processor on a Revolut-style double-entry ledger:
merchants charge cards through one idempotent API; money movements land in an
append-only ledger that balances by construction; a nightly reconciler proves
our books against the card network's.

**Status: 📐 Designing** — HLD authored, under review. LLD, task plan, and code
follow the [repo workflow](../AGENTS.md).

## Reading order

1. [`docs/hld.md`](./docs/hld.md) — the design at interview altitude. §9 Deep
   Dives is the signature section: eight interviewer-question dives
   (idempotency, the ambiguous-timeout problem, double-entry ledger vs balance
   column, crash-proof sagas, webhook delivery, reconciliation, hot-partition
   sharding, tokenization).
2. `docs/lld.md` — the buildable truth (production→lab substitution map,
   deployment diagrams, schemas). *Arrives next.*
3. `docs/tasks.md` + `docs/ledger.md` — plan and progress. *Arrive with the LLD.*

## Where to start in the code

Code arrives at build phase. This section will list the entry-point handlers
(charge API, processor saga steps, webhook deliverer, reconciler) with their
fan-out chains, per the repo contract — fundamentals first, never setup.

## The lab shape (preview)

Same discipline as [uber-like-rides](../uber-like-rides/): CORE modules carry
the guarantees (idempotency gate, atomic finalize, ledger, reconciler
classifier), SUPPORTING stand-ins live behind ports (`CardNetworkPort` — the
flaky external network is a simulator with injectable declines, timeouts, and
settlement-file drift), HARNESS never deploys. Everything scales to zero; this
design needs no Redis — cheaper to keep live than uber.
