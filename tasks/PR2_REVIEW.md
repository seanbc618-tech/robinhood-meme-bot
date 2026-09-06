# PR2_REVIEW — MEME_SCREENING_P0 (user review)

Review of https://github.com/seanbc618-tech/robinhood-meme-bot/pull/2 on `feat/meme-screening-p0`.

Diagnose-only still; do **not** change buy gates. Do **not** merge until fixes land and are re-reviewed.

## Findings

### P1 Top10 mislabel

In `abc-safety-evidence.mjs` / `dualTop10Concentration` (likely `abc-screening-p0-metrics.mjs`):

- Do **NOT** copy legacy `top10_total_supply_bps` into `top10_raw_*` and then claim `includes_lp=true`.
- `dualTop10Concentration` must honor `top10_raw_includes_lp=false` (and never invent `includes_lp=true` from a legacy field alone).
- Current chain computes legacy numerator **AFTER** removing infrastructure — so treat legacy as **ex-infra / circulating-style**, NOT “raw including LP”.
- Options: keep true raw UNKNOWN until separately calculated, OR expose a clearly named legacy diagnostic (e.g. `top10_ex_infra_total_supply_bps`) without calling it raw-including-LP.
- Never infer observed LP exclusion merely from a legacy numeric field.
- Add test for the **real safety-to-metric fallback path** with `{top10_raw_total_supply_bps:2000,top10_raw_includes_lp:false,top10_circulating_bps:4000}` expecting `includes_lp` false / honest labeling — not only artificial additive fields.

### P1 fee/impact haircut labeling

`quoteLossBreakdown`: `principal-(plan.recovered+plan.sellGas)` only removes gas; `recovered` already reflects buy-haircut-reduced qty + sell haircut. So the loss **includes haircut effects**. Fix `includes_haircut:false` and any “Does NOT include execution haircut” copy — label combined quoter+haircut loss honestly, OR compute a real decomposition (not guessed from bps alone). Do not double-count combined amount + separate haircut. Test with actual `plannedRoundTripFromQuotes` path and nonzero haircut.

### P2 complete flag

`complete:true` must not be unconditional for any non-null plan (`{}` / missing amounts → incomplete/UNKNOWN). Tests assert this.

## Delivery / process

- Commit this review text as `tasks/PR2_REVIEW.md`.
- Update `tasks/MEME_SCREENING_P0_DELIVERY.md` briefly after fixes.
- Keep PR diagnose-only; no buy/entry gate threshold changes.
