# Uber-like Ride Hailing

_This document is the design at production scale (interview altitude). The
buildable specification of the lab system — contracts, schemas, wiring — lives
in [lld.md](./lld.md)._

## 1. Overview

A ride-hailing marketplace: riders get a fare estimate, request a ride, and are
matched with a nearby available driver who can accept or decline. The interesting
problems are all in the matching path — a firehose of driver location updates,
proximity search under latency pressure, and a consistency guarantee (one offer,
one driver, one ride) that must hold while everything is retrying.

### 1.1 Problem statement

Connect physical supply (drivers moving through space) with bursty demand (riders,
concentrated by events and rush hours) in under a minute, without ever
double-booking a driver, and without melting the datastore that tracks where
everyone is. A naive CRUD design fails on all three counts: location writes
overwhelm any disk-backed table, proximity queries over lat/long columns are table
scans, and "just update the ride row" racing across service instances sends one
driver two rides.

## 2. Requirements

### 2.1 Functional requirements

1. **[P1] Fare estimate** — rider inputs pickup + destination, gets estimated fare and ETA before committing.
2. **[P1] Request ride** — rider requests a ride against a previously issued fare estimate.
3. **[P1] Matching** — the system matches the request with a nearby, available driver; drivers receive one offer at a time.
4. **[P1] Accept / decline** — driver accepts or declines an offer; on accept, driver gets pickup coordinates; on decline or timeout, the next candidate driver is offered.
5. **[P2] Ride lifecycle** — pickup, in-progress, completion state transitions recorded.
6. **[P3] Live driver position on rider's map during pickup.**

### 2.2 Non-functional requirements

Scale assumptions (worked, order-of-magnitude):

- 10M drivers online globally at peak, location ping every ~5 s → **~2M location updates/s**. This single number dominates the design.
- 20M rides/day ≈ 230 rides/s average; event spikes concentrate demand: assume **100k ride requests from one metro within minutes**.
- Ride + fare records ~1 KB each → 20M × 2 × 1 KB ≈ **40 GB/day** of durable transactional data. Trivial for any store; the write *rate* on locations is the problem, not volume.

1. **Matching latency** — offer reaches a driver in seconds; match-or-fail within 1 minute of the request.
2. **Matching consistency** — a driver never holds two simultaneous offers or rides; a ride never dispatches to two drivers. This is the one place we pay for strong consistency.
3. **Burst absorption** — 100k near-simultaneous requests from one geo area must degrade to slower matching, never to dropped requests.
4. **Location freshness over durability** — driver positions may be lost on failure (they self-heal within one ping interval); ride state may never be lost.

### 2.3 Out of scope

Ratings, ride categories (XL/Comfort), scheduled rides, payments processing,
surge-pricing model internals (the fare service treats pricing as a pluggable
function), driver onboarding, fraud.

## 3. Core entities and APIs

Entities: **Rider**, **Driver** (profile + availability status), **Fare**
(pickup, destination, quoted price, ETA, expiry), **Ride** (rider, fare,
assigned driver, state machine below), **DriverLocation** (ephemeral: id →
lat/lng, updated continuously, never the system of record for anything durable).

```
POST  /fares                 {pickup, destination}        -> Fare        (rider)
POST  /rides                 {fareId}                     -> Ride        (rider)
POST  /drivers/location      {lat, lng}                   -> 200         (driver, identity from auth token)
PATCH /rides/{rideId}        {action: accept|decline}     -> Ride        (driver)
GET   /rides/{rideId}                                     -> Ride        (rider/driver polling state)
```

Identity always comes from the auth token, never the body — a client that can
write `driverId` into a payload can impersonate any driver. Fares are
server-priced and referenced by id at request time so the quoted price can't be
tampered with client-side.

Ride state machine:

```mermaid
stateDiagram-v2
    direction LR
    [*] --> REQUESTED
    REQUESTED --> MATCHING: enqueued
    MATCHING --> OFFERED: driver locked,<br/>offer sent
    OFFERED --> MATCHING: decline or<br/>10s timeout
    OFFERED --> ACCEPTED: driver accepts
    MATCHING --> FAILED: candidates exhausted<br/>or 1 min budget spent
    ACCEPTED --> IN_PROGRESS: pickup
    IN_PROGRESS --> COMPLETED: drop-off
    REQUESTED --> CANCELLED
    MATCHING --> CANCELLED
```

