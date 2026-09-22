# flash-sale-inventory

Zero-oversell inventory subtraction for a flash sale: one hot SKU, stock
1,000, ~100K buyers inside one second. The design is a funnel, not a faster
database — ≥99% rejected as cheaply as possible, one invariant (stock never
below zero) enforced at two layers: a Redis Lua admission script for speed,
a DB conditional write for truth.

**Status: 📐 Designing** — HLD complete (§1–§10), under owner grill. LLD,
task plan, and code follow the [repo workflow](../AGENTS.md).

## Reading order

1. [`docs/hld.md`](./docs/hld.md) — the design at interview altitude. §9
   Deep Dives is the signature section: eleven interviewer-question dives
   (the decrement point, invariant-enforced-twice, the distributed-lock
   rejection, the admission multiplier and its waiting lane,
   Redis-says-yes-DB-says-no, the deadline race, crash recovery, hot-row
   relief, sold-out staleness, fairness, and what actually runs in the
   gateway Lua). §10 closes with the final whiteboard and "One buy attempt,
   start to finish" — eleven narrated steps including the mid-sale Redis
   failover.
2. `docs/lld.md` — the buildable truth (production→lab substitution map:
   what stands in for Redis, the MQ, and the relational DB, argued per the
   repo's CORE/SUPPORTING/HARNESS tiers). *Arrives after the dives.*
3. [`docs/ledger.md`](./docs/ledger.md) — work DAG + append-only progress
   ledger, live now. `docs/tasks.md` arrives with the LLD.

## Where to start in the code

Code arrives at build phase. This section will list the entry-point handlers
with their fan-out chains, per the repo contract — planned entry points: the
admission handler (gateway checks + the Lua script), the order-queue consumer
(the one transaction that writes the truth), the release and payment workers
(CAS state transitions racing by design), and the ledger audit.

## The lab shape (preview)

Same discipline as [uber-like-rides](../uber-like-rides/): CORE carries the
guarantees — here the invariant lives in CORE *twice* (admission script,
conditional decrement), plus the reservation state machine and the audit.
SUPPORTING stand-ins live behind ports (the payment provider is a simulator
emitting `PAID`/`FAILED` with injectable lag — including the nasty
paid-after-deadline ordering). HARNESS never deploys, and in this design it
is a first-class citizen: a stampede load harness (≥10K concurrent attempts
against stock 100) and a mid-sale Redis-kill drill with conservative rebuild
— the proof gate is the audit holding `SUM(confirmed) ≤ initial stock`
through both runs, under-sell allowed, oversell never.
