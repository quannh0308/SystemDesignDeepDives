# Design Backlog

Queued designs with their research seeds — captured at selection time so the
scoping work isn't lost. Promotion order and scope get re-validated at start
(per AGENTS.md workflow step 1). Sources are public interview-prep material.

## B. retail-brokerage (Trade Republic / Robinhood shaped)

**One-liner:** retail stock trading: you are the *introducing broker*, not the
exchange — clearing partner for custody/settlement, third-party market data,
orders routed to external venues; millions of watchers on live prices.

**Signature interview questions found:**
- How do millions of clients get live prices for the symbols they watch
  (hot-symbol fan-out: WebSocket/SSE, pub/sub tiers, top-of-book coalescing)?
- How is buying power reserved exactly once when an order is placed, and
  released on cancel/reject (the fare-hold pattern, money-grade)?
- How do asynchronous fills/partial fills from a venue reconcile with
  positions and cash (order state machine against an external actor)?
- How does the order path stay correct when the market opens (10× burst) or a
  venue halts a symbol?

**Learning delta:** real-time fan-out + streaming market data — the one muscle
neither uber nor payment-system exercises. Order lifecycle overlaps uber's
durable-execution heavily (reuse, don't re-learn). Inherits design C as its
routing deep dive.

**Anchors:** HelloInterview "Robinhood" breakdown · reported prompt: "design a
retail trading platform — clearing broker for custody, SIP top-of-book vendor
data, route to market makers" (prachub) · Trade Republic's 2026 Best Price
routing across 30 venues (brokerchooser).

## C. crypto-order-routing (Coinbase verbatim — fold into B as a deep dive)

**One-liner:** order placement without owning a matching engine: route
buy/sell orders to third-party venues speaking heterogeneous protocols
(REST/WebSocket/FIX), where any venue may be slow, rate-limited, or down.

**Signature interview questions found:**
- How do you normalize N venue protocols behind one order interface
  (adapter fleet, anti-corruption layer)?
- How do you pick a venue per order (health scoring, price, rate budget) and
  fail over mid-order without double-executing?
- How do circuit breakers + hedged requests behave when a venue browns out?

**Learning delta:** adapter/port discipline at fleet scale, circuit breakers,
venue health scoring. Too narrow to carry a full design alone — planned as the
routing deep dive inside B (decision recorded 2026-09-04).

**Anchors:** reported Coinbase prompt verbatim (prachub "Design Crypto Order
Routing") · codemia Coinbase guide (payments/ledger/blockchain infra emphasis).

## D. matching-engine (Coinbase core / stock exchange)

**One-liner:** the exchange itself: a central limit order book matching orders
by price-time priority, deterministically, recoverable by replay.

**Signature interview questions found:**
- How does one order book process every order in sequence without locks
  (single-writer principle, in-memory book, input sequencing)?
- How does the engine recover after a crash to the *exact* same state
  (event sourcing: sequenced input log + snapshots + deterministic replay)?
- How does a hot standby take over without missing or double-matching an
  order?
- How are market-data feeds (every book change) published without slowing
  matching?

**Learning delta:** the architectural opposite of uber/payment-system —
stateful, single-writer, latency-driven, event-sourced. Needs an always-on
process (Fargate/ECS, not Lambda) — deliberately last, after the serverless
patterns are banked; also the first design to break the scale-to-zero cost
model (containment: destroy between sessions).

**Anchors:** systemdesignhandbook "Design a Stock Exchange" (mission-critical
low-latency stateful systems) · codemia editorial ("design the exchange, not
the broker — matching, not accounts") · Coinbase matching-engine prompts
(codinginterview).

## Promotion order (working assumption)

payment-system (active) → B retail-brokerage (with C folded in) → D
matching-engine. scalable-notifications (named at repo creation) is partially
banked by payment-system's webhook pipeline (hld.md 9.5); re-scope what
remains before promoting it.