## 4. High-level design

```mermaid
flowchart LR
    RC[Rider App]
    DC[Driver App]
    GW[API Gateway<br/>auth + rate limiting]
    RS[Ride Service<br/>fares + ride state]
    LS[Location Service<br/>ingest driver pings]
    MQ[[Match Queue<br/>SQS]]
    ORCH[Match Orchestrator<br/>Step Functions:<br/>offer / wait / next]
    MS[Matcher<br/>rank candidates,<br/>lock + offer]
    GEO[(Driver Geo Index<br/>Redis GEO)]
    LOCKS[(Offer Locks<br/>Redis SET NX + TTL)]
    DB[(Rides + Fares<br/>DynamoDB)]
    MAPS[Routing Provider<br/>distance + ETA]
    NS[Notifier<br/>push to driver]

    RC -->|/fares /rides| GW
    DC -->|/drivers/location<br/>PATCH /rides| GW
    GW --> RS
    GW --> LS
    RS -->|route + price| MAPS
    RS -->|fares, rides| DB
    RS -->|ride requested| MQ
    LS -->|GEOADD per ping| GEO
    MQ --> ORCH
    ORCH --> MS
    MS -->|GEOSEARCH radius| GEO
    MS -->|SET NX driverId<br/>TTL 10s| LOCKS
    MS -->|offer, assignment| DB
    MS --> NS
    NS -.push offer.-> DC
```

One box per unit of work:

- **API Gateway** — TLS termination, token auth, rate limiting. Nothing clever lives here.
- **Ride Service** — owns Fare and Ride records. Prices fares via the routing provider, creates rides in `REQUESTED`, and emits exactly one message per ride onto the match queue. Synchronous work ends here; it never waits for a match.
- **Location Service** — the write firehose. Validates a driver ping and issues a `GEOADD`; no durable write on this path at all (Deep Dive 9.1).
- **Match Queue** — buffer between demand spikes and matching capacity (Deep Dive 9.3).
- **Match Orchestrator** — a durable workflow per ride that loops *offer → wait ≤10 s → accepted? done : next candidate* until acceptance, exhaustion, or the 1-minute budget expires (Deep Dive 9.4).
- **Matcher** — one iteration of that loop: `GEOSEARCH` for nearby candidates, rank (distance as v1 proxy for pickup ETA), acquire the driver's offer lock, persist the offer, notify (Deep Dives 9.1, 9.2).
- **Driver Geo Index + Offer Locks** — same Redis engine, two jobs: geospatial index of live supply; short-TTL mutual exclusion on offers.
- **Rides + Fares store** — the durable system of record (Deep Dive 9.5).
- **Notifier** — pushes offers to the driver app (APNs/FCM in production; the lab build substitutes a polled offer endpoint — same contract, no mobile fleet required).

## 5. Data model

DynamoDB, on-demand:

| Table | PK | SK / notes |
|---|---|---|
| `fares` | `fareId` | pickup, destination, price, eta, `expiresAt` (TTL) |
| `rides` | `rideId` | riderId, fareId, status, driverId?, attempt, timestamps; GSI `driverId-status` for "driver's active ride"; GSI `riderId-createdAt` for history |
| `driver-offers` (lab notifier) | `driverId` | rideId, offeredAt, `expiresAt` (TTL) — production replaces this table with push delivery |

Redis:

| Key | Type | Contents |
|---|---|---|
| `geo:drivers` | GEO set | member = driverId, score = geohash of last ping |
| `geo:drivers:ts` | ZSET | driverId → last-ping epoch; sweeper removes members stale >30 s from both keys |
| `lock:driver:{id}` | STRING | `SET NX PX 10000`, value = rideId (owner check on release) |

Access patterns that shaped this: point-lookups by id on fares/rides (hot path),
one query per driver for the active ride, radius search + lock ops in Redis.
No joins, no scans anywhere on the hot path.

## 6. Detailed design

### 6.1 Fare estimate

Rider → `POST /fares` → Ride Service calls the routing provider for distance/ETA,
applies the pricing function, writes the fare with a 5-minute TTL expiry, returns
it. Stateless, cache-friendly, no coordination.

### 6.2 Request → match → accept

