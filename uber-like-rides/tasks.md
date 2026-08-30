# Implementation Plan — Uber-like Ride Hailing

Execution order follows the dependency chain: data → location path → matching
path → notification → simulation → evidence. Checkbox state is the source of
truth; update in the same commit as the work. `[ ]` not started · `[-]` in
progress · `[x]` done.

- [ ] 1. Scaffold CDK app and deployment skeleton
  - [ ] 1.1 `cdk init` TypeScript app under `cdk/`, pinned deps, `npm test` wired
  - [ ] 1.2 Stack layout: `data-stack` (stateful), `location-stack` (Redis + VPC), `api-stack` (gateway + ride/location handlers), `matching-stack` (queue + state machine + matcher lambdas)
  - [ ] 1.3 Tags (`project`, `design`), region default eu-central-1, `cdk synth` green in CI-less local
  - _Design: §4_

- [ ] 2. Data stores — system of record
  - [ ] 2.1 `fares` table (TTL on `expiresAt`), `rides` table + `driverId-status` GSI + `riderId-createdAt` GSI, `driver-offers` table (TTL)
  - [ ] 2.2 `src/rides/store.ts`: typed helpers incl. conditional-write guards (`MATCHING→OFFERED`, `OFFERED→ACCEPTED` with owner condition)
  - [ ] 2.3 Unit tests for the state-machine guards (pure logic, no AWS)
  - _Design: §5, Deep Dive 9.5_

- [ ] 3. Location path — the write firehose
  - [ ] 3.1 Minimal VPC + single-node ElastiCache (lab-scale stand-in for the sharded cluster; same GEO API)
  - [ ] 3.2 `POST /drivers/location` → `src/location/handler.ts`: validate, `GEOADD` + `ZADD` ts
  - [ ] 3.3 `src/location/sweeper.ts` on a 1-min schedule: evict members stale >30 s from both keys
  - [ ] 3.4 `src/matching/candidates.ts`: `GEOSEARCH` radius 5 km ASC limit 10, active-ride filter
  - _Design: §6.3, Deep Dives 9.1, 9.6_

- [ ] 4. Matching path — queue, orchestrator, locks
  - [ ] 4.1 Match queue + DLQ + oldest-message-age alarm; `POST /rides` persists then enqueues
  - [ ] 4.2 Step Functions state machine: candidates → Map(offer → wait accept-token/10 s → branch) → exhausted/budget → `FAILED`
  - [ ] 4.3 `src/matching/driver-lock.ts`: `SET NX PX 10000` acquire, owner-checked release
  - [ ] 4.4 Offer write + notification enqueue; accept handler `PATCH /rides/{id}` completes the task token
  - [ ] 4.5 Unit tests: lock contention (both-matchers-race), stale accept 409, idempotent re-offer
  - _Design: §6.2, §6.4, Deep Dives 9.2, 9.3, 9.4_

- [ ] 5. Fare service
  - [ ] 5.1 Routing provider port (`src/fares/routing.ts`) with haversine + city-speed lab implementation
  - [ ] 5.2 `POST /fares`: price = f(distance, duration), 5-min expiry; `GET /rides/{id}` for state polling
  - _Design: §6.1_

- [ ] 6. Simulation clients — prove the loop end to end
  - [ ] 6.1 `src/sim/driver-sim.ts`: N drivers moving on a city grid, adaptive ping cadence (stationary 30 s / cruise 10 s / hot 2–5 s), poll offers, accept/decline with configurable probability + think time
  - [ ] 6.2 `src/sim/rider-sim.ts`: fare → request → poll to terminal state; burst mode (M requests, one neighborhood)
  - _Design: §2.2, Deep Dive 9.6_

- [ ] 7. Evidence run — verify the NFRs, capture in ledger
  - [ ] 7.1 Happy path: 50 drivers / 20 rides → all `ACCEPTED`, match p99 < 60 s
  - [ ] 7.2 Consistency: burst 100 concurrent requests, 10 drivers → zero double-dispatch (assert: no driver holds 2 offers/rides at any point; ride never has 2 drivers)
  - [ ] 7.3 Failure drill: kill matcher mid-offer → lock self-expires ≤10 s, ride still reaches terminal state
  - [ ] 7.4 Record all evidence (metrics, execution histories, assertions) in `ledger.md`
  - _Design: §2.2 NFR-1/2/3, §8_

- [ ] 8. Wire deep-dive receipts + teardown
  - [ ] 8.1 Flip every §9 "In the code (planned)" to concrete file links as they land
  - [ ] 8.2 `cdk destroy` leaves the account clean (verify: no orphaned VPC/ENI/tables); README index status → Built
  - _Design: §9, AGENTS.md ground rules_
