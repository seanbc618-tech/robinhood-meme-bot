# MEME_SCREENING_P0 Delivery

Diagnose-only meme screening P0 on top of merged GROK_SCREENING_V1 (PR #1).  
**Paper telemetry only — does not change buy/entry gates, fees, FX 120s, positions, watch slot TTL, or exit rules.**

## Summary

| Item | Status |
|---|---|
| Dual top10 metrics (`top10_raw` + `top10_ex_lp`) | Done (additive diagnose fields) |
| Gate `top10_circulating_bps` @ 6000 | **Unchanged** |
| Explicit `OBSERVING` funnel stage | Done (≠ AGE, ≠ generic DATA_INCOMPLETE) |
| Round-trip paper-size diagnostic evidence | Done (components disclosed; reject threshold **unchanged** at 5%) |
| Offline verify cases | Done (`abc-screening-verify-pr1.mjs` P0 block) |
| Worker restart / DB reset / live trading | **Not touched** |

## Files changed

| File | Change |
|---|---|
| `chain.mjs` | `holderData` summary gains additive `top10_raw_total_supply_bps`, `top10_ex_lp_*`, `infra_held_raw`, `lp_exclusion` — gate fields unchanged |
| `abc-screening-risk.mjs` | `dualTop10Concentration()`; `quoteLossBreakdown` gains `paper_size_diagnostic` + `gate_unchanged` |
| `abc-screening-funnel.mjs` | `OBSERVING` stage; additive `top10_raw`/`top10_ex_lp` checks in `buildSafetyChecks`; `SCREENING_VERSION=screening-v1-p0` |
| `abc-screening-upsert.mjs` | `risk.dual_top10` on each eval |
| `abc-screening.mjs` | Re-export `dualTop10Concentration` |
| `abc-safety-evidence.mjs` | Additive dual top10 diagnose checks (gate PASS/FAIL unchanged) |
| `abc-screening-report.mjs` | `OBSERVING` stage counts + funnel denominator |
| `abc-screening-verify-pr1.mjs` | OBSERVING classification + dual top10 + RT paper-size cases |
| `tasks/MEME_SCREENING_P0_DELIVERY.md` | This doc |

## Diagnose-only confirmation

1. **Top10 gate:** still `holders.summary.top10_circulating_bps` vs 6000 in `safetyScreen` / `buildSafetyEvidence` / `buildSafetyChecks`. New fields are `diagnose_only:true` and never flip `ok`.
2. **OBSERVING:** classification-only funnel stage for `WARMUP_LT_30_CONSECUTIVE` / `WINDOW_INCOMPLETE`. Strategy `evaluateA/B/C` reasons and signal predicates unchanged.
3. **RT cost:** `tryEnter` still rejects when `plan.loss_pct > 0.05`. Diagnostics add `paper_size_diagnostic` and disclose haircut vs merged quoter fee+impact — no threshold tighten/loosen.
4. No worker restart, no DB reset, no live trading enablement, no Telegram spam from this PR.

## Funnel stage rules (P0)

| Stage | Meaning |
|---|---|
| `AGE_INCOMPLETE` | Graduation-age only: `GRADUATION_TIME_UNKNOWN`, `WARMUP_GRADUATION_*`, or missing `gradTs` |
| `DATA_INCOMPLETE` | History/data warmups: `WARMUP`, `WARMUP_LT_120M`, `NO_T` detail |
| `OBSERVING` | Consecutive-minute / observation window incomplete: `WARMUP_LT_30_CONSECUTIVE`, `WINDOW_INCOMPLETE` |

Aligned with PR1: **WARMUP ≠ AGE**. P0 adds: **OBSERVING ≠ AGE** and **OBSERVING ≠ generic DATA_INCOMPLETE**.

## Dual top10 semantics

| Field | Meaning |
|---|---|
| `top10_raw` / `top10_raw_total_supply_bps` | Top10 of **all** positive balances (incl. identifiable LP/infra) / total supply |
| `top10_ex_lp` / `top10_ex_lp_circulating_bps` | Top10 excluding LP/infra / circulating_ex_infra (same basis as gate) |
| `lp_exclusion` | `OBSERVED` with addresses when identifiable; else `UNKNOWN` + reason — **never invent** |

Legacy payloads without additive fields: raw falls back to `top10_total_supply_bps` with an honest note; missing LP metadata → UNKNOWN when exclusion cannot be confirmed.

## How to verify

```bash
# Requires Node >=22.13 (node:sqlite). Offline temp sqlite only — no production DB.
node abc-screening-verify.mjs

# Read-only report (does not create schema / migrate / restart workers)
node abc.mjs screening-report
```

Pure dual-top10 / funnel smoke (no sqlite):

```bash
node --input-type=module -e "
import {dualTop10Concentration,quoteLossBreakdown} from './abc-screening-risk.mjs';
import {classifyFunnelStage} from './abc-screening-funnel.mjs';
console.log(dualTop10Concentration(null).top10_raw.status);
console.log(classifyFunnelStage({watched:true,ev:{reason:'WARMUP_LT_30_CONSECUTIVE'},gradTs:1}));
console.log(quoteLossBreakdown({initial:30,loss_pct:0.01,haircut_bps:50}).gate_unchanged);
"
```

## Remaining gaps (later — not this PR)

- **Entity merge** Top10 / HHI (Binance-style clustering) — P3 in research report
- **Wash / authenticity** diagnostics (both_sides_overlap, trades/traders) — P1
- **Social heat** — P4, diagnostic only
- Creator net-sell still UNKNOWN until deployer + sells + balance plumbed
- Quoter fee vs impact still merged (disclosed); L1 allowance UNKNOWN
- Production funnel needs a worker that has written `screening_evals` after deploy

## Constraints honored

- Diagnose / telemetry only
- No buy/entry gate threshold changes
- No fee / FX 120s / position / watch TTL / exit rule edits
- No DB reset / worker restart / live trading
- No new dependencies
- Prefer small, reviewable PR
