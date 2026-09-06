# PR1_REVIEW — GROK_SCREENING_V1 (user review)

Review of https://github.com/seanbc618-tech/robinhood-meme-bot/pull/1 on `grok/screening-v1`.

## Findings

1. **P1** `scripts/apply-grok-screening-patches.mjs` / `patches/abc.mjs.zlib.b64`: documented default command fails `Z_DATA_ERROR` (corrupted zlib payload). Remove compressed payload and commit actual wired source changes to `abc.mjs` / `abc-collect.mjs` so a normal checkout works. Reviewers must see real diffs; do not require post-merge mutation of tracked files. If using patches at all, only correct unified diffs that are already verified — prefer fully wired files.

2. **P1** BigInt `JSON.stringify` failure on `haircut_bps` in `quoteLossBreakdown` / `upsertScreeningEval`. BigInt must not go through plain `JSON.stringify`. Use safe JSON values (Number/string) or a BigInt-safe serializer. Add verification covering planned-entry → `screening_evals`/report without throw.

3. **P1** `classifyFunnelStage` maps `startsWith(WARMUP)` to `AGE_INCOMPLETE` before specific WARMUP/data conditions — misclassification. Distinguish graduation-age vs missing/incomplete data windows. `WARMUP_LT_30_CONSECUTIVE`, `WARMUP`, `WARMUP_LT_120M` are data/window issues, not age. Add tests for stage + funnel denominators.

4. **P1** `screening-report` not read-only: opens via `openAbc` (schema/migrate) and `ensureScreeningSchema` before reads. Must open DB with `readOnly: true` and `query_only ON` before any reads. No ensure schema / migrations / init. If schema absent → empty/not-started report. Preserve caller's `query_only`. Test: empty DB table count unchanged; existing read-only connection OK.

5. **P2** Repeat-eval upsert funnel inconsistency: overwrites `has_signal`/`funnel_stage` while retaining `paper_filled=max` in a way that loses signal but keeps fill. Preserve original entry evidence / monotonic stages, OR separate first-eval vs outcomes with stable id. Test: same-minute signal+fill then no-signal update stays consistent.

## Other incomplete

- Creator risk always UNKNOWN if only creator passed (mark as incomplete placeholder, not a fully implemented metric).
- Roundtrip-failed / fee-rejected paths missing safety/plan evidence.
- Quote fee+impact merged label must disclose haircuts included (or that haircut is tracked separately).

Complete where easy, or clearly mark placeholders/unavailable rather than claiming three fully implemented metrics. Update `tasks/GROK_SCREENING_V1_DELIVERY.md` accordingly.
