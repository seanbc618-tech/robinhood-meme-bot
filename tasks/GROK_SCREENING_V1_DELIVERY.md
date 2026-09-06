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
| `abc-screening-verify-pr1.mjs` | PR1 regressions: BigInt JSON, funnel stages, readonly report, monotonic upsert, creator UNKNOWN |
| `abc.mjs` | Thin CLI barrel — `screening-report` via `openAbcReadonly` (no ensure/migrate) |
| `abc-paper.mjs` / `abc-strategy.mjs` / `abc-entry.mjs` / `abc-runtime.mjs` | Split wired ABC (tryEnter safety/plan; cycle `recordEvalFromCycle`) — strategy triggers unchanged |
| `abc-collect-readonly.mjs` | `openAbcReadonly` (`readOnly` + `query_only ON`, no schema/migrate) |
| `abc-safety-evidence.mjs` | Diagnose `safetyScreen` + `buildSafetyEvidence` (buy gates same; cheap-fail skips holders) |
| `abc-collect.mjs` | Unchanged stock collect (schema via `ensureScreeningSchema` on cycle only) |
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

## Observe-only risk metrics — honest scope

These are **not** three fully implemented production metrics. Scope:

1. **Max single-address buy share (5m)** — implemented from `buckets.buy_recipients`; UNKNOWN if none (not “0%”).
2. **Creator net sell / balance** — **PLACEHOLDER / incomplete**: if only `creator` (deployer) is passed without verifiable net-sell + balance, status is always `UNKNOWN` (`complete:false`). Not claimed as a finished metric.
3. **Quote loss breakdown** — quoter **fee+impact merged** when inseparable; label discloses **haircut is tracked separately** (`includes_haircut:false`). Haircut values are JSON-safe (`Number`/`string`, never raw `BigInt`). L1 allowance remains UNKNOWN/unavailable. Rejection paths without a plan still lack fee/impact evidence (marked unavailable).

No smart-money / safety-coin / profit scores. No extra heavy RPC beyond existing paths. No trade gates.

## Behavior change?

**Buy decisions: no.** Strategy `evaluateA/B/C` reasons and signal predicates unchanged (`NO_T` aggregate preserved). Exit rules, fees, FX 120s, positions, watch slots unchanged. No DB reset, no live trading, no worker restart, no Telegram spam from this PR.

### Documented deltas (diagnose-compatible)

1. `safetyScreen` (via `abc-safety-evidence.mjs`) gains `checks`; may omit `holderData` when cheap checks already failed. `ok` gating unchanged.
2. `tryEnter` return gains optional additive `safety` / `plan` on reject paths (screening evidence only).
3. `cycle` upserts `screening_evals` (bounded by unique key; monotonic merge).
4. Account `reject_counts` still increments every cycle (legacy); **report** uses unique evals only.
5. `screening-report` uses `openAbcReadonly` + `query_only` — no schema ensure.

## Remaining gaps

- Production 24h funnel needs a worker that has written `screening_evals` after deploy; empty/not-started report expected until then.
- Creator net-sell remains UNKNOWN/incomplete until deployer + verifiable sells + balance are plumbed.
- Quoter fee vs impact cannot be split with current quoter outputs (merged by design; haircut disclosed separately).
- Agent env may be Node 20 — offline `node:sqlite` verify requires Node ≥22.13.
- Stock `abc-collect.mjs` safetyScreen is untouched; entry path uses `abc-safety-evidence.mjs` (same buy gates).
- No profitability claim; no threshold tuning for observe metrics.

## Constraints honored

- Paper only; no live trading
- No strategy trigger / fee / FX 120s / position / watch / exit rule edits
- No DB reset / account mutation / worker restart / Telegram spam from delivery
- No new dependencies
- New fields backward compatible; old rows unknown; nothing fabricated
- Diagnose-only for buy-affecting corrections
- Report path read-only
