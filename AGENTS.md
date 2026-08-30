# AGENTS.md — Operating Manual

Instructions for AI agents (and humans) working in this repository. Read this before
creating or modifying any design.

## What this repo is

A collection of system designs, each living in its own top-level directory, each
delivered **twice**: as an interview-grade design document and as deployable AWS
infrastructure + logic. A design is not "done" until both exist and agree with each
other.

## Ground rules

1. This is a public personal repository. Never include employer-internal links,
   service names, team names, metrics, or any confidential material. Generic industry
   knowledge and public AWS documentation only.
2. One directory per system design, kebab-case (`uber-like-rides/`,
   `scalable-notifications/`).
3. Every design directory contains exactly this contract:
   - `README.md` — landing page: what the design is, reading order, and a
     **"Where to start in the code" guide** — the entry-point handlers to read
     first, each with its fan-out chain through the modules it touches
     (fundamentals first, never setup); plus how to run the local gate,
     directory map, design-specific working rules
   - `docs/hld.md` — the design document at interview altitude (structure below)
   - `docs/lld.md` — the low-level design of the lab build: production→lab
     substitution map, **concrete deployment diagrams** (Mermaid; every node is
     a deployable resource — the actual Lambda/table/queue with its file path,
     never an abstract service box; compute and storage in separate boxes,
     operations on edges), component inventory with exact file paths and
     **build-depth tiers** (CORE = full rigor where the guarantees live ·
     SUPPORTING = deliberately thin, stand-ins behind ports · HARNESS =
     simulators/test tooling, never deployed, never imported by runtime), API
     contracts, attribute-level schemas, orchestration state graph, stack
     wiring, config matrix, and a tasks↔LLD↔design traceability table. Written
     after hld.md is agreed, before implementation starts — tasks.md
     executes against it
   - `docs/tasks.md` — implementation plan, updated as work progresses (never stale)
   - `docs/ledger.md` — work DAG + append-only ledger
   - `cdk/` — CDK app (TypeScript) deploying the infra
   - `src/` — runtime logic (Lambda handlers, services, jobs) and, in separate
     subdirectories, the test harness (simulators, test data, load, e2e)
   - `scripts/` — design-local tooling (e.g. the dependency-direction lint);
     never deployed
   Toolchain manifests (`package.json`, `tsconfig.json`, `cdk.json`, test/lint
   configs) live at the design root — the tools resolve them there.
4. Git: agents commit locally and push feature branches (`git push -u origin <branch>`).
   Pushes to `main` are performed by the repo owner. Never force-push.
5. Update the Designs index table in `README.md` when a design is added or changes status.

## hld.md structure

Follow this section skeleton. Cut sections that genuinely don't apply; never pad.

```markdown
# <System Name>

## 1. Overview
2-3 sentences: what we're building and the decision points. State the problem
before the solution.

### 1.1 Problem statement
What's broken or missing, for whom, and why now.

## 2. Requirements
### 2.1 Functional requirements
Numbered, prioritized ([P1]/[P2]/[P3]). Written as capabilities, not implementations.
### 2.2 Non-functional requirements
Scale estimates (users, TPS, storage — show the arithmetic), latency targets,
availability, durability, consistency needs, cost ceiling.
### 2.3 Out of scope
Explicit list. Prevents scope creep and interview rabbit holes.

## 3. Core entities and APIs
The nouns of the system and the interface between client and system.

## 4. High-level design
Mermaid architecture diagram (flowchart LR) + one paragraph per component
describing its single job and how components interact. One box per unit of work,
not per technology brand name.

## 5. Data model
Tables/streams/queues, keys, partitioning strategy, access patterns.

## 6. Detailed design
Per-component detail: flows, failure handling, scaling behavior. Include
sequence diagrams (Mermaid) for the non-obvious flows.

## 7. Alternatives considered
For each major choice: at least 2 real alternatives with honest pros/cons and
why the winner won. No strawmen.

## 8. Failure analysis and operations
What happens when each dependency is down. Metrics that matter, alarms, and
how to roll back.

## 9. Deep Dives  ← the signature section, always last
```

### 9. Deep Dives — format

This section is the reason the repo exists. Each deep dive interrogates one
architectural decision in the format used by strong system design interviews:

