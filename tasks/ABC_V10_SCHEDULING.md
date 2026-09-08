# ABC v10: live discovery, role allocation and minute processing

Paper only. Preserve accounts, trade history, experiment dates, existing minute evidence and the historical catalog cursor. Strategy/safety/cost thresholds are unchanged.

- Live catalog discovery begins with an explicitly recorded 900-block tail (`catalog_live_start`), then advances its own cursor without skipping outages. It runs before pool collection with an 8-second deadline and up to 6000 blocks. Historical catch-up retains `catalog_cursor`, runs separately for up to 8 seconds/6000 blocks, and reports its actual endpoint. The tail is discovery, not invented historical price coverage.
- One bounded manager Swap query observes activity across pools. Persist exact block overlap: uncovered intervals reset the inactivity observation start. Unknown pool IDs and failed queries do not count as inactivity. This is candidate selection evidence, not executable liquidity or a trading signal.
- Four slots: 1 prepares B (age >=22h), 3 prepares A (age >=2h), 2/4 prepare C (age <5.5h). Existing slots retain their history until expiration or observed inactivity. C expires at age 6h. A/B retain at most 36h. Inactive rotation requires 30 minutes of continuously observed no swaps and a minimum residence of 30 minutes for C / 120 minutes for A/B. Holdings are collected independently of slot rotation. No eligible candidate means an empty slot.
- HTTP work is serialized per origin through body completion and observes cancellation across fallback chains. Public failures pause that source for five minutes; transient throttling no longer means daily Solid quota exhaustion. Ordinary reads retain Alchemy first and use the limited-range dedicated endpoint as fallback. Five-block Discover logs are never expanded into hundreds of small calls.
- Persist each strategy/token's evaluated minute. Process every intervening minute once; missing usable data breaks setup state and stays missing. Older signals are diagnostic only. Current pending intent is saved before network I/O, cleared on fill/permanent rejection and retried only until two minutes after signal close. All entry freshness, safety, cost and idempotency checks still apply.

## Verification

`node abc-repair-verify.mjs`, `node abc-verify.mjs`, `node abc-screening-verify.mjs`, `git diff --check`.

Repair checks include actual local HTTP cancellation, duplicate/missed minute processing, pending-intent expiry/permanent rejection, role separation and observed inactivity. Positive paper-entry fixtures exercise account application; they do not establish real-market eligibility.

VPS isolated source/account checks on 2026-09-08: three cycles reached their captured chain head with live discovery, analyzed four pools each and advanced historical catch-up; cycle durations 41.9/29.1/28.7 seconds. Activity query observed 509–538 pool IDs. This short check does not establish 30/120-minute continuous acceptance. Later local refinements add exact overlap accounting, error details, durable intent before I/O and bounded live catch-up.

Eight historical v8 signals were checked in isolated accounts using real holder data and quotes. Initial cold-cache requests timed out for two; explicit retry after independent cache completion reached the cost gate for both. All eight eventually failed the unchanged 5% round-trip cost gate (8.2701–8.7439% in this run). Two independent read-only round-trip simulations returned `SIMULATED_NOT_FILLED`. They were diagnostics after a cost rejection, not a bypass to applyBuy. Historical block/FX with current gas is not a causal profitability backtest. No eligible live fill has been demonstrated.

Production activation must use an immutable reviewed release, graceful single-worker handoff and before/after account/date comparison. Keep isolated tests and holder caches separate from production data; do not insert historical test fills into production.

## Activation result

Code release `8b12593` (including `392da39`) deployed on 2026-09-08. Archive SHA256: `28de5eac353ac2f390521305dd36f526c6443375ec86e7696aacab567a68458a`. All three verification suites passed on the VPS. First final-release cycle: 14.428s, four pools analyzed, live cursor equals captured head 57503751, historical cursor advanced 4500 blocks to 57444591, 554 active pool IDs observed, no current pool error. Normal catalog budget exhaustion reports partial progress rather than an outage.

Before/after account economic fields and creation times matched, as did experiment start/end. All three accounts still have zero trades and positions. This is operational acceptance plus isolated entry-path rejection/simulation evidence, not a demonstrated eligible market fill or full continuous-window soak.
