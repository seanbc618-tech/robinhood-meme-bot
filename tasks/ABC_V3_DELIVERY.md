# ABC v3 运行复验修复

纸面模拟，非实盘。未改原模拟账户。无成交，未重置资金。

## 慢 RPC（不含 URL/key）

v2 单轮曾到 **2,275,158ms**（约 38 分钟），检查时仍有一轮 `last_started` 超过 1 小时。

定位：

| 方法 | 范围 | 原因 |
|---|---|---|
| `eth_getLogs` Swap（PoolManager，按 pool id） | 每池 `from=last_event+1` 到 head，旧 `LOG_CHUNK=10000` | v1 回补把游标打回 `first_seen`，单池可扫数万～二十万块 |
| `eth_getLogs` Transfer（代币地址） | 同上 | 与 Swap 成对，日志量更大（库内 transfer_events 24 万+） |
| `eth_getBlockByNumber` | 每个新 swap/transfer 的 block | 未命中 `blocks` 缓存时按条请求 |

`holderData` 从 genesis 拉 Transfer 只在入场 safety，本阶段 0 成交所以不是本轮主因。未放宽 120s 新鲜度。

## 修复（`abc-phase1-v3`）

1. **60s 退出与采集拆开**：每轮先 `block/rates/markAndExit`（`exits_ms`），再采集；采集截止 `COLLECT_BUDGET_MS=35000`；每池最多 `800` 块日志；`eth_getLogs`/`getBlock` 12s 超时；队列每轮 3 个；超时池 `collect_deferred` 下一轮继续。`rpc_profile` 只记 method、from/to、ms、条数。
2. **`writeRun` 改用 bigint-safe `stringify`**；`run.signals` 只存 slim 结果（`filled/qty/cash_out/loss_pct` 或 `skipped`）。补了真实 `cycle` 买入后 run 落库测试。
3. **invalid 旧桶保留，但不做新桶 `lastPrice` 种子**；缺桶保持缺失。
4. **策略窗口只读 `usd_usable=1`**。仅当 `rates.observed_at` 与该分钟结束时刻相差 ≤120s 才标可用（前向同时点 FX）。历史回补的 `NOT_HISTORICAL_FX` 桶隔离，不进 A/B/C 窗口。不能靠标签假装因果已满足。

`run.version` 仍标识同一 336h 实验；`code_version=abc-phase1-v3`。未再次执行 v1 游标回退。

## 验证

```
node --check abc-collect.mjs && node --check abc.mjs
node abc-repair-verify.mjs   # ALL_REPAIR_CHECKS_PASSED
node abc-verify.mjs          # ALL_OFFLINE_CHECKS_PASSED
```

新增：invalid 不污染下一根；非同时点 FX 不进 loadBuckets；writeRun BigInt；cycle 成交写 run；采集预算内停。

## 进程

- 原模拟 PID **47297** 未动
- ABC PID **84435**（v3），`started_at` 1788633484975 / `ends_at` 1789843084975 未改
- 观察一轮：`cycle_ms=48795`（<60s，`overrun=false`），`exits_ms=21855`，`analyzed=1`，`deferred=2`，`eth_getLogs 55586887-55587686` 约 1192ms
- 三账户现金 1000，成交 0
- 历史桶 `usd_usable=0`（2289），invalid 仍 16。策略 USD 窗口从现在起前向积累
- **真实买卖：无。不能验证盈利。**

## SHA256

```
61444e86cc11b9d2ed1bfb0339d4cd62acb6d9e7c7f18de15ebfc411ce83ec99  abc.mjs
992a78dbe8ab6f534eb16720a3783ac5058db62e27cea2c9bb7138cce2cbeba9  abc-collect.mjs
4aed9265a080490fc14322805eb3dd1b19f0b95cafb6cb5b9559395472774bf5  abc-repair-verify.mjs
```
