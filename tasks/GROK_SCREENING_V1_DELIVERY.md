# GROK_SCREENING_V1 Delivery

Paper-only diagnose layer for ABC screening explainability. **Does not claim profitability validation.**

## Summary

| Item | Status |
|---|---|
| NO_T detail reason codes (aggregate NO_T kept) | Done |
| Unique eval key `(strategy,token,minute,code_version)` | Done (`screening_evals`) |
| Safety checks value/threshold/status/reason/source | Done |
| unknown ≠ 0 ≠ PASS | Done |
| Three observe-only risk metrics | **Scoped honestly** (see metrics scope) |
| `node abc.mjs screening-report` | Done (**read-only**) |
| Verify cases | Done (`abc-screening-verify.mjs`, includes PR1 regressions) |
| Buy / trigger / fee / FX 120s / positions / watch / exit unchanged | Yes (see deltas) |
| PR1 review fixes (wired sources, BigInt JSON, funnel, readonly, upsert) | Done — see `tasks/PR1_REVIEW.md` |

## Files changed

| File | Change |
|---|---|
| `abc-screening.mjs` | Barrel — schema, `buildSafetyChecks`, `jsonSafe`, `classifyFunnelStage`, monotonic `upsertScreeningEval`, **read-only** `screeningReport` |
| `abc-screening-not.mjs` | NO_T detail diagnosis from buckets / minute_status / coverage_gaps / fx_snap |
| `abc-screening-risk.mjs` | Observe-only risk metrics; BigInt-safe haircut; honest incomplete labels |
| `abc-screening-verify.mjs` | Focused offline verify + PR1 regression cases |
| `abc.mjs` | **Wired in-tree** — import/recordEval/`screening-report` via `openAbcReadonly`; tryEnter returns safety/plan on reject paths |
| `abc-collect.mjs` | **Wired in-tree** — `screening_evals` schema on open; `buildSafetyEvidence`; `openAbcReadonly` |
| `tasks/GROK_SCREENING_V1_DELIVERY.md` | This doc |
| `tasks/PR1_REVIEW.md` | User PR1 review text (history) |

**Removed (PR1):** `patches/abc.mjs.zlib.b64`, `patches/*.patch`, `scripts/apply-grok-screening-patches.mjs` — broken zlib path and post-checkout mutation no longer required. Reviewers see real diffs on a normal checkout.

## How to run

```bash
node abc-screening-verify.mjs                  # offline focused cases (temp sqlite)
node abc.mjs screening-report                  # last-24h unique-eval A/B/C funnel (read-only)
```

Requires Node `>=22.13` (`node:sqlite`). **No apply/patch step.** Report does **not** create schema or migrate.

## Funnel (last 24h unique evals)

Report JSON fields per strategy A/B/C:

`observed → data_complete → age_satisfied → strategy_signal → safety_pass → paper_fill`

**Stage rules (PR1 fix):**

| Stage | Meaning |
|---|---|
| `AGE_INCOMPLETE` | Graduation-age only: `GRADUATION_TIME_UNKNOWN`, `WARMUP_GRADUATION_*`, or missing `gradTs` after data checks |
| `DATA_INCOMPLETE` | Data/window: `WARMUP`, `WARMUP_LT_30_CONSECUTIVE`, `WARMUP_LT_120M`, `WINDOW_INCOMPLETE`, `NO_T` detail |

Units: unique rows keyed by `(strategy,token,minute,code_version)`. Re-eval upserts are **monotonic** for `has_signal` / `paper_filled` / funnel (never lose signal+fill evidence). If diagnostics only exist from a start time, `diagnostics_start_at` is set — **no historical backfill / no fabricated unknowns**.

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
| `NO_VALID_PRICE` | Bucket exists but no usable `close_usd` |
| `NOT_IN_WATCH` | Not seated/held — **not** counted as screening reject |

## Safety evidence order