```mermaid
sequenceDiagram
    autonumber
    participant R as Rider App
    participant RS as Ride Service
    participant Q as Match Queue
    participant O as Orchestrator
    participant M as Matcher
    participant X as Redis GEO+Locks
    participant D as Driver App

    R->>RS: POST /rides {fareId}
    RS->>RS: validate fare not expired
    RS->>Q: enqueue {rideId}
    RS-->>R: 202 Ride REQUESTED
    Q->>O: start workflow(rideId)
    O->>M: find + offer
    M->>X: GEOSEARCH pickup radius 5km
    X-->>M: candidates ranked by distance
    M->>X: SET NX lock:driver:D1 PX 10000
    alt lock acquired
        M->>D: offer(ride, pickup, price)
        O->>O: wait accept / 10s
        alt accepted
            D->>RS: PATCH /rides {accept}
            RS->>RS: ride OFFERED→ACCEPTED (conditional write)
            RS->>X: release lock (owner check)
        else timeout or decline
            O->>M: next candidate
        end
    else lock busy (driver already offered)
        M->>M: skip to next candidate
    end
```

Rider learns the outcome via `GET /rides/{rideId}` polling in the lab build
(production: push/WebSocket — same state machine, different delivery).

### 6.3 Location ingestion

Driver ping → Location Service → `GEOADD geo:drivers lng lat driverId` +
`ZADD geo:drivers:ts now driverId`. Each `GEOADD` overwrites the previous
position, so the index always holds the latest fix and nothing accumulates. A
sweeper (1/min) `ZRANGEBYSCORE` for members older than 30 s and removes them from
both keys — offline drivers fall out of matching automatically. Update cadence is
decided client-side (Deep Dive 9.6).

### 6.4 Matching iteration

The matcher's contract is *at most one live offer per driver, at most one live
offer per ride*:

1. `GEOSEARCH` around pickup (5 km, `ASC`, limit 10), filter out drivers with an active ride (GSI lookup).
2. For the best candidate: `SET lock:driver:{id} {rideId} NX PX 10000`. Failure means another ride's matcher owns this driver right now — skip, next.
3. Lock acquired → conditional-write the offer onto the ride (`status=MATCHING → OFFERED`, `attempt+=1`), notify driver.
4. Accept path does `OFFERED → ACCEPTED` guarded by `attribute driverId = :caller` — a stale accept (after timeout already moved on) loses the conditional write and gets a 409.
5. Decline/timeout → orchestrator resumes at step 1 with the candidate excluded.

The lock TTL (10 s) equals the offer window, so a crashed matcher leaks nothing:
the lock self-expires and the driver returns to the pool.

## 7. Alternatives considered

Compact scorecards; full reasoning in the deep dives.

**Driver location store** (Deep Dive 9.1)

| Option | Write path @2M/s | Radius query | Verdict |
|---|---|---|---|
| DynamoDB/Postgres rows | melts or costs ~$200k/day | scan or unfit B-tree | rejected |
| Batch every 10s + PostGIS | survivable | good (GiST index) | viable; staleness + more moving parts |
| **Redis GEO in-memory** | in-memory, trivially | `GEOSEARCH` native | **chosen**; durability traded away knowingly |

**No-double-dispatch mechanism** (Deep Dive 9.2)

| Option | Coordination | Crash behavior | Verdict |
|---|---|---|---|
| In-process lock + timer | none across instances | lock lost / stuck | rejected |
| DB status column | transactional | in-memory timeout lost on crash; needs janitor cron | runner-up |
| **Redis `SET NX` + TTL** | atomic, shared | TTL self-releases | **chosen** |

**Demand buffering** (Deep Dive 9.3): direct sync call → rejected (spike = drops);
**SQS** → chosen (managed, DLQ, scales without capacity math); Kafka → the
at-scale answer for regional partitioning + replay, deliberately not the lab answer.

**Offer/timeout orchestration** (Deep Dive 9.4): service-local timers → rejected;
SQS delay-queue state machine → viable but hand-rolled bookkeeping; **Step
Functions** → chosen (durable waits, retries, state survives crashes).

**System of record** (Deep Dive 9.5): Postgres → fine at this scale, runner-up;
**DynamoDB on-demand** → chosen for the access patterns (all point lookups) and
zero-idle-cost lab economics.

## 8. Failure analysis and operations

