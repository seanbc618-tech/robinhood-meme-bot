# ABC v5：固定观察槽与覆盖≥链增长

纸面模拟。原账户/结束时间保留。无真实交易。

## 根因（不把锅只甩给汇率）

- v4 每次按最新排序取 8 池，再 `slice(0,3)`，后 5 个永不服务；新池挤掉旧池，A/B 年龄到不了
- 实测 **9.91 blk/s → 每 60s 约 595 块**。每池每轮 300 块必落后，再跳 head−300 会周期性制造缺口

## 采集闭环（不改策略/不放宽 FX）

| 项 | v5 |
|---|---|
| 观察槽 | 固定 1 个（先验证再扩容），TTL **24h** 覆盖 B 年龄；满额新池排队。`watch_slots` 持久化 |
| 每轮覆盖 | `logBlocksNeeded = max(900, 1.5×链增速×60)`，chunk 仍 300（超时切片≠总覆盖） |
| 跳积压 | **仅入槽一次**；入槽后靠 900≥595 追上，不再周期跳 head |
| FX | 每轮写入 `fx_snap`（当前分钟和上一完整分钟）；关桶用该分钟快照，不用回补时新拉的汇率 |
| 缺因 | `minute_status`：`NO_FX_SNAP` / `OBSERVED_AT_LAG` / `SOURCE_LAST_UPDATED_LAG` / `NOT_COLLECTED` |

`live_watch.note` 写明 FIXED_WATCH n=1 ttl=24h，不是全目录。

## 验收

离线 `node abc-repair-verify.mjs` 通过（固定槽不替换、≥900 块、30 根合成可用分钟、缺边界不关桶）。合成 30 桶不证明生产。

生产 PID **89327**，约 32 分钟后：

- tick 间隔最近 10 次 **60055–60175ms**
- `cycle_ms=5080`，`exits_ms=2366`
- 固定槽 `0xBF99FE5B07FE544e085893CDA276aF9371Ae2266` 至 24h
- 该池 **16** 根 usd_usable=1：02:54–03:00 与 03:03–03:10；**03:02 与 03:11 为 SOURCE_LAST_UPDATED_LAG**（缺口 120s，已记录，未当可用）
- 其后 RPC 失败，游标落后约 5630 块；900 块/轮可追，但 **尚未形成无 gap 的连续 30 分钟**
- 三账户 1000，成交 0；`started_at`/`ends_at` 未改；原模拟 47297 未动

**未完成：** 生产固定池「连续 30 分钟有效桶且无 gap」。最长无 gap 段 8 分钟。进程继续跑以积累窗口。B 仍需 24h。

```
28bc0098b45f63d154f12d65cce19f77c2dbe884e73c30cb10acf94fa20ac8eb  abc.mjs
071ba08ef78fb9fbc7fd1ea386fb7ed030875c135276b44f34f50346edc9490a  abc-collect.mjs
```
