# Implementation Plan — Uber-like Ride Hailing

Execution order follows the dependency chain: build (1–5) → test assets (6) → go
live (7) → e2e (8) → load (9) → drills (10) → receipts + teardown (11). The
system is *testable by construction*: every NFR in design §2.2 maps to a numbered
test task below (NFR-1 → 9.2, NFR-2 → 8.3 + 9.2, NFR-3 → 9.2/9.3, NFR-4 → 10.2).

**Local-first rule:** tasks 1–6 are development — each is done only when its own
local tests pass (`npm test` + `cdk synth` + lint), with zero AWS access needed.
The AWS account is a **deploy gate on task 7 only**; it never blocks development.
Redis-touching logic unit-tests against the client seam (LLD §4) with fakes;
integration against real Redis happens from task 7 onward.

Checkbox state is the source of truth; update in the same commit as the work.
`[ ]` not started · `[-]` in progress · `[x]` done.

- [x] 1. Scaffold CDK app and deployment skeleton
  - [x] 1.1 TypeScript CDK app (hand-scaffolded to the repo layout instead of `cdk init`, whose nested template fights the `cdk/` + `src/` contract), pinned deps, `npm test` wired
  - [x] 1.2 Stack layout: `data-stack` (stateful), `location-stack` (Redis + VPC), `api-stack` (gateway + ride/location handlers), `matching-stack` (queue + state machine + matcher lambdas)
  - [x] 1.3 Tags (`project`, `design`), region default eu-central-1, `cdk synth` green
  - [x] 1.4 Dependency-direction lint: runtime code (every `src/` dir except the harness dirs `src/{sim,testdata,load,e2e}`) must not import from harness dirs — build fails on violation
  - _Design: §4_

- [x] 2. Data stores — system of record
  - [x] 2.1 `fares` table (TTL on `expiresAt`), `rides` table + `driverId-status` GSI + `riderId-createdAt` GSI, `driver-offers` table (TTL)
  - [x] 2.2 `src/rides/store.ts`: typed helpers incl. conditional-write guards (`MATCHING→OFFERED`, `OFFERED→ACCEPTED` with owner condition)
  - [x] 2.3 Unit tests for the state-machine guards (pure logic, no AWS)
  - _Design: §5, Deep Dive 9.5_

- [x] 3. Location path — the write firehose
  - [x] 3.1 Minimal VPC + single-node ElastiCache (lab-scale stand-in for the sharded cluster; same GEO API)
  - [x] 3.2 `POST /drivers/location` → `src/location/handler.ts`: validate, `GEOADD` + `ZADD` ts
  - [x] 3.3 `src/location/sweeper.ts` on a 1-min schedule: evict members stale >30 s from both keys
  - [x] 3.4 `src/matching/candidates.ts`: `GEOSEARCH` radius 5 km ASC limit 10, active-ride filter
  - [x] 3.5 Unit tests (local, fake geo/lock client): bbox validation rejects out-of-city pings, sweeper selects exactly the >30 s-stale members, candidate ranking honors exclusions and the active-ride filter
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
  - [ ] 5.3 Unit tests: haversine against known city-pair distances, pricing monotonicity (longer ride never cheaper), fare expiry boundary
  - _Design: §6.1_

- [ ] 6. Test data generation — reproducible worlds to test against
  - [ ] 6.1 `src/testdata/city.ts`: synthetic city model on a real bounding box (Berlin), road-grid snap, seeded RNG — same seed ⇒ same world, so every test run is comparable
  - [ ] 6.2 `src/testdata/fleet.ts`: driver fleet generator with placement distributions (uniform | downtown-weighted | airport-cluster) and behavior profiles (accept probability, think time, shift length)
  - [ ] 6.3 `src/testdata/demand.ts`: rider demand generator — steady Poisson arrivals, rush-hour ramp, and hotspot burst (N requests, one neighborhood, M minutes) matching the design's 100k-same-metro scenario shape
  - [ ] 6.4 Fixture CLI: `npm run gen -- --seed 42 --drivers 200 --profile rush` writes versioned JSON fixtures under `fixtures/`; unit-test the generators' invariants (bounds, distributions, determinism)
  - _Design: §2.2 scale assumptions, Deep Dive 9.6_