| Failure | Blast radius | Behavior / recovery |
|---|---|---|
| Redis down | matching + location index | No new matches (fail closed — consistency guarantee outlives availability). In-flight offers unaffected in DynamoDB. On recovery the geo index rebuilds itself within one ping interval (~5 s) — this is why losing location data is acceptable. |
| SQS down | new ride requests | Ride Service returns 5xx on enqueue; riders retry. Nothing accepted is lost. |
| Step Functions execution dies | one ride's matching | Durable state: execution resumes or is retried from history; worst case the ride times out at 1 min and fails visibly. |
| DynamoDB down | everything durable | Full stop; multi-AZ managed service, accepted dependency. |
| Routing provider down | fare estimates | No new fares (degraded but explicit); active rides unaffected. |
| Matcher crashes mid-offer | one offer | Driver lock TTL expires in ≤10 s; orchestrator retry re-runs the iteration idempotently (conditional writes make repeats no-ops). |

Metrics that page: match latency p99 (SLO: <60 s), match failure rate, queue
depth + oldest-message age, lock-contention rate (skips/search), stale-driver
ratio in geo index, Step Functions execution failures. Everything else is
dashboards, not pages.

## 9. Deep Dives

### 9.1 How do we absorb ~2M location writes/s and still answer "drivers within 5 km" fast?

**The question behind the question:** what does 2M writes/s of *disposable* data
do to a durable store, and when is losing data fine?

**Durable table:** every ping becomes a write to DynamoDB/Postgres. At 2M
writes/s that's either a melted database or (DynamoDB on-demand at ~$1.25/M
writes) **~$200k/day** — for data that is stale 5 seconds later and worthless 30
seconds later. And once stored, finding "drivers within 5 km" over lat/lng
columns is a scan; B-tree indexes don't answer 2-D radius questions.

**Batch + PostGIS:** aggregate pings for ~10 s, bulk-write into Postgres with a
GiST geospatial index. Write load drops 2 orders of magnitude, queries get fast.
Costs: locations are up to a batch-interval stale (worse matches), plus a
batching pipeline to operate.

**In-memory GEO index:** Redis `GEOADD` encodes lat/lng into a geohash score in
a sorted set; `GEOSEARCH` answers radius queries natively. Writes are in-memory
overwrites — the newest fix simply replaces the old one, handling 2M/s across a
sharded cluster. Staleness is one ping (~5 s). The trade: durability. And that
trade is nearly free — if Redis dies, the entire dataset regenerates from live
pings within ~5 s of recovery. Durability for self-refreshing data is paying to
back up a mirror.

**Decision:** Redis GEO. NFR-4 explicitly ranks freshness over durability for
locations, and the recovery argument makes the durability loss a non-event.
How the radius query stays correct at geohash cell boundaries is its own
mechanism — Deep Dive 9.7.

```mermaid
flowchart LR
    DC[Driver App<br/>ping every 2-30 s] -->|POST /drivers/location| LS[Location Service]
    LS -->|GEOADD overwrite<br/>newest fix wins| GEO[(Redis GEO<br/>geo:drivers, sharded by city)]
    LS -->|ZADD last-ping ts| TS[(geo:drivers:ts)]
    SW[Sweeper 1/min] -->|evict stale >30 s<br/>from both keys| GEO
    MS[Matcher] -->|GEOSEARCH 5 km<br/>ASC COUNT 10| GEO
```

**In the code:** `cdk/stacks/location-stack.ts` (ElastiCache +
sweeper schedule), `src/location/handler.ts` (GEOADD ingest),
`src/location/sweeper.ts` (stale eviction), `src/matching/candidates.ts`
(GEOSEARCH).

### 9.2 How do we guarantee each driver holds at most one ride offer at a time?

**The question behind the question:** where does mutual exclusion live when the
service enforcing it can crash?

**In-process locking:** each matcher instance tracks offered drivers in memory
with a timer. Two instances offer the same driver concurrently (no shared
state); a crash strands the driver "offered" forever. Non-starter.

**Status column in the database:** `UPDATE drivers SET status='offered' WHERE
status='available'` — transactional, coordinated, correct on the happy path. The
hole is the *release*: the 10-second offer expiry lives in some service's memory.
Crash between offer and timeout and the driver is stuck until a janitor cron
notices — added complexity, delayed unlock, and the cron is now a correctness
component.