```markdown
### Deep Dive: Why SQS between A and B, not a direct call?

**The question behind the question:** what breaks with synchronous coupling here?

**Direct call:** simpler, lower latency, but A's availability now multiplies with
B's; a B outage back-pressures into A; retries amplify load exactly when B is sick.

**Queue:** decouples availability, absorbs bursts (show the arithmetic: peak TPS
vs. steady consumer rate), gives retry + DLQ semantics for free. Costs: eventual
delivery, duplicate handling (consumers must be idempotent), one more thing to operate.

**Decision:** SQS, because requirement NFR-3 (survive 10x burst) dominates the
latency cost that no requirement actually demands.

**In the code:** `cdk/lib/pipeline-stack.ts` (queue + DLQ + alarm),
`src/consumer/handler.ts` (idempotency key check).
```

Rules for deep dives:
- Always name the losing option and what it would have bought us.
- Quantify whenever possible (back-of-envelope math beats adjectives).
- Every deep dive **must** end with `In the code:` pointing at the files where the
  decision is implemented. If it isn't implemented, it isn't a deep dive yet — put
  it in `tasks.md`.
- Good candidate topics: queue vs direct call, SQL vs NoSQL for this access pattern,
  push vs pull, fan-out on write vs read, cache placement and invalidation, exactly-
  once illusions, hot partition mitigation, WebSocket vs SSE vs polling.

## tasks.md structure

Spec-style implementation plan. Checkbox state is the single source of truth for
progress — update it in the same commit as the work.

```markdown
# Implementation Plan — <System Name>

- [ ] 1. Scaffold CDK app and empty stacks
  - cdk init, stack layout, deploy smoke test
  - _Design: §4_
- [-] 2. Core data path
  - [x] 2.1 Ingest endpoint (API GW + Lambda)
  - [ ] 2.2 Queue + consumer with idempotency
  - _Design: §6.1, Deep Dive 9.1_
- [ ] 3. ...
```

Conventions: `[ ]` not started, `[-]` in progress, `[x]` done. Every task links back
to the design section or deep dive it implements (`_Design: §N_`). New scope
discovered mid-build gets a new task, never silent work.

## ledger.md structure

Two parts, both mandatory:

1. **Work DAG** (Mermaid, flowchart LR). Encoding: COLOR = status (green done,
   amber in progress, blue pending); SHAPE = kind (rectangle = artifact/code,
   hexagon = external gate/dependency). Only nodes that are part of a directed
   chain belong in the DAG — floating notes go in the ledger table.
2. **Ledger table** — append-only: `| date | work item | outcome | evidence |`
   where evidence is a commit hash, PR link, or deploy output. Newest row last.
   Never rewrite history; corrections get a new row.

## CDK and code conventions

- One CDK app per design (`cdk/`), TypeScript, pinned dependency versions.
- Stacks small and purpose-named; prefer multiple stacks over one mega-stack when
  lifecycles differ (stateful vs stateless).
- Everything must survive `cdk synth` before commit and `cdk deploy && cdk destroy`
  cleanly — no orphaned resources, no retained buckets/tables unless the design
  document explicitly argues for it.
- Runtime logic in `src/`, unit-testable without AWS (hexagonal-ish: handlers thin,
  logic pure). Tests run with the standard toolchain for the language (`npm test`).
- Postgres via RDS/Aurora Serverless v2 when a design calls for relational; default
  to serverless/pay-per-request tiers everywhere — this account is a lab, not prod.
- Region default: eu-central-1. Tag everything `project: system-design-deep-dives`,
  `design: <system-name>`.

## Workflow for a new design

1. **Discuss** — owner feeds the prompt (e.g. "Uber-like system"); agent asks the
   interview-style clarifying questions before writing anything.
2. **Design** — write `docs/hld.md` §1-§8 at interview altitude, review together,
   then draft the Deep Dives as decisions get locked.
3. **Specify** — write `docs/lld.md`: pin the lab substitutions, contracts, schemas,
   and wiring the build will follow. hld.md stays interview-clean; the LLD
   carries the buildable truth.
4. **Plan** — derive `docs/tasks.md` from the LLD; seed `docs/ledger.md` with the DAG.
5. **Build** — execute tasks on a feature branch; keep tasks.md checkboxes and
   ledger.md current in the same commits; wire each deep dive's `In the code:`
   line as its implementation lands.
6. **Prove** — deploy, exercise, capture evidence in the ledger, destroy.
