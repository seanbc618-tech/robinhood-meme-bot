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
| `node abc.mjs screening-report` | Done (after apply) |
| Verify cases | Done (`abc-screening-verify.mjs`) |
| Buy / trigger / fee / FX 120s / positions / watch / exit unchanged | Yes (see deltas) |

## Files changed

| File | Change |
|---|---|
| `abc-screening.mjs` | **New** barrel — schema, `buildSafetyChecks`, `recordEvalFromCycle`, `screeningReport`, version |
| `abc-screening-not.mjs` | **New** — NO_T detail diagnosis from buckets / minute_status / coverage_gaps / fx_snap |
| `abc-screening-risk.mjs` | **New** — observe-only risk metrics (no trade decisions) |
| `abc-screening-verify.mjs` | **New** — focused offline verify cases (temp DB) |
| `patches/abc-screening-abc.mjs.patch` | Unified diff wiring `abc.mjs` |
| `patches/abc-screening-collect.mjs.patch` | Unified diff wiring `abc-collect.mjs` |
| `patches/abc.mjs.zlib.b64` | Optional full-file payload for `abc.mjs` |
| `patches/abc-collect.mjs.zlib.b64` | Optional full-file payload for `abc-collect.mjs` |
| `scripts/apply-grok-screening-patches.mjs` | Applies unified diffs (or zlib payloads) onto stock main files |
| `abc.mjs` / `abc-collect.mjs` | Wired after apply (import/schema/`screening-report`/safety evidence) — buy gates unchanged |
| `tasks/GROK_SCREENING_V1_DELIVERY.md` | This doc |

## Apply wiring (required once after checkout)

GitHub MCP size limits made large full-file rewrites awkward; stock `abc.mjs` / `abc-collect.mjs` on the branch are patched locally via:

```bash
node scripts/apply-grok-screening-patches.mjs
# Prefer: patches/*.zlib.b64 full payloads when present
# Else: applies patches/*.patch against current stock abc*.mjs
```

Re-run only on clean main-line copies of those two files (or restore them first). Diffs were verified to apply cleanly onto `main`.

## How to run

```bash
node scripts/apply-grok-screening-patches.mjs   # once after pull if abc*.mjs not already patched
node abc-screening-verify.mjs                  # offline focused cases (temp sqlite)
node abc.mjs screening-report                  # last-24h unique-eval A/B/C funnel
```

Requires Node `>=22.13` (`node:sqlite`). Does **not** touch production DBs beyond `CREATE IF NOT EXISTS screening_evals` / upserts when the worker cycle runs.

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
| `NO_VALID_PRICE` | Bucket exists but no usable `close_usd` |
| `NOT_IN_WATCH` | Not seated/held — **not** counted as screening reject |

## Safety evidence order

1. phase2  
2. liquidity  
3. supported quote (WETH/zero \| USDG)  
4. holder_count (≥15)  
5. top10_circulating_bps (≤6000; denominator = circulating ex-infra)  
6. round-trip loss ≤5% — **deferred** until entry (`UNKNOWN` / `ROUND_TRIP_DEFERRED_UNTIL_ENTRY` in screen-only evidence)

Cheap checks first. Heavy `holderData` skipped when cheap already failed (RPC save). **`ok` remains false either way**; reject reason strings may prefer cheap codes — diagnose-compatible delta only.

## Observe-only risk metrics (not used for trades)

1. **Max single-address buy share (5m)** — attributable external buy USD; UNKNOWN if none (not “0%”).  
2. **Creator net sell / balance** — UNKNOWN unless creator + verifiable sell + balance exist.  
3. **Quote loss breakdown** — quoter fee+impact merged when inseparable; never treats `pool.liquidity` as USD depth.

No smart-money / safety-coin / profit scores. No extra heavy RPC beyond existing paths.

## Behavior change?

**Buy decisions: no.** Strategy `evaluateA/B/C` reasons and signal predicates unchanged (`NO_T` aggregate preserved). Exit rules, fees, FX 120s, positions, watch slots unchanged. No DB reset, no live trading, no worker restart, no Telegram spam from this PR.

### Documented deltas (diagnose-compatible)

1. `safetyScreen` gains `checks`; may omit `holderData` when cheap checks already failed. `ok` gating unchanged.  
2. `tryEnter` return gains optional additive `safety`.  
3. `cycle` upserts `screening_evals` (bounded by unique key).  
4. Account `reject_counts` still increments every cycle (legacy); **report** uses unique evals only.

## Current bottleneck ranking (from ABC_V7 + screening intent)

1. Continuous usable FX window (SOURCE_LAST_UPDATED_LAG / coverage catch-up)  
2. Graduation / consecutive-window warmups  
3. Strategy non-trigger with valid data  
4. Safety gates — not the explanation for historical mass NO_T

## Remaining gaps

- Production 24h funnel needs a worker that has written `screening_evals` after deploy; empty report expected until then.  
- Creator net-sell usually UNKNOWN until deployer is plumbed with verifiable sells.  
- Quoter fee vs impact cannot be split with current quoter outputs (merged by design).  
- Agent env is Node 20 — offline `node:sqlite` verify not executed here; run on Node ≥22.13.  
- If merge tooling expects already-patched `abc.mjs`/`abc-collect.mjs` in-tree, run apply script (or inflate zlib) before merge / CI.  
- No profitability claim; no threshold tuning for observe metrics.

## Pre-start checklist (ops)

1. Merge PR; do **not** reset `data/abc` or alter accounts.  
2. Ensure `abc.mjs` / `abc-collect.mjs` are patched (`node scripts/apply-grok-screening-patches.mjs`).  
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
