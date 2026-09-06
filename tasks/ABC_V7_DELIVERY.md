# ABC v7：v5 复验 + 采集不被目录饿死

纸面模拟。未改 `started_at`/`ends_at`/`seated_at`/账户。无真实交易。不放宽 FX。

## v5 评审两项代码（v6 已落地，本轮复验仍成立）

`ensureWatchSlots` 到期归档 `watch_slot_history` 后 **UPDATE 原 slot**，不 INSERT 同主键。临时库：过 TTL 归档再入座无 UNIQUE；再打开不轮换。

生命周期：最长 **36h**；毕业+24h 后再观察 **2h**；**120 根连续可用分钟**齐备前不因刚满 24h 换出；到最长保留仍无窗口 → `WATCH_EXPIRED_INCOMPLETE_WINDOW`。生产槽 `0xBF99FE5B…`：`seated_at=1788663020596` 未改，`expires_at` 仍为 seated+36h，`status=ACTIVE`，history=0。

`node abc-repair-verify.mjs` / `node abc-verify.mjs` 均 `ALL_*_PASSED`。

## 卡住连续窗口的新确定性缺陷（本轮修）

v6 生产：`analyzed=0`、`rpc_profile=[]`，`last_event_block` 长时间停在同一高度。根因不是放宽 FX 能解决的：

- `eth_getLogs` 走公开 log RPC，`retryCount=0`
- 每轮 **先** `syncCatalog` 最多 4000 块（约 28 次 getLogs），把配额打满
- 随后观察槽 `collectBuckets` 第一次 getLogs 失败即整轮抛出，**已提交的游标也不折桶**；下一轮目录再次抢先，游标实质上饿死

复现：临时库 `getLogs` 第一次抛 `RPC Request failed.`，旧代码游标不动。修复后重试并前进。

`cycle` 顺序改为：**退出 → 固定槽采集/分析 → 目录**。目录每轮上限改为 **900 块**（与观察槽同量）。getLogs 失败重试 3 次；仍失败才记 `coverage_gaps` 并抛出，**不跳 head**。

## 连续窗口（不放宽 FX）

生产固定池 `usd_usable` **61**，**最长连续 13**（不是 61）。截断原因：

| 原因 | 计数 |
|---|---|
| NO_FX_SNAP | 0 |
| OBSERVED_AT_LAG | 0 |
| SOURCE_LAST_UPDATED_LAG | 12 |
| 本轮新 SOURCE_UNAVAILABLE 分钟缺口 | 0（重试后采集在前进） |

12 次 `SOURCE_LAST_UPDATED_LAG` 相对分钟结束超 120s（约 130–140s），已记 `minute_status`，不当可用。合成 30 桶只证明函数。

v7 重启后：`analyzed=1`，`rpc_profile` 3 段 300 块；`last_event_block` 55678833→55679733（+900）；`last_complete_minute` 前进 2 分钟。 lag 仍约数万块，靠 900/轮追，不跳积压。

## 进程

- ABC PID **98766** `code_version=abc-phase1-v7`
- `started_at=1788633484975` `ends_at=1789843084975` 未改
- 三账户 1000，成交 0
- 原 24h 模拟未运行，不重启

```
c632e937af55b3b76aded199f3ef936c79742f72f590b03686d6155ff3dcf591  abc.mjs
088187ecc4d0c6d47472b0ed35fad0d7eae3affefb8586d0d93c7aa8c5b1b51c  abc-collect.mjs
f9d19618888b906ae5b6c4eb6eb4b2c70d631617a081f914f8eae2cc4656a6d0  abc-repair-verify.mjs
```

**未完成：** 生产固定池连续 30 分钟无 gap。进程继续跑以积累窗口；不把分散可用桶当成连续证据。
