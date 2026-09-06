# MEME_SCREENING_P0 Delivery

Diagnose-only meme screening P0 on top of merged GROK_SCREENING_V1 (PR #1).
**Paper telemetry only — does not change buy/entry gates, fees, FX 120s, positions, watch slot TTL, or exit rules.**

## Summary

| Item | Status |
|---|---|
| Dual top10 metrics (`top10_raw` + `top10_ex_lp`) | Done (additive diagnose fields) |
| Gate `top10_circulating_bps` @ 6000 | **Unchanged** |
| Explicit `OBSERVING` funnel stage | Done (!= AGE, != generic DATA_INCOMPLETE) |
| Round-trip paper-size diagnostic evidence | Done (components disclosed; reject threshold **unchanged** at 5%) |
| Offline verify cases | Done (`abc-screening-verify-pr1.mjs` P0 block) |
| Worker restart / DB reset / live trading | **Not touched** |

## Files changed

| File | Change |
|---|---|
| `abc-screening-p0-metrics.mjs` | **NEW** — `dualTop10Concentration` + enhanced `quoteLossBreakdown` (`paper_size_diagnostic`, `gate_unchanged`) |
| `abc-screening-risk.mjs` | Slim barrel: re-exports P0 metrics; keeps attributedBuy/maxBuyShare/creator |
| `abc-screening-funnel.mjs` | `OBSERVING` stage; additive `top10_raw`/`top10_ex_lp` checks; `SCREENING_VERSION=screening-v1-p0` |
| `abc-screening-upsert.mjs` | `risk.dual_top10` on each eval |
| `abc-screening.mjs` | Re-export `dualTop10Concentration` |
| `abc-safety-evidence.mjs` | Dual top10 diagnose checks + enrich summary with `lp_exclusion` from infrastructure (gate unchanged) |
| `abc-screening-report.mjs` | `OBSERVING` stage counts + funnel denominator |
| `abc-screening-verify-pr1.mjs` | OBSERVING + dual top10 + RT paper-size cases |
| `abc-screening-verify-p0-smoke.mjs` | Optional offline smoke (needs Node that can load collect/sqlite) |
| `tasks/MEME_SCREENING_P0_DELIVERY.md` | This doc |

## Diagnose-only confirmation

1. **Top10 gate:** still `holders.summary.top10_circulating_bps` vs 6000 in `safetyScreen` / `buildSafetyEvidence` / `buildSafetyChecks`. New fields are `diagnose_only:true` and never flip `ok`.
2. **OBSERVING:** classification-only funnel stage for `WARMUP_LT_30_CONSECUTIVE` / `WINDOW_INCOMPLETE`. Strategy `evaluateA/B/C` reasons and signal predicates unchanged.
3. **RT cost:** `tryEnter` still rejects when `plan.loss_pct > 0.05`. Diagnostics add `paper_size_diagnostic`; residual from recovered is labeled **includes_haircut:true** (combined quoter+haircut; haircut_bps is rate disclosure only) — no threshold tighten/loosen.
4. No worker restart, no DB reset, no live trading enablement, no Telegram spam from this PR.

## Funnel stage rules (P0)

| Stage | Meaning |
|---|---|
| `AGE_INCOMPLETE` | Graduation-age only: `GRADUATION_TIME_UNKNOWN`, `WARMUP_GRADUATION_*`, or missing `gradTs` |
| `DATA_INCOMPLETE` | History/data warmups: `WARMUP`, `WARMUP_LT_120M`, `NO_T` detail |
| `OBSERVING` | Consecutive-minute / observation window incomplete: `WARMUP_LT_30_CONSECUTIVE`, `WINDOW_INCOMPLETE` |

Aligned with PR1: **WARMUP != AGE**. P0 adds: **OBSERVING != AGE** and **OBSERVING != generic DATA_INCOMPLETE**.

## Dual top10 semantics

| Field | Meaning |
|---|---|
| `top10_raw` | True raw-with-LP **only** when `top10_raw_total_supply_bps` present **and** `top10_raw_includes_lp===true`. Otherwise UNKNOWN or honest `includes_lp:false` (never invent includes_lp from legacy alone). |
| `top10_ex_infra_total_supply_bps` | Legacy/diagnostic ex-infra top10 / total_supply (chain removes infra before numerator). **Not** raw-including-LP. |
| `top10_ex_lp` | `top10_ex_lp_circulating_bps` / `top10_circulating_bps` (circulating_ex_infra; same basis as gate) |
| `lp_exclusion` | Attached from `holderData.infrastructure` when available; else `UNKNOWN` + reason — **never invent** from legacy numeric fields |

## PR2 review fixes (labeling honesty)

| Item | Fix |
|---|---|
| P1 Top10 mislabel | Stop copying legacy into `top10_raw_*` as raw-including-LP; honor `top10_raw_includes_lp=false`; expose `top10_ex_infra_total_supply_bps` |
| P1 haircut residual | `quoteLossBreakdown` residual sets `includes_haircut:true` (recovered embeds haircuts); no “excludes haircut” copy; do not double-count |
| P2 complete flag | `complete:true` only when plan amounts finite; `{}` / partial → `complete:false` / UNKNOWN |
| Review artifact | `tasks/PR2_REVIEW.md` |

## How to verify

```bash
# Requires Node >=22.13 (node:sqlite). Offline temp sqlite only — no production DB.
node abc-screening-verify.mjs

# Read-only report (does not create schema / migrate / restart workers)
node abc.mjs screening-report
```

## Remaining gaps (later — not this PR)

- **Entity merge** Top10 / HHI (Binance-style clustering) — P3 in research report
- **Wash / authenticity** diagnostics (both_sides_overlap, trades/traders) — P1
- **Social heat** — P4, diagnostic only
- Creator net-sell still UNKNOWN until deployer + sells + balance plumbed
- Quoter fee vs impact still merged (disclosed); L1 allowance UNKNOWN
- Production funnel needs a worker that has written `screening_evals` after deploy
- True `top10_raw` including LP balances in the numerator awaits optional `chain.mjs` additive fields (`top10_raw_total_supply_bps` + `top10_raw_includes_lp:true` from all-positive balances); legacy stays under `top10_ex_infra_total_supply_bps`; raw stays UNKNOWN / includes_lp=false until then

## Constraints honored

- Diagnose / telemetry only
- No buy/entry gate threshold changes
- No fee / FX 120s / position / watch TTL / exit rule edits
- No DB reset / worker restart / live trading
- No new dependencies
- Prefer small, reviewable PR
