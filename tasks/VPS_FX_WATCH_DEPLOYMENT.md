# FX evidence and two observation slots

Paper only. Existing balances, positions, run dates and history must be retained.

- Preserve each FX observation in `fx_observations`; read legacy `fx_snap` as well. Select a qualifying observation independently for ETH/USDG. Both observation time and source update time must remain within 120 seconds of minute end. No invented prices or retrospective rewrite of closed buckets. An upstream source that supplies no fresh quote still produces a declared gap.
- Slot 1 retains the existing A/B pool and its seated time. Slot 2 admits a known graduation age below 5.5 hours, allowing time for C's 30-minute window, and expires at age 6 hours. If no distinct eligible pool exists it stays empty. Strategy thresholds are unchanged.
- Alternate unheld collection order within the existing shared budget. Held positions keep exit priority. Hourly Telegram summaries show each slot's lag separately and exclude C's over-age rejection from effective evaluation counts.

Regression checks: `node abc-repair-verify.mjs`, `node abc-verify.mjs`, `node abc-screening-verify.mjs`. The collection-budget fixture now supplies graduation evidence so that it exercises multiple eligible slots.

## VPS operation

Use a reviewed Git archive in a new release directory, Node >=22.13 and `npm ci`. Keep `.env.rpc`, `.env.telegram`, and data outside Git, mode 600 for credentials. Stop the Mac worker before the final database and Telegram deduplication transfer. Verify database integrity, unchanged account state and run dates before starting the VPS worker. Do not run two workers for the same experiment.

The existing `node abc.mjs start 336` command resumes persisted dates and detaches from SSH. `node abc.mjs status` is read-only. `node abc.mjs stop` requests a graceful stop. This deployment does not install a system service, so host reboot requires an explicit restart.

Acceptance requires advancing cursors and fresh usable minutes on the VPS. Passing offline checks or a running PID does not establish continuous windows, paper fills, or profitability.