**Lock with TTL:** `SET lock:driver:{id} {rideId} NX PX 10000`. Atomic
acquisition shared by every matcher instance, and the *expiry is the store's
job*: no process needs to survive for the driver to be released. Accept path
releases early (owner-checked); crash path self-heals in ≤10 s. Cost: matching
correctness now depends on Redis availability — acceptable because the data is
10-second ephemera (loss ⇒ brief over-conservatism or a duplicate offer window
bounded by the ride-side conditional write, which remains the final arbiter).

**Decision:** Redis lock, TTL = offer window; DynamoDB conditional writes on the
ride record as the durable backstop (defense in depth: the lock prevents the
race, the conditional write makes it harmless if it ever happens).

**How the guarantee actually runs** — two matchers race for driver D:
1. Both execute `SET lock:driver:D <rideId> NX PX 10000`. NX means exactly one
   wins; the loser treats D as busy and moves to its next candidate.
2. The winner runs the ride-side guard: `status=OFFERED, driverId=D` only if
   `status = MATCHING`. Even if a leaked lock ever let two matchers through,
   the second guard write fails — the record, not the lock, is the arbiter.
3. Only then is the offer row written (D's poll surface) and the accept path
   armed. Accept runs its own owner-checked guard (`status = OFFERED AND
   driverId = :caller`), so a stale or hijacked accept gets a clean 409.
How D becomes available again when nobody answers is Deep Dive 9.8.

```mermaid
flowchart LR
    MA[Matcher A<br/>ride 1] -->|1 SET NX PX 10s — wins| LOCK[(Redis lock:driver:D<br/>value = ride 1)]
    MB[Matcher B<br/>ride 2] -.->|1 SET NX — loses,<br/>next candidate| LOCK
    MA -->|2 markOffered guard<br/>only if status MATCHING| RIDES[(DynamoDB rides)]
    MA -->|3 offer row + task token| OFF[(DynamoDB driver-offers)]
    D[Driver D] -->|accept guard: OFFERED<br/>AND driverId = caller| RIDES
```

**In the code:** `src/matching/driver-lock.ts` (acquire/release
with owner check), `src/rides/store.ts` (`acceptRide` guard: conditional
`OFFERED→ACCEPTED` with owner condition), `src/rides/handler.ts` (the task
token is resolved only after the guard succeeds).

### 9.3 How do we ensure no ride request is dropped during peak demand?

**The question behind the question:** what happens to the 100k-requests spike if
matching is synchronous?

**Direct call:** Ride Service invokes the matcher inline. Its availability now
multiplies with the matcher's; a demand spike becomes matcher back-pressure
becomes rider-facing 5xx; a matcher crash *loses the request entirely* — a rider
waiting for a match that will never come. Retries pile on exactly when the
system is sickest.

**Queue:** the ride lands durably (`REQUESTED`) and one message is enqueued;
acknowledgment to the rider takes milliseconds regardless of matching load. The
spike becomes queue depth — riders match slower, nobody is dropped (NFR-3
verbatim). Consumers scale on depth; a consumer crash returns the message after
visibility timeout. Costs: eventual matching (fine — matching is asynchronous by
nature), duplicate delivery (fine — the orchestration is idempotent via
conditional writes), one more component.

**Decision:** SQS. Kafka's regional partitions + replay are the right answer at
Uber scale; a lab that needs ordering-free work distribution with a DLQ needs
SQS's operational surface, not a cluster. The no-drop guarantee is the chain:
the ride row is durable before the enqueue; SQS redelivers until the consumer
succeeds (at-least-once); duplicate deliveries collapse because the workflow
execution name is the rideId; a poison message stops burning retries after 3
receives and lands in the DLQ with an alarm — isolated, never silently gone.

```mermaid
flowchart LR
    RS[Ride Service] -->|1 persist REQUESTED| RIDES[(DynamoDB rides)]
    RS -->|2 enqueue rideId| MQ[[SQS match-queue]]
    MQ -->|at-least-once delivery| PUMP[Pump]
    PUMP -->|StartExecution<br/>name = rideId dedupes| SFN[Step Functions matcher]
    MQ -.->|3 failed receives| DLQ[[DLQ + paging alarm]]
```

**In the code:** `cdk/stacks/matching-stack.ts` (queue + DLQ +
oldest-message-age alarm), `src/rides/handler.ts` (enqueue after persist),
`src/matching/pump.ts` (execution-name dedupe on redelivery).

### 9.4 How does the offer → timeout → next-driver loop survive crashes mid-flight?

**The question behind the question:** the offer/timeout/next-driver loop is a
multi-step process with a human in the middle — where does its state live when
processes die?

**Delay queue:** on each offer, schedule a +10 s message; on processing, check
"still unassigned?" and offer to the next driver. Workable, but the workflow
state (which attempt, which drivers exhausted, cancel-on-accept) is smeared
across messages and rows, and every edge (accept racing the delayed message,
duplicate delivery) is hand-rolled reconciliation logic.

**Durable workflow:** the loop *is* a state machine, so run it on an engine that
persists state transitions: offer → wait (accept signal | 10 s timeout) → branch
→ next candidate, with the 1-minute budget as a workflow-level timeout. Crashes
resume from recorded history; retries and timeouts are declarative; the ride's
matching history becomes inspectable execution history (superb for debugging a
lab and for arguing in an interview). Cost: an orchestration dependency and its
learning curve.

**Decision:** Step Functions (this is Temporal's home turf too — same pattern;
Step Functions keeps the lab serverless and free-tier-friendly).

```mermaid
flowchart LR
    GC[GetCandidates<br/>budget check + search] --> CH{any<br/>left?}
    CH -->|yes| OFF[OfferToDriver<br/>waitForTaskToken · 10 s]
    OFF -->|accept resolved token| DONE([ACCEPTED])
    OFF -->|timeout · decline<br/>· lock busy| REL[ReleaseOffer<br/>unwind + exclude driver]
    REL --> GC
    CH -->|no, or 60 s budget spent| MF[MarkFailed — guarded]
```

**In the code:** `cdk/stacks/matching-stack.ts` (state machine:
offer → `waitForTaskToken` accept-signal → release-and-exclude loop, timeouts),
`src/matching/candidates.ts`, `src/matching/offer.ts`, `src/matching/release.ts`,
`src/matching/fail.ts` (per-state Lambdas).

### 9.5 How should rides and fares be stored — DynamoDB or Postgres?

**The question behind the question:** does anything here need relational power,
and what does the lab's idle time cost?

**Postgres (Aurora Serverless):** relations, transactions across entities,
ad-hoc queries for analytics; PostGIS would even cover locations if we hadn't
solved that in-memory. At 230 writes/s it's comfortably fine — this is a
legitimate choice, not a strawman.

**DynamoDB:** every hot-path access is a point lookup or single-partition query
(fare by id, ride by id, active ride by driver) — the exact shape DynamoDB
serves at any scale with single-digit-ms latency. Conditional writes give the
state-machine guards (9.2, 9.4) natively. On-demand mode costs zero while the
lab sleeps, and `cdk destroy` deletes tables cleanly (RDS teardown drags
snapshots/subnet groups).

**Decision:** DynamoDB — chosen by access patterns and lab economics. The honest
counterweight: the moment ad-hoc relational questions matter (ops analytics,
finance), that workload belongs in an analytical replica, not in this
transactional path — at which point CDC into a warehouse beats swapping the
primary store.

**In the code:** `cdk/stacks/data-stack.ts` (tables, GSIs,
TTLs), `src/rides/store.ts` (conditional-write helpers).

### 9.6 How do we cut the location write load without losing match accuracy?

**The question behind the question:** can we cut the 2M/s write load without
buying hardware — and who has the information to do it?

A fixed 5 s cadence treats a driver parked at an airport queue like one doing
120 km/h on a highway. Only the device knows speed, heading change, and
proximity to an active pickup — so the client adapts: stationary → ~30 s;
cruising straight → ~10 s; fast/turning/near-assignment → 2–5 s. Same matching
accuracy where it matters, at a fraction of the writes (an airport lot full of
idle drivers drops its ping load ~6x). Cost: cadence logic ships in the app and
degrades unevenly across devices; the server-side stale sweeper threshold must
tolerate the slowest legitimate cadence.

**Decision:** adaptive client cadence, server treats cadence as untrusted input
(sweeper + freshness checks are server-side).

**In the code:** `src/testdata/fleet.ts` (per-driver `cadenceS` in fixture
behavior profiles); the driver simulator that applies the adaptive policy
arrives with the e2e/load harness (`src/sim/driver-sim.ts`, tasks 8–9) —
production would ship it in the app.

### 9.7 How do proximity searches avoid missing drivers near geohash cell boundaries?

**The question behind the question:** geohash turns 2-D proximity into 1-D
prefix similarity — where does that mapping lie to you?

**The trap (naive prefix search):** store each driver's geohash string and
answer "drivers near P" by matching P's prefix. Two points 50 m apart can sit
in cells that share *no* prefix — cell edges are discontinuities, and the worst
ones (major cell boundaries) split city centers. A rider on one side of the
line gets matched to a farther driver while a nearer one idles across the
boundary. Silent, systematic, and location-dependent — the nastiest bug class.

**The standard fix (neighbor expansion):** pick the cell precision whose cell
size is at least the search radius, then query the center cell *plus its 8
neighbors*, and exact-distance-filter the union. Nine range scans and a
haversine check per candidate — correctness restored at ~9x the index reads.

**What we run (Redis GEOSEARCH):** Redis stores members as 52-bit interleaved
geohash scores in a sorted set. `GEOSEARCH … BYRADIUS 5 km ASC` performs the
neighbor expansion internally — it decomposes the circle into the minimal
covering set of geohash ranges (center + neighbors at the right precision),
scans those score ranges, then computes true distance per candidate, filters,
and sorts. The boundary problem is solved below our API line — but it is the
mechanism an interviewer wants explained, because "the library handles it" is
the answer that gets graded down.

```mermaid
flowchart LR
    Q[Radius query<br/>pickup + 5 km] --> PR[Pick cell precision<br/>cell edge ≥ radius]
    PR --> NB[Center cell<br/>+ 8 neighbors]
    NB --> RS[Scan 9 geohash<br/>score ranges in the ZSET]
    RS --> HF[Exact haversine filter<br/>drop &gt; 5 km]
    HF --> ASC[Sort nearest-first<br/>take 10]
```

**Decision:** Redis GEOSEARCH (geohash-scored ZSET + internal 9-cell expansion
+ exact-distance filter). The lab fake deliberately skips cells and computes
haversine over all drivers — semantically identical, which is itself the
point: cells are a scaling optimization, never the correctness boundary.

**In the code:** `src/location/redis-geo-client.ts` (GEOSEARCH BYRADIUS — the
adapter never touches raw geohash prefixes), `src/location/geo-client.fake.ts`
(pure-haversine fake pinning the same semantics),
`src/matching/candidates.test.ts` (nearest-first ordering across the bbox).

### 9.8 How does an unanswered offer expire so the driver becomes available again?

**The question behind the question:** a timeout must unwind state held in
three places (workflow, ride record, driver lock + offer row) — whose clock do
you trust when any process can die?

**Janitor cron:** scan for offers older than 10 s and reset them. Works until
the cron is down (nobody unlocks), double-fires (races the accept), or drifts
(unlock latency = scan interval). The cron becomes a correctness component —
the same hole 9.2 rejected.

**What we run — three timers, distinct owners, one release path:**
1. **Engine-owned:** the `OfferToDriver` state waits for the task token with
   `TimeoutSeconds: 10`. No answer ⇒ the engine fails the state
   (`States.Timeout`) and the catch routes to ReleaseOffer. This clock
   survives every Lambda crash because it lives in the workflow engine.
2. **The unwind (ReleaseOffer):** guarded write flips `OFFERED→MATCHING`
   *pinned to driverId AND attempt* — a delayed release can never clobber a
   re-offer; conditional delete of the offer row *pinned to rideId* — never
   removes a newer offer; owner-checked lock release. Driver joins `excluded`,
   the loop re-searches. Decline and lock-busy ride the exact same path — one
   lane, three triggers, every rung idempotent.
3. **Store-owned backstops (workflow itself dies):** the lock self-expires
   (`PX 10000`), the offer row TTLs out of DynamoDB, and `markFailed` covers
   OFFERED so the ride still reaches a terminal state — a late accept then
   gets a clean `STALE_OFFER` 409 from the owner guard.

```mermaid
flowchart LR
    OFF[Offer to driver D<br/>token armed · 10 s] -->|no answer| TO[States.Timeout<br/>engine clock fires]
    TO --> REL[ReleaseOffer]
    REL -->|OFFERED to MATCHING<br/>pinned driver + attempt| RIDES[(rides)]
    REL -->|delete row<br/>pinned rideId| OFFROW[(driver-offers)]
    REL -->|owner-checked DEL| LOCK[(lock:driver:D)]
    REL -->|exclude D| NEXT[re-search<br/>next candidate]
    LOCK -.->|backstop: PX self-expiry| FREE([D available])
```

**Decision:** engine-owned timeout (Step Functions `waitForTaskToken`) for the
primary path, store-owned TTLs (Redis `PX`, DynamoDB TTL) as crash backstops,
and conditional writes so every unwind step is safe to repeat or lose a race.

**In the code:** `cdk/stacks/matching-stack.ts` (`taskTimeout` + catch-all to
release), `src/matching/release.ts` (the one unwind path),
`src/matching/driver-lock.ts` (PX TTL + owner-checked Lua release),
`src/matching/offer-store.ts` (row TTL + rideId-pinned delete),
`src/rides/store.ts` (`releaseOffer` attempt pin; `markFailed` covering
OFFERED).

## 10. Final design — the whiteboard after the deep dives

§4 is the sketch you draw in minute 15. Every deep dive then amended it; this
is the picture on the whiteboard when the interview ends — same shape, but the
components carry names, the edges carry guarantees, and the additions the
dives forced are visible.

```mermaid
flowchart LR
    RC[Rider App<br/>poll GET /rides]
    DC[Driver App<br/>adaptive ping 2–30 s · 9.6]
    GW[API Gateway<br/>auth + rate limiting]
    RS[Ride Service]
    MAPS[Routing Provider]
    MQ[[SQS match-queue]]
    DLQ[[DLQ + paging alarm · 9.3]]
    ORCH[Step Functions per ride · 9.4<br/>offer → wait ≤10 s → release loop]
    MS[Matcher]
    LS[Location Service]
    GEO[(Redis GEO, sharded · 9.1<br/>ts ZSET + 30 s sweeper)]
    LOCKS[(Redis offer locks<br/>SET NX PX 10 s · 9.2)]
    DB[(DynamoDB on-demand · 9.5<br/>fares TTL · rides + attempt · offers TTL)]
    NS[Notifier<br/>APNs/FCM push]

    RC --> GW
    DC --> GW
    GW --> RS
    GW --> LS
    RS -->|route + price| MAPS
    RS -->|useFare guard · createRide| DB
    RS -->|exactly one msg per ride| MQ
    MQ -->|StartExecution name = rideId<br/>redelivery dedupe · 9.3| ORCH
    MQ -.->|3 failed receives · 9.3| DLQ
    LS -->|GEOADD overwrite per ping| GEO
    ORCH --> MS
    MS -->|GEOSEARCH 5 km ASC<br/>9-cell boundary expansion · 9.7| GEO
    MS -->|acquire, owner-checked release| LOCKS
    MS -->|markOffered guard, attempt++ · 9.2| DB
    MS --> NS
    NS -.offer, 10 s window.-> DC
    DC -->|accept: acceptRide owner guard first,<br/>THEN resolve task token · 9.8| RS
    RS -->|SendTaskSuccess / SendTaskFailure| ORCH
    ORCH -->|timeout · decline: release pinned<br/>to driver + attempt · 9.8| DB
```

What changed since §4, dive by dive:

- **Added components:** the DLQ with its paging alarm (9.3) — poison requests
  are isolated, never silently lost; nothing else needed inventing, which is
  itself the finding: the dives hardened edges rather than adding boxes.
- **Data-model changes:** `rides` gains `attempt` — the release guard is
  pinned to driver AND attempt so a delayed release can never clobber a
  re-offer (9.2, 9.8); the offer record's TTL equals the offer window (9.8);
  every state transition became a *named* conditional write (`useFare`,
  `markOffered`, `acceptRide` with owner condition, `releaseOffer`,
  `markFailed` covering OFFERED so every ride reaches a terminal state).
- **Edges that gained guarantees:** queue→workflow carries execution-name
  dedupe (9.3); the geo search explicitly does 9-cell boundary expansion +
  exact-distance filtering (9.7); accept resolves the task token only after
  the owner guard succeeds (9.8); the driver app owns its ping cadence and
  the server treats it as untrusted input (9.6).
- **Deliberately unchanged:** SQS, Step Functions, DynamoDB, and Redis GEO all
  survived interrogation (9.1, 9.3, 9.4, 9.5) — the dives confirmed the §4
  choices rather than replacing them, with Kafka named as the at-scale swap
  for the queue.
