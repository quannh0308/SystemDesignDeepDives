# Ledger — flash-sale-inventory

## Work DAG

```mermaid
flowchart LR
    HLD[docs/hld.md<br/>§1-§8 authored]:::done --> DIVES[§9 deep dives<br/>+ §10 final design]:::pending
    DIVES --> REVIEW{{owner grill<br/>+ sign-off}}:::pending
    REVIEW --> LLD[docs/lld.md<br/>substitution map, tiers,<br/>schemas, wiring]:::pending
    LLD --> PLAN[docs/tasks.md<br/>derived from LLD]:::pending
    PLAN --> BUILD[build tasks<br/>thin slice first:<br/>admission→queue→order→audit]:::pending
    AWS{{AWS account<br/>bootstrapped -- deploy gate}}:::pending --> PROVE[proof gate:<br/>10K-attempt stampede +<br/>Redis-kill drill, audit holds]:::pending
    BUILD --> PROVE

    classDef done fill:#c8e6c9,stroke:#2e7d32
    classDef pending fill:#bbdefb,stroke:#1565c0
```

Encoding: green = done, blue = pending; rectangles = artifacts, hexagons =
external gates. The AWS gate binds at deployment only — development never
blocks on it (repo rule). The proof gate is design-specific and
non-negotiable: a load harness fires ≥10K concurrent buy attempts at stock
100, a ledger audit asserts `SUM(confirmed) ≤ initial stock`; then the same
run repeats with a mid-sale Redis kill + conservative rebuild and the audit
must still hold — under-sell allowed, oversell never.

## Ledger

| Date | Work item | Outcome | Evidence |
|---|---|---|---|
| 2026-09-21 | Scope locked with owner: single hot SKU centered (per-sale keys generalize; multi-SKU placement out of scope), payment window 10 min via delay message, bounded unfairness (lottery documented as the pivot), one-per-customer on, payment processing external (consume PAID/FAILED signals; payment-system design owns that territory) | defaults ratified, design brief pinned | chat checkpoint 1a |
| 2026-09-21 | HLD §1–§8 authored: funnel admission (token bucket → local JWT → one Lua script: claim + pre-decrement, stock-check-before-claim so sold-out never burns the claim), invariant enforced twice (Redis Lua for throughput, DB conditional write for truth), reservation state machine RESERVED→CONFIRMED\|RELEASED with CAS-guarded deadline race and an alarmed refund lane for PAID-after-RELEASED, (saleId, buyerId) as the natural idempotency key end to end, fail-closed admission with conservative rebuild, staged admission dial as both rollout and load-shed control. Deep-dive numbering 9.1–9.11 pre-wired from §1–§8 | docs/hld.md at review altitude | e4f77ca |