1. phase2  
2. liquidity  
3. supported quote (WETH/zero | USDG)  
4. holder_count (≥15)  
5. top10_circulating_bps (≤6000; denominator = circulating ex-infra)  
6. round-trip loss ≤5% — evidence attached when `tryEnter` has a plan (including fee/round-trip reject paths)

Cheap checks first. Heavy `holderData` skipped when cheap already failed (RPC save). **`ok` remains false either way**; reject reason strings may prefer cheap codes — diagnose-compatible delta only.

## Observe-only risk metrics — honest scope

These are **not** three fully implemented production metrics. Scope:

1. **Max single-address buy share (5m)** — implemented from `buckets.buy_recipients`; UNKNOWN if none (not “0%”).  
2. **Creator net sell / balance** — **PLACEHOLDER / incomplete**: if only `creator` (deployer) is passed without verifiable net-sell + balance, status is always `UNKNOWN` (`complete:false`). Not claimed as a finished metric.  
3. **Quote loss breakdown** — quoter **fee+impact merged** when inseparable; label discloses **haircut is tracked separately** (`includes_haircut:false`). Haircut values are JSON-safe (`Number`/`string`, never raw `BigInt`). L1 allowance remains UNKNOWN/unavailable. Rejection paths without a plan still lack fee/impact evidence (marked unavailable).

No smart-money / safety-coin / profit scores. No extra heavy RPC beyond existing paths. No trade gates.

## Behavior change?

**Buy decisions: no.** Strategy `evaluateA/B/C` reasons and signal predicates unchanged (`NO_T` aggregate preserved). Exit rules, fees, FX 120s, positions, watch slots unchanged. No DB reset, no live trading, no worker restart, no Telegram spam from this PR.

### Documented deltas (diagnose-compatible)

1. `safetyScreen` gains `checks`; may omit `holderData` when cheap checks already failed. `ok` gating unchanged.  
2. `tryEnter` return gains optional additive `safety` / `plan` on reject paths (screening evidence only).  
3. `cycle` upserts `screening_evals` (bounded by unique key; monotonic merge).  
4. Account `reject_counts` still increments every cycle (legacy); **report** uses unique evals only.  
5. `screening-report` uses `openAbcReadonly` + `query_only` — no schema ensure.

## Current bottleneck ranking (from ABC_V7 + screening intent)

1. Continuous usable FX window (SOURCE_LAST_UPDATED_LAG / coverage catch-up)  
2. Graduation / consecutive-window warmups  
3. Strategy non-trigger with valid data  
4. Safety gates — not the explanation for historical mass NO_T

## Remaining gaps

- Production 24h funnel needs a worker that has written `screening_evals` after deploy; empty/not-started report expected until then.  
- Creator net-sell remains UNKNOWN/incomplete until deployer + verifiable sells + balance are plumbed.  
- Quoter fee vs impact cannot be split with current quoter outputs (merged by design; haircut disclosed separately).  
- Agent env may be Node 20 — offline `node:sqlite` verify requires Node ≥22.13.  
- No profitability claim; no threshold tuning for observe metrics.

## Pre-start checklist (ops)

1. Merge PR; do **not** reset `data/abc` or alter accounts.  
2. Checkout already has wired `abc.mjs` / `abc-collect.mjs` (no apply script).  
3. Deploy code; this PR does not restart workers.  
4. After process runs new code: `node abc.mjs screening-report`.  
5. Run `node abc-screening-verify.mjs` on Node ≥22.13.  
6. Telegram remains fills/halts only.

## Constraints honored

- Paper only; no live trading  
- No strategy trigger / fee / FX 120s / position / watch / exit rule edits  
- No DB reset / account mutation / worker restart / Telegram spam from delivery  
- No new dependencies  
- New fields backward compatible; old rows unknown; nothing fabricated  
- Diagnose-only for buy-affecting corrections  
- Report path read-only  
