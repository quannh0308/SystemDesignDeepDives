# SystemDesignDeepDives

System designs that don't stop at the whiteboard.

Every design in this repo exists twice:

1. **As a design document** — interview-ready, with requirements, scale estimates, architecture, alternatives, and a closing set of deep dives ("Why SQS here, not a direct call?") in the format great system design interviews follow.
2. **As deployed code** — a CDK app plus real logic (Lambda, SQS, SNS, Postgres, DynamoDB, ...) that implements the design, so every deep-dive decision is backed by something you can `cdk deploy` and poke at.

The thesis: AWS building blocks can answer most system design questions — if you actually build the answer.

## Repository layout

```
SystemDesignDeepDives/
├── README.md            ← you are here
├── AGENTS.md            ← operating manual: file contracts, templates, conventions
└── <system-name>/       ← one directory per system design (kebab-case)
    ├── design.md        ← the design doc, ending in interview-style deep dives
    ├── lld.md           ← low-level design of the lab build (the buildable truth)
    ├── tasks.md         ← implementation plan, kept current with progress
    ├── ledger.md        ← work DAG + append-only ledger of done/to-do
    ├── cdk/             ← CDK app deploying the infra
    └── src/             ← the logic (handlers, services, jobs)
```

Each design directory is self-contained: read `design.md` top to bottom to prep the design, read the Deep Dives section to prep the follow-up questions, then read the code to see the decisions made real.

## Designs

| System | Status | One-liner |
|---|---|---|
| [uber-like-rides](./uber-like-rides/design.md) | 📐 Designed | Ride-hailing marketplace: geo matching under a 2M-writes/s location firehose, one-offer-one-driver consistency, burst-proof request queueing |

## Conventions

- Diagrams are Mermaid (GitHub renders them natively), flowcharts left-to-right.
- Infra is AWS CDK (TypeScript). Runtime logic defaults to TypeScript unless a design argues otherwise.
- Everything is built to be torn down: `cdk destroy` must always leave the account clean.

See `AGENTS.md` for the full working agreement.
