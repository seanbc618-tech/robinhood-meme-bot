# ABC v11: route-based paper costs

The user authorized replacing the cost model with chain-based estimates. The 5% entry cost cap, principal/spend limits, safety checks and freshness limits stay unchanged. Existing accounts, trades, holdings and experiment dates are preserved. New trade version is abc-phase1-v11; account model metadata changes without rewriting historical fills.

## Base calculation

- Use the existing stateful buy/approve/sell simulation and its actual token/quote deltas. Hook fees, creator taxes and pool impact are included in those deltas; do not subtract them again.
- Estimate execution cost from each simulated transaction's gasUsed, including intrinsic gas, multiplied by the supplied chain gas price. Include every approval in its respective buy/sell leg.
- Query NodeInterface.gasEstimateL1Component for each call's actual calldata and target block. Add that data-posting estimate once, in wei. Zero is accepted only when the node reports it; unavailable estimates reject the cost calculation.
- Remove the arbitrary 180,000-gas padding and both fixed dollar terms from the old max(0.25, execution)+0.25 formula. A quoter gas estimate alone is not an execution fee estimate.
- The base case uses zero fixed haircut. Explicit 50/150/300 bps scenarios remain as sensitivity diagnostics, not amounts automatically charged on every fill. Slippage minimums in simulated calls remain execution bounds, not assumed realized losses.
- Reuse the successful full simulation when checking entry; do not simulate twice. Store gas evidence, model version and applied haircut with the paper trade.

## Exit estimates

For paper holdings, simulate approvals and the exact sell quantity using an observed EOA holder with sufficient balance at the decision block. This uses ephemeral ETH funding in read-only simulation, never a signature, transaction broadcast or token-storage override. Persist candidate addresses with the position and verify code/balance before use. Existing positions without candidates obtain verified holder data. If no eligible representative exists, return unavailable rather than invent proceeds. This estimates a representative route's execution, not an actual user-wallet fill or sender-independent guarantee.

## Evidence and checks

Node eth_simulateV1 returned 21000 gas for a simple transfer, confirming intrinsic gas is included. NodeInterface is callable on the configured chain and returned both zero and nonzero L1 components at inspected blocks. Recent real swap receipts expose gasUsed/effectiveGasPrice; their gasUsedForL1 was zero in the initial six-receipt sample. Attempts to replay two unrelated historical aggregator transactions did not succeed, so they are not claimed as receipt-level calibration matches.

For the two historical v10 signals previously rejected at 6.56%/6.79%, isolated real route simulations produced about 2.80% total cost, with buy gas about $0.097, sell plus approvals about $0.149, and no fixed haircut. They then hit the unchanged USD_SOURCE_STALE guard under the historical FX evidence. These are diagnostic comparisons, not fills or profitability results. Missing data is not relabeled fresh.

Two earlier v8 signals with fresh historical FX were also replayed using the decision block base fee: total costs were 5.0484% and 5.0475%, including about $0.133 buy gas and $0.201 sell/approval gas. Both remained rejected by the unchanged 5% cap. Neither historical set produced an accepted isolated entry; end-to-end real-data ledger admission is therefore still unproven. Independent exact-quantity exit simulation succeeded on the v10 token, while ledger behavior is covered by existing offline checks.

Regression checks exercise fee-unit conversion without a dollar floor, missing execution evidence rejection, separate L1 counting, zero base haircut, explicit stress scenarios, ledger application and the existing safety/collection behavior. Standard commands: node abc-repair-verify.mjs; node abc-verify.mjs; node abc-screening-verify.mjs; git diff --check.

Sources: [Robinhood Chain](https://docs.robinhood.com/chain/), [Arbitrum gas estimation](https://docs.arbitrum.io/arbitrum-essentials/how-to-estimate-gas), [Geth eth_simulateV1](https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-eth). Fee estimates describe the modeled route at the queried state; they are not a guarantee of a later mined transaction's cost.
