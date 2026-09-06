# ABC v4：调度、直播观察与关桶边界

纸面模拟，非实盘。原模拟未动。无成交，资金未重置。

## 1. 按轮开始对齐 60s

`nextTickDeadline(tickStart)=tickStart+60000`。一轮 34s 则再等 26s，而不是结束后再 +60s。不重叠启动（等当前轮结束）。记录 `exit_tick_starts` / `exit_start_interval_ms`。

临时目录 10 拍调度测试通过。生产 PID 85506 约 11 分钟：14 个 tick，最近间隔多为 60009–60184ms；有一次 32226ms（上一轮超时后立即补拍，不重叠）。

## 2. 直播观察 vs 历史积压

177 个支持池、游标落后 7k–245k 块，每池 800 块追历史则永远没有同时点 FX 窗口。v4：

- **明确披露** `live_watch`：最新 8 个支持报价池 + 持仓，不是全目录
- 落后 >2000 块则 `LIVE_SUBSCRIBE_SKIP_BACKLOG` 写入 `coverage_gaps`，游标跳到 head−300，不补造跳过分钟、不把缺口当无交易完整 K 线
- 生产已记 8 条 gap

核算（约 10 block/s）：每池每轮最多 300 块 ≈ 30s 链；8 个直播池跟 head，不跟 245k 积压。历史缺口保持缺失、不可交易。

## 3. 先退出；RPC 预算与超时

`syncCatalog` 移到 `markAndExit` 之后，且每轮最多 4000 块、12s 超时。chunk 内逐条 `blockTs` 检查剩余 deadline。超时递增 `rpcEpoch`，过期 `getBlock` 不再写入 SQLite。一轮 <60s 不作压力证明。

观察：`cycle_ms=27796`，`exits_ms=3086`，`analyzed=3`。

## 4. 覆盖边界失败则停关桶

`last_event_block` 时间戳失败 → `SOURCE_UNAVAILABLE coverage_boundary`，不用 head 兜底。测试：游标滞后 + ts 失败 → 0 新桶。

## FX

`fxContemporaneous` 同时要求 `observed_at` 与报价币源 `last_updated_at`（ETH→ethereum，USDG→global-dollar）相对该分钟结束 ≤120s。

## 可用桶

- 离线：一池连续 30 根 `usd_usable=1` 通过
- 生产 11 分钟：仅 **1** 根同时点可用（`0x188F93f60B…` 02:22 UTC）。多数回补分钟因 `observed_at` 距分钟结束 >120s 标 `NOT_HISTORICAL_FX`。这是源新鲜度限制，不是把零可用桶说成有效实验。B 仍要 24h/120 根。WARMUP/拒绝已持久化。

## 进程

- 原模拟 **47297**
- ABC **85506** v4，`started_at`/`ends_at` 未改
- 三账户 1000，成交 0
- **真实买卖：无**

## 验证

`node abc-repair-verify.mjs` / `node abc-verify.mjs` 通过。

```
ee1139bf8546d55cee67d0549c733f584dd6a61e3fcba2d0960a6c6a1ffe72d8  abc.mjs
869821e55c890bfeef46767355a994e833d29975752cbca063e0de8111eb1221  abc-collect.mjs
de4d3e258fedc97a2ae7718ac2fe1707ed0df671b8e1481615e5ed3da46ed3db  abc-repair-verify.mjs
```
