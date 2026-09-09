# ABC v12: round-trip cost gate raised to 8%

The user explicitly authorized raising the entry round-trip cost cap from 5% to 8% after
seeing the measured distribution. Nothing else moves: principal and spend limits, the
safety checks, the 120-second live freshness limit, the strategy rules and the v11 cost
model are unchanged. Accounts, holdings, trades and experiment dates are preserved.

## Evidence behind the change

Eight strategy signals were recorded in the 24 hours to 2026-09-09 04:00 UTC. Five reached
a priced round trip at the configured $30 paper principal:

| Time (UTC) | Strategy | Token | Round-trip cost | Old 5% gate |
|---|---|---|---|---|
| 09-08 09:23 | C | 0x88B694d6 | 6.56% | reject |
| 09-08 09:38 | C | 0x88B694d6 | 6.79% | reject |
| 09-08 22:27 | A | 0xb47efCc4 | 4.70% | pass |
| 09-09 00:15 | C | 0x326722C4 | 10.46% | reject |
| 09-09 03:03 | C | 0x61752da5 | 6.61% | reject |

Cost composition for the 09-09 03:03 signal: $1.99 total on a $30.09 position, of which
about $1.77 is the merged quoter fee and price impact and about $0.25 is gas across the
buy, sell and approval legs. The cost is therefore dominated by pool fee and impact, not
gas, so a larger position does not improve the ratio — impact grows with size.

At 8% the first, second and fifth rows admit; the 10.46% row still rejects.

## What this costs

Every admitted entry now starts up to 8% underwater on a round trip. Against strategy A's
+25% first target that is close to a third of the move, and C's exits must clear the same
drag before its 2x recovery and 10x tail rules mean anything. This is an explicit
risk-for-frequency trade the user chose; it is not a modeling improvement.

## Implementation

- `ROUND_TRIP_LOSS_MAX` is exported from `abc-collect.mjs` and is now the single source of
  the cap. `abc-entry.mjs`, `abc-screening-funnel.mjs`, `abc-safety-evidence.mjs` and
  `abc-screening-p0-metrics.mjs` all read it instead of repeating a literal.
- The reject code becomes `ROUND_TRIP_COST_OVER_GATE`. Historical
  `ROUND_TRIP_COST_OVER_5_PERCENT` counters stay in the accounts as evidence of what the
  old cap rejected; they are not rewritten.
- Diagnostic blocks report `gate_threshold_pct` from the same constant, so screening
  evidence and the live gate cannot drift apart.

Regression checks: node abc-repair-verify.mjs; node abc-verify.mjs; node abc-screening-verify.mjs; git diff --check.
