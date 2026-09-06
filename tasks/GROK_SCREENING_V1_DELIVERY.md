# GROK_SCREENING_V1 Delivery

Paper-only diagnose layer for ABC screening explainability. **Does not claim profitability validation.**

## Summary

| Item | Status |
|---|---|
| NO_T detail reason codes (aggregate NO_T kept) | Done |
| Unique eval key `(strategy,token,minute,code_version)` | Done (`screening_evals`) |
| Safety checks value/threshold/status/reason/source | Done |
| unknown ≠ 0 ≠ PASS | Done |
| Three observe-only risk metrics | Done (no buy gate) |
| `node abc.mjs screening-report` | Done |
| Verify cases extended | Done |
| Buy / trigger / fee / FX 120s / positions / watch / exit unchanged | Yes (see deltas) |

## Files changed

| File | Change |
|---|---|
| `abc-screening.mjs` | **New** — diagnose NO_T, safety evidence helpers, observe risk metrics, upsert evals, screening-report |
| `abc-collect.mjs` | `screening_evals` schema; `buildSafetyEvidence`; `safetyScreen` returns `checks` (cheap checks first; skip heavy `holderData` when cheap already failed) |
| `abc.mjs` | Persist unique screening evals in `cycle` (non-gating); `screening-report` CLI; `tryEnter` returns additive `safety` field |
| `abc-verify.mjs` | Focused screening cases (temp DB) |
| `abc-repair-verify.mjs` | Unique-eval + read-only report case |
| `tasks/GROK_SCREENING_V1_DELIVERY.md` | This doc |

## How to run

```bash
# Offline verifies (temp sqlite only; does not touch production ABC_HOME)
node abc-verify.mjs
node abc-repair-verify.mjs

# Read-only funnel (uses ABC_HOME or data/abc; may CREATE IF NOT EXISTS screening_evals once)
node abc.mjs screening-report
```

Requires Node `>=22.13` (`node:sqlite`).

## Funnel (last 24h unique evals)

Report JSON fields per strategy A/B/C:

`observed → data_complete → age_satisfied → strategy_signal → safety_pass → paper_fill`

Units: unique rows keyed by `(strategy,token,minute,code_version)`. Re-eval upserts; does not multiply samples. If diagnostics only exist from a start time, `diagnostics_start_at` is set — **no historical backfill / no fabricated unknowns**.

## NO_T detail codes

Aggregate `reject_counts.NO_T` unchanged. Detail persisted on `screening_evals.detail_code` from real store evidence:

| Code | Evidence |
|---|---|
| `MINUTE_NOT_COLLECTED` | No bucket; `minute_status=NOT_COLLECTED` or incomplete close |
| `COVERAGE_NOT_CLOSED` | `coverage_gaps` / missing `last_complete_minute` / missing event cursor |
| `BUCKET_INVALID` | `buckets.invalid=1` |
| `FX_MISSING` | `fx_snap` / `NO_FX_SNAP` |
| `FX_OBSERVED_STALE` | `OBSERVED_AT_LAG` |
| `FX_SOURCE_STALE` | `SOURCE_LAST_UPDATED_LAG` |
| `NO_VALID_PRICE` | Bucket exists but no usable `close_usd` (distinct from priced no-trade carry) |
| `NOT_IN_WATCH` | Not seated/held — **not** counted as screening reject |

## Safety evidence order

1. phase2  
2. liquidity  
3. supported quote (WETH/zero \| USDG)  
4. holder_count (≥15)  
5. top10_circulating_bps (≤6000; denominator = circulating ex-infra)  
6. round-trip loss ≤5% — **deferred** until entry (`UNKNOWN` with reason `ROUND_TRIP_DEFERRED_UNTIL_ENTRY` in screen-only evidence)

Heavy `holderData` / round-trip sim still only on `tryEnter` after a real signal. Within `safetyScreen`, if cheap checks already fail, `holderData` is not called (RPC save). **ok remains false either way**; reject *reason strings* may prefer cheap codes over a later holder error — see deltas.

## Observe-only risk metrics (not used for trades)

1. **Max single-address buy share (5m)** — denominator = attributable external buy USD from `buckets.buy_recipients`; UNKNOWN if none (not “0%”).  
2. **Creator net sell / balance** — UNKNOWN unless creator + verifiable sell + balance exist; no related-wallet guessing.  
3. **Quote loss breakdown** — quoter fee+impact **merged** when inseparable; haircut_bps, buy/sell gas, L1 allowance UNKNOWN, total RT loss; never treats `pool.liquidity` as USD depth.

No smart-money / safety-coin / profit scores.

## Behavior change?

**Buy decisions: no.** Strategy `evaluateA/B/C` reasons and signal predicates unchanged (`NO_T` aggregate preserved). Exit rules, fees, FX 120s, positions, watch slots unchanged. No DB reset, no live trading, no worker restart, no Telegram spam from this PR.

### Documented deltas (diagnose-compatible)

1. `safetyScreen` return value gains `checks` (and may omit `holderData` when cheap checks already failed). `ok` boolean semantics unchanged for entry gating.  
2. `tryEnter` return gains optional `safety` / still `{filled:true,plan}` path for fills.  
3. `cycle` writes `screening_evals` upserts (bounded by unique key; not unbounded log text).  
4. Account `reject_counts` still increments every cycle for the same minute (legacy); **report** uses unique evals only.

## Current bottleneck ranking (from ABC_V7 + screening intent)

1. Continuous usable FX window (SOURCE_LAST_UPDATED_LAG / coverage catch-up) — primary zero-fill driver historically  
2. Graduation / consecutive-window warmups  
3. Strategy non-trigger with valid data  
4. Safety gates — **not** the explanation for current mass NO_T (A/B/C each ~232 NO_T in prior snapshot)

## Remaining gaps

- Production 24h funnel needs a running worker that has written `screening_evals` after deploy; empty report is expected until then.  
- Creator net-sell metric usually UNKNOWN until deployer is plumbed into record path with verifiable sells.  
- Quoter fee vs impact cannot be split with current quoter outputs (merged by design).  
- Did not change fold/recipient attribution path (already infra-filters + per-tx deltas); helper `attributedBuyRecipients` is verified for diagnose/consistency only.  
- Local verify not executed in this agent environment (box Node 20 lacks `node:sqlite`; repo requires ≥22.13).  
- No profitability claim; no threshold tuning for observe metrics.

## Pre-start checklist (ops)

1. Merge PR; do **not** reset `data/abc` or alter accounts.  
2. Deploy code; existing worker keeps running until a normal recycle you choose — this PR does not restart workers.  
3. After process runs new code: `node abc.mjs screening-report`.  
4. Re-run `node abc-verify.mjs` and `node abc-repair-verify.mjs` on Node ≥22.13.  
5. Telegram remains fills/halts only.

## Constraints honored

- Paper only; no live trading  
- No strategy trigger / fee / FX 120s / position / watch / exit rule edits  
- No DB reset / account mutation / worker restart / Telegram spam from delivery  
- No new dependencies  
- New fields backward compatible; old rows unknown; nothing fabricated  
- Diagnose-only for buy-affecting corrections
