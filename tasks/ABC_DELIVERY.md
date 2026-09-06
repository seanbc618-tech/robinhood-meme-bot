# ABC 一期交付（2026-09-06）

纸面模拟，非实盘。未签名、未广播、未读私钥、未改原 `data/paper.sqlite` / `data/sim-run`，原 worker PID 47297 仍在运行。

## 修改清单

| 文件 | 作用 |
|---|---|
| `abc-collect.mjs` | 新增。持久化池目录、1 分钟桶、报价/费用模型、120s 新鲜度 |
| `abc.mjs` | 新增。A/B/C 独立账户、退出、CLI、进程锁、Telegram（ABC PAPER） |
| `abc-verify.mjs` | 新增。离线关键用例；写入临时目录，不写 `data/abc` |
| `chain.mjs` | 最小导出：`factoryAbi`/`hookAbi`/`swapEvent`/`blockAtTime`/`holderData`，并登记 `PoolGraduated`。旧 `check/discover/quote/simulate` 入口不变 |
| `paper.mjs` `sim-run.mjs` `telegram.mjs` | 未改 |

备份（修改前原文）在 `data/abc-source-backup/`。新数据只在 `data/abc/`。

## SHA256

修改前（备份）：

```
982b5cef53f6896592ea3981eff27c5877ae8957c725e0ec83f6e5f15b05c76a  chain.mjs
3f9f710b906dd3f093728455387d37322942db5014694753980d80dc64f9bc9d  paper.mjs
93582fa840f29154331187eeacf95d56ce3d2c8ecf3f7d62b85d111824fe5269  sim-run.mjs
c57e891b049a4bd793696154f6389ed9ef676086eb4d3aad12018b103f54db5c  telegram.mjs
```

交付时工作副本：

```
f3fc2d4b158ba604195f47b0f32e4b6da08089dedbedcaea54c5241e688183e8  chain.mjs
0d07c933e663a64df2252e0c7d80235bfcfdcd15c42d392359135fd4c111f59d  abc.mjs
b1bda6282abb56f26bb7ea75f48354d34bd1c1adcda2a8cc0ab2b7c55746aeb9  abc-collect.mjs
6183d7a17fbd8797f0c629db9eb9545cb3e9f3efd847deb3d6d21acdbada6147  abc-verify.mjs
```

`paper.mjs` / `sim-run.mjs` / `telegram.mjs` 与备份一致。

## 命令与输出摘要

```
node --check chain.mjs abc-collect.mjs abc.mjs abc-verify.mjs
node abc-verify.mjs
# ALL_OFFLINE_CHECKS_PASSED

node abc.mjs start 336
# ABC paper simulation dispatched, PID 62530
# （首次 PID 62222 因汇率 last_updated 常 >120s 整轮失败；修正后重启，保留原 started_at/ends_at 与三账户）

node abc.mjs status
node abc.mjs report
node abc.mjs stop   # 当前不要执行；会在本轮结束后停
```

离线验收通过：A 突破回踩/失效；B 窗口排除当前 K 线；C 阶段序列；止损/超时/部分止盈只一次；回本后 10 倍半仓只一次；120s 陈旧报价拒绝；账户隔离；现金与数量守恒；重启恢复；费用门槛拒绝；源故障 equity=null；双进程锁。模拟数据未写入 `data/abc`。

## 运行 PID / 结束时间 / 数据新鲜时间

- ABC worker PID **62530**，`node abc.mjs worker 336`
- 原模拟 PID **47297** 仍在（未停止、未重置）
- 开始：`2026-09-05T18:38:04.975Z`（`started_at` 1788633484975）
- 结束：`2026-09-19T18:38:04.975Z`（`ends_at` 1789843084975，336 小时）
- 首个成功采集周期：`last_completed_at` 1788633617840，区块 **55342129**，`cycle_ms` 2887，目录从该块起向前播种，当时 0 池
- 随后成功周期（交付观察时）：区块 **55344174**，`fresh_at` 1788633828479，目录 2 个池，均为非 ETH/USDG（`UNSUPPORTED_QUOTE`），可分析 0，信号 0
- 三账户现金/净值均为 **1000**，持仓 0，成交 0，无实盘
- 失败轮：汇率源 `last_updated_at` 偶发 >120s、RPC 短暂失败。失败时净值置 null，不伪造 K 线或成交；恢复后净值回到 1000

## 策略与费用（一期冻结）

- 同一轮采集（时间戳+区块）驱动 A/B/C；每套独立 1000 USD 计价的虚拟 USDT 预算
- 入场安全：phase2、流动性、ETH/USDG、持有人≥15、前十流通≤60%、`eth_simulateV1` 往返必须成功。USDG 无状态覆盖且无已出资账户则不伪造通过
- A/B 本金≤30、总现金支出≤35；C≤15/20；现金保留 200；最多 5 仓；不补仓、不杠杆、不重复买同一币
- 净值≤200 永久停买；UTC 日基准净值跌 30 停当日新买；跨日估值未知先禁止入场
- 成交模型：每腿额外 0.5% haircut + 两腿 modeled gas + L1 0.25 预留；往返成本 >5% 拒绝。1.5%/3% 仅作同块报价成本敏感性，不是因果压力回测
- 信号用已结束 1 分钟桶；成交用信号完成后的下一次可执行报价，不用同一根 K 线最低价
- 目录只向前积累，不追溯昂贵历史。B 的 24h 毕业条件需等待样本变老，**当天不能验证 B 盈利**

## 剩余限制

- 当前目录里还没有 ETH/USDG 池，A/C 也处于等待样本阶段；没有成交是合法结果
- CoinGecko `last_updated_at` 经常超过 120s。采集用本次拉取 `observed_at`≤120s；若源 `last_updated_at`>120s 则拒绝新开仓，并记 `USD_SOURCE_STALE`
- 5 分钟旧 discover 量能加速条件未套到 ABC
- 公共 RPC `eth_getLogs` 会失败；失败记 `SOURCE_UNAVAILABLE`，不前向填量
- 费用是模型，不是精确实盘费用。报价可成交 ≠ 真实钱包一定能卖出
- 未安装服务/Docker；Mac 睡眠或杀进程会中断；重启继续同一 `ends_at` 与账户，不重置本金
- 压力 1.5%/3% 未做完整因果重放
- 没有编造回测或胜率

## 未来 Linux VPS 复制与前台启动（不含凭据）

1. 复制项目目录（含 `node_modules`，或在目标机 `npm ci`，Node ≥22.13）
2. 在项目根放入 `.env.rpc`（及可选 `.env.telegram`），权限 `0600`。不要把凭据写进命令行、日志或本文件
3. 前台：

```sh
cd /path/to/robinhood-dog-bot
node abc.mjs run 336
```

路径相对源码文件，不硬编码 macOS 路径。用 tmux/screen 保活即可，不要装 systemd/Docker，不要并发两个 ABC 进程。

```sh
node abc.mjs status
node abc.mjs report
node abc.mjs stop
```

`start` 是本机后台 detached；VPS 建议 `run` 前台。数据在 `data/abc/`。原 `data/paper.sqlite` 与 `data/sim-run` 不要当 ABC 账户用。
