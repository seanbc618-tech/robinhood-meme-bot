# ABC v6：观察槽到期主键与生命周期

纸面模拟。未改生产 `seated_at` / 账户 / 结束时间。无真实交易。

## UNIQUE 复现与修复

`ensureWatchSlots` 只 `WHERE expires_at>?`，过期行仍占 `PRIMARY KEY slot`。TTL 后 `INSERT slot=1` 撞 UNIQUE。

临时库：入槽 → 推进 `now` 超过 `WATCH_MAX` → 归档 `watch_slot_history` → **UPDATE 原 slot**（不 INSERT 同主键）→ 换下一候选。再打开库不轮换。`node abc-repair-verify.mjs` 已复现并通过对应用例。

## 生命周期（不重置 seated_at）

- 最长保留 **36h**（`WATCH_MAX_MS`）
- 毕业+24h 后至少再观察 **2h**
- **120 根连续可用分钟**齐备前，不因刚满 24h 换出
- 到最长保留仍无 120 窗口 → `WATCH_EXPIRED_INCOMPLETE_WINDOW`（有界失败，不无限等）
- 生产槽 `0xBF99FE5B…`：`seated_at=1788663020596` 未改；`expires_at` 从 +24h 延到 +36h；`status=ACTIVE`

## 连续窗口（不放宽 FX）

生产固定池约 56 根 usd_usable，**最长连续仍 8**；12 次缺口。`minute_status` 仅见 **SOURCE_LAST_UPDATED_LAG ×12**（无 NO_FX_SNAP / OBSERVED_AT_LAG 计数）。54/56 分散桶 ≠ 连续 54 分钟。合成 30 桶仍只证明函数。

## 进程

- ABC PID **97929** `code_version=abc-phase1-v6`，`started_at`/`ends_at` 未改
- 三账户 1000，成交 0
- 原 24h 模拟进程若已结束不重启

```
c4785b95d2d3168c98518d8001879c3057f850caefb3b553a1f052ade84d382e  abc.mjs
1e5a5f6c0adb8577a777ef009ec0642c3a53c24236c3be2af5c34003d33a0c0c  abc-collect.mjs
```
