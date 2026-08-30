# Ledger — Uber-like Ride Hailing

## Work DAG

Color = status (green done · amber in progress · blue pending). Shape = kind
(rectangle = artifact/code · hexagon = external gate).

```mermaid
flowchart LR
    DESIGN[design.md<br/>§1–§9 authored]
    PLAN[tasks.md<br/>plan derived]
    T1[T1 CDK<br/>scaffold]
    T2[T2 Data<br/>stores]
    T3[T3 Location<br/>path]
    T4[T4 Matching<br/>path]
    T5[T5 Fare<br/>service]
    T6[T6 Simulation<br/>clients]
    T7[T7 Evidence<br/>run]
    T8[T8 Receipts +<br/>teardown]
    AWS{{AWS account<br/>bootstrapped for CDK}}

    DESIGN --> PLAN --> T1
    AWS --> T1
    T1 --> T2
    T2 --> T3
    T2 --> T5
    T3 --> T4
    T4 --> T6
    T5 --> T6
    T6 --> T7 --> T8

    classDef done fill:#2e7d32,color:#fff,stroke:#1b5e20
    classDef active fill:#ff8f00,color:#fff,stroke:#e65100
    classDef pending fill:#1565c0,color:#fff,stroke:#0d47a1
    class DESIGN,PLAN done
    class T1,T2,T3,T4,T5,T6,T7,T8,AWS pending
```

## Ledger

Append-only. Corrections get a new row, never a rewrite.

| Date | Work item | Outcome | Evidence |
|---|---|---|---|
| 2026-08-30 | Design authored (§1–§9, 6 deep dives) from the ride-hailing problem brief | design.md v1 committed | this commit |
| 2026-08-30 | Implementation plan derived from design | tasks.md v1, 8 task groups, all traced to design sections | this commit |
| 2026-08-30 | Ledger seeded with work DAG | ledger.md v1 | this commit |

## Open items (not DAG nodes)

- AWS account for the lab deploy: confirm account + `cdk bootstrap` before T1.
- Lab Redis sizing: single `cache.t4g.micro` node assumed (~$0.4/day while up); revisit only if the burst test saturates it.
