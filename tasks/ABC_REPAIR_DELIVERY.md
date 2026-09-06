# ABC 一期验收修复交付（v2）

纸面模拟，非实盘。未改原 `data/paper.sqlite` / `data/sim-run`。无 ABC 成交，未重置资金。

## 先复现（v1）

`node abc-reproduce-v1.mjs` 在改代码前跑通：

- 12:00:20 → 12:01:20 → 12:02:20 游标跟 head 走，`rangeStart=minuteStart(startTs)+60`，**12:01 桶从未关闭**
- `signal_state` / `reject_counts` 只在内存，`readAccount` 冲掉
- 部分卖出后 `p.mark` 仍为卖出前全仓价值，现金+旧 mark 双计
- `JSON.stringify` 遇 BigInt 抛错

生产证据（修复前）：两池各仅 1 根分钟桶（`2026-09-05 18:45:00`），`last_cursor_block` 已到当时 head（如 55345950），后续分钟无法连续暖机。账户 `signal_state` 为空。

## 修复（`abc-phase1-v2`）

| 项 | 处理 |
|---|---|
| P0 桶游标 | 持久化 `swap_events`/`transfer_events`；按 `last_complete_minute` 关闭完整分钟；事务提交桶+事件游标；不把游标推过可复原边界 |
| P0 状态 | 每策略每次评估 `writeAccount`；买入后 `readAccount` 同步，禁止旧对象覆盖 |
| P1 B | 突破相对 **last60（t-60..t）** 高点；持久 `fired/armed`，跌回后才可再触发 |
| P0 净值 | 先全仓 mark → 算权益并持久化熔断 → 再退出；成交后按剩余 qty 重新报价 |
| P1 新鲜度 | 采集：区块+`observed_at`≤120s。开平仓提交前 `assertTradeFresh`：区块、`observed_at`、CoinGecko `last_updated_at` 均≤120s。超时拒绝落账，不暗改 |
| P1 负净额 | `net=usd-gas` 可负；估值 `mark=max(0,net)`；执行若 uneconomic 则跳过并留仓 |
| P1 classifyError | `method not found/not supported/not available` → `SOURCE_UNAVAILABLE`；仅归档截断等 → `INVALID_DECLARED_GAP` |
| C | 禁止同桶 low/high 自称先涨 30%；需后续分钟 high 相对先前 low |
| 队列 | 分析失败也更新 `last_analyzed_at` |
| JSON | `writeAccount` 用 bigint 安全 `stringify` |
| 停机 | 第二次 SIGTERM/SIGINT 在已 stopping 时 `process.exit(0)`，避免 RPC 挂死吞掉信号 |

v1 桶 **保留** 并 `invalid=1` + `v1_cursor_contaminated`。策略窗口不读 invalid。统计：`run.version` 仍为 `abc-phase1-v1`（同一实验身份），`code_version=abc-phase1-v2`。新成交 version 字段为 v2。无成交可混计。

桶 USD 用当轮汇率，`fx_note` 含 `NOT_HISTORICAL_FX`；不把今天汇率当历史真值。

## 验证

分别 `node --check`：`chain.mjs` `abc-collect.mjs` `abc.mjs` `abc-verify.mjs` `abc-repair-verify.mjs`

```
node abc-repair-verify.mjs   # ALL_REPAIR_CHECKS_PASSED
node abc-verify.mjs          # ALL_OFFLINE_CHECKS_PASSED
```

repair 套件含：相邻三轮 12:01 事件恰好一次且跨重启不重复；真实 `cycle` mock 两轮+重启 A 阶段；B 只破较早高点不买；买入/部分卖后净值=现金+剩余 mark；跨 120s 拒绝落账；tryEnter 成功落库；负 gas 留仓；失败池轮转。均在临时目录，不写正式账户合成成交。

## 备份

`data/abc-repair-backup/`：源码 + `VACUUM INTO` 的 SQLite 一致性快照（未直接复制活动 WAL）。

## 进程 / 结束时间 / 数据

- 原模拟 PID **47297** 仍在
- ABC：v1 PID 62530 在 hung RPC 中吞掉 SIGTERM（`stop.json` 已写仍不退出）。checkpoint 后 KILL，启动 v2 PID **64791**
- `started_at` **1788633484975** = 2026-09-05T18:38:04.975Z（未改）
- `ends_at` **1789843084975** = 2026-09-19T18:38:04.975Z（未改）
- 三账户现金 1000，成交 0，持仓 0
- 受影响数据：16 根 v1 分钟桶标 invalid；游标回退到 `first_seen_block-1` 以便回补漏分钟。回补依赖 RPC，交付观察时 `swap_events` 仍可能为 0（`SOURCE_UNAVAILABLE`）
- **真实买卖：无**

## SHA256（修复后工作副本）

```
10807722df651df075114a5cd0b358b52bd3c221d3178f04ab4be36dc9f6821f  abc.mjs
658b28ecf5ecd00c6bb5ec2f8e7a343a37c1be8534df71c6239ca64ddd2c48a6  abc-collect.mjs
31cdde8128960796856a750af09b362275d463b4ec1547d692d8247b59da02c7  abc-repair-verify.mjs
```

## 未完成

- v1 优雅停机未在一轮内完成（holder/getLogs 阻塞且 SIGTERM 被吞）。已在 v2 加二次信号退出
- v2 启动后首轮仍可能 RPC 失败；漏分钟回补尚未在生产上看到连续新桶。需 RPC 恢复后用 `SELECT token,minute FROM buckets WHERE invalid=0 ORDER BY token,minute` 核间距=60
- `holderData` 仍从 genesis 拉 Transfer，单池可能数分钟；未改这条链上路径
- 1.5%/3% 压力仍只是同块成本敏感性，不是完整因果重放