- [ ] 7. Go live — deploy and prove the system breathes
  - [ ] 7.1 `cdk bootstrap` (once) + `cdk deploy --all` to the lab account; stack outputs (API URL, table/queue names) written to `deploy/outputs.json` — the single config source for every test task below
  - [ ] 7.2 Smoke suite `npm run smoke`: one driver ping lands in GEO index, one fare priced, one ride matched end-to-end to ACCEPTED, sweeper evicts a silent driver — each check <60 s, exits non-zero on any failure
  - [ ] 7.3 Observability live: CloudWatch dashboard (match latency, queue depth/age, lock contention, stale-driver ratio) + the two paging alarms from design §8
  - [ ] 7.4 Record deploy evidence (stack ARNs, smoke output) in ledger — LIVE gate passed, testing phases unlocked
  - _Design: §4, §8_

- [ ] 8. E2E test suite — automated, repeatable, against the live system
  - [ ] 8.1 Harness: vitest e2e project reading `deploy/outputs.json`; each spec seeds its own fixture world (task 6), tags resources with a run id, cleans up after itself
  - [ ] 8.2 Scenario specs: happy path · decline→next driver · 10 s timeout→next driver · all-decline→FAILED · no drivers in radius→FAILED within 1-min budget · rider cancel during MATCHING · stale accept after reassignment→409 · expired fare rejected
  - [ ] 8.3 Consistency invariant auditor `src/e2e/invariants.ts`: after any scenario, assert from the record — no driver ever held 2 overlapping offers/rides (offer log + lock audit), no ride ever had 2 drivers, every ride reached a terminal state. Runs as the last step of every e2e spec, not a separate opt-in
  - [ ] 8.4 `npm run e2e` green end-to-end in one command; flake policy: zero retries tolerated for invariant assertions
  - _Design: §2.2 NFR-2, §6.2, §6.4, Deep Dive 9.2_

- [ ] 9. Load tests — find the numbers, not just survive
  - [ ] 9.1 Load driver `src/load/runner.ts`: worker-pool client (configurable TPS ramp, duration, fixture), emits per-request latency records; results summarized to p50/p95/p99 + error rate
  - [ ] 9.2 Location firehose test: ramp 200→1,000 sustained pings/s (lab-scale stand-in for the design's 20k/s city figure) for 10 min — measure GEOADD p99, Redis CPU/memory, GEOSEARCH p99 under concurrent write load, sweeper correctness at load
  - [ ] 9.3 Matching burst test: hotspot fixture, 200 concurrent ride requests against 20 drivers — measure match p50/p99 vs the <60 s budget (NFR-1), queue depth/age curve, zero dropped requests (NFR-3), then run the 8.3 invariant auditor over the full run (NFR-2 under contention, not just in unit tests)
  - [ ] 9.4 Soak: 30 min steady mixed load (pings + Poisson ride arrivals) — no latency drift, no queue growth, no Redis memory creep, DLQ empty
  - [ ] 9.5 Capture: metric snapshots + latency histograms + found limits (where does the single Redis node saturate?) → ledger evidence; feed real numbers back into design §2.2 if assumptions were off
  - _Design: §2.2 NFR-1/2/3, §8 metrics_

- [ ] 10. Failure drills — prove §8 claims, don't just state them
  - [ ] 10.1 Kill matcher mid-offer (inject fault between lock and offer write): driver lock self-expires ≤10 s, ride still reaches a terminal state, invariants hold
  - [ ] 10.2 Redis restart under load: matching fails closed (no drops — requests wait in queue), geo index self-rebuilds within one ping interval after recovery, match latency recovers — timestamped evidence for the design's headline durability trade (Deep Dive 9.1)
  - [ ] 10.3 Poison message → DLQ path: malformed ride request lands in DLQ with alarm, healthy traffic unaffected
  - _Design: §8, Deep Dives 9.1, 9.2_

- [ ] 11. Receipts + teardown
  - [ ] 11.1 Flip every design §9 "In the code (planned)" to concrete file links as they land
  - [ ] 11.2 `cdk destroy` leaves the account clean (verify: no orphaned VPC/ENI/tables/log groups); README index status → Built + load-tested
  - _Design: §9, AGENTS.md ground rules_
