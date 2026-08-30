# Uber-like Ride Hailing

A ride-hailing marketplace designed at production scale, then built as a
deployable lab-scale model: geo matching under a location-update firehose,
one-offer-one-driver consistency, burst-proof request queueing.

Progress lives in [docs/tasks.md](./docs/tasks.md) (checkboxes are the source
of truth) and [docs/ledger.md](./docs/ledger.md) (work DAG + history).

## Reading order

1. [docs/hld.md](./docs/hld.md) — the design at production scale (interview
   altitude), ending in the Deep Dives that interrogate each decision.
2. [docs/lld.md](./docs/lld.md) — the low-level design of the lab build: what
   actually deploys, contracts, schemas, and the production→lab substitution map.
3. The code — start at the entry points below; every deep dive's
   `In the code:` line points at the files that implement the decision.

## Where to start in the code

Read the four entry-point handlers; each fans out through everything it
touches. Skip `cdk/` and `*.test.ts` on the first pass — they are spec and
proof, not flow.

1. [src/location/handler.ts](./src/location/handler.ts) — driver ping, the
   write firehose. Fans out: [bbox.ts](./src/location/bbox.ts) (validation) →
   [geo-client.ts](./src/location/geo-client.ts) (the seam) →
   [geo-client.fake.ts](./src/location/geo-client.fake.ts) vs
   [redis-geo-client.ts](./src/location/redis-geo-client.ts) (same interface:
   test world vs real world) → [sweeper.ts](./src/location/sweeper.ts) (the
   eviction half of the geo lifecycle).
2. [src/fares/handler.ts](./src/fares/handler.ts) — rider asks for a price.
   Fans out: [routing.ts](./src/fares/routing.ts) (the port + haversine) →
   [pricing.ts](./src/fares/pricing.ts) →
   [store.ts](./src/rides/store.ts) (`createFare`).
3. [src/rides/handler.ts](./src/rides/handler.ts) — rider polls ride state,
   the smallest entry. Fans out to
   [store.ts](./src/rides/store.ts) — **the file that matters most**: the
   conditional-write guards that enforce one-driver-one-ride. Read it fully
   once you land there.
4. [src/auth/authorizer.ts](./src/auth/authorizer.ts) — runs before every
   handler above. Fans out: [token.ts](./src/auth/token.ts) (HMAC mint/verify)
   → [http/api.ts](./src/http/api.ts) (`identityOf` — how handlers receive
   who you are).

Next in line: [src/matching/candidates.ts](./src/matching/candidates.ts) —
not yet wired to a Lambda; the Step Functions matching loop (task 4) calls it.

## Run it

```bash
npm install
npm run check   # the local gate: lint + dependency-direction + typecheck + tests + synth
```

Tasks 1–6 are fully local — no AWS account needed. Deploying (task 7 onward)
requires a bootstrapped account: `cdk deploy --all --outputs-file deploy/outputs.json`.

## Directory map

| Path | What it is |
|---|---|
| `docs/` | The document set: `hld.md`, `lld.md`, `tasks.md`, `ledger.md` |
| `cdk/` | Infrastructure definition — the four stacks (lld.md §6). Runs at synth/deploy time, never in AWS |
| `src/` | Runtime logic: `fares/ rides/ location/ matching/` deploy as Lambdas; `sim/ testdata/ load/ e2e/` are the test harness and never deploy |
| `scripts/` | Repo tooling (dependency-direction lint). Never ships |
| `fixtures/` | Generated test worlds (task 6) |
| `deploy/` | `outputs.json` from deploy — gitignored, carries the lab `SIM_SECRET` |
| root files | Toolchain manifests (npm/tsc/cdk/vitest/eslint resolve them at the package root) |

## Working on this design

- **Local-first:** every build task is done only when its own local tests pass;
  the AWS account gates deployment (task 7), never development.
- **Dependency direction:** runtime code must not import harness dirs —
  `scripts/check-deps.ts` fails the build on violation.
- **Build-depth tiers** (lld.md §1): CORE gets full rigor, SUPPORTING stays
  deliberately thin behind ports, HARNESS is never deployed.
- **Progress protocol:** tick `docs/tasks.md` in the same commit as the work;
  `docs/ledger.md` is append-only — corrections get a new row.
