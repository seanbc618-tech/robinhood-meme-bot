# Robinhood meme bot：新 session 交接

> 本文件为公开版：SSH 地址、VPS 与本地绝对路径已替换为占位符
> （`<VPS_USER>`、`<VPS_HOST>`、`<VPS_ROOT>`、`<VPS_HOME>`、`<LOCAL_REPO>`）。
> 完整版保留在本地 `PROJECT_HANDOFF.private.md`，不进入 Git。

## 最新接手入口（2026-09-09 04:30 UTC 更新，优先于下方历史记录）

采集/发现瓶颈已解决，目录与链头同步（lag=0）。用户已明确授权把往返成本闸从 5% 提高到 8%，已部署。**下一步是观察 8% 闸 + stale 重试是否产生首笔真实数据纸面成交；不要再动成本闸、FX 门槛或策略规则。**

### 代码与生产位置

- 本地：`<LOCAL_REPO>`，main HEAD `aae5c26`。提交顺序 `fe765fa` → `110a361` → `ea84fb1` → `f575cec` → `0c2b9ed` → `aae5c26`。`110a361`/`ea84fb1` 已推送；**`f575cec`、`0c2b9ed`、`aae5c26` 待用户在 Mac 执行 `git push origin main`**（本 session 环境无 GitHub 凭据）。
- SSH：`<VPS_USER>@<VPS_HOST>`，会话密钥（`authorized_keys` 注释 `cowork-session`）按用户要求常驻。
- VPS：`current -> releases/aae5c26`，PID `1131395`（须重新核实）。before 快照：`shared/deployment-{110a361,ea84fb1,f575cec,0c2b9ed,aae5c26}-before.json`。
- 注意：`staging/v11-status.py` 里的 `preserved` 是与 `deployment-fe765fa-before.json` 这个零成交快照比较，C 已有真实成交，因此 C 显示 `preserved:false` 属正常，不代表数据损坏。
- 生产 SQLite、持有人缓存、受保护配置与只读边界同历史各节，未变。

### 本轮四个修复（均已部署并通过 VPS 三组检查）

1. `110a361`：公共日志端点单次失败封禁 5 分钟 → 30 秒。原逻辑把整轮预算压到 Alchemy 的 10 区块切片路径（约 15 秒/300 块），是 `analyzed=0`、游标掉队 20 万块的直接原因。
2. `ea84fb1`：公共端点 429 时先在公共端点退避重试两次（0.8s / 1.6s，尊重 RPC abort scope），再故障转移。单次 300 区块 `eth_getLogs` 从约 15.1 秒降到 0.5–0.7 秒，游标约 8 小时自行追平链头。
3. `f575cec`：`isTransientEntry` 增加 `USD_SOURCE_STALE|USD_OBSERVED_STALE|BLOCK_STALE`，让仅因来源时序被拒的入场能在既有 pending 窗口（`signal.minute+180` 秒）内重试。**120 秒门槛本身未改。**
4. `0c2b9ed`：往返成本闸 5% → 8%，用户看过实测分布后明确授权。`ROUND_TRIP_LOSS_MAX` 从 `abc-collect.mjs` 导出为唯一来源，`abc-entry.mjs`/`abc-screening-funnel.mjs`/`abc-safety-evidence.mjs`/`abc-screening-p0-metrics.mjs` 统一读取；拒因码改为 `ROUND_TRIP_COST_OVER_GATE`，历史 `ROUND_TRIP_COST_OVER_5_PERCENT` 计数保留不改写。说明见 `tasks/ABC_V12_COST_GATE.md`。仓位/支出上限、安全检查、120 秒实时新鲜度、策略规则与 v11 成本模型未动。

### 支撑决策的实测证据（24h 到 2026-09-09 04:00 UTC）

- 8 个策略信号、0 成交。C×4 全部卡 5% 成本闸（6.56% / 6.61% / 6.79% / 10.46%）；A×1（09-08 20:34）`holderData` `SOURCE_UNAVAILABLE`；A×2（14:52 / 15:22）停在 `HOLDERS_NOT_FETCHED`；**A×1（09-08 22:27，0xb47efCc4）安全通过、成本 4.70% 已过闸，却在最后 `assertTradeFresh` 被 `USD_SOURCE_STALE` 拒绝且未重试**——这就是修复 3 的对象。
- FX 源时序（n=2846）：`observed_at - eth_last_updated` 最小 70s、中位 97s、p75 145s、p90 155s、最大 178s，**38.6% 超过 120 秒**。源约每 2 分钟刷新，新鲜与否很大程度取决于轮询相位。
- 成本构成（C 09-09 03:03）：$1.99 / $30.09 中 `quoter_fee_and_impact_merged` 约 $1.77，gas（买+卖+授权）约 $0.25。**主导项是池费率与冲击成本，不是 gas**，放大仓位不改善比例。
- 部署后首轮：`lag=0`、`analyzed=4`、`cycle≈29.8s`（此前 53s）、`fx_age=82s`。三账户 cash/equity=1000、trades/positions=0、`created_at` 与实验起止时间逐字段保留。

### 2026-09-09 06:55 UTC：首笔真实数据纸面成交已完成（验收结果）

**两道闸都验证有效，但首笔交易亏损。**

- **8% 成本闸生效**：05:03 UTC C 对 `0x61752da5A4C354EC73646FA2135930A2E59ef94C` 出信号，往返成本 `6.586%`，在旧 5% 闸下必被拒，现被放行并完成 `PAPER_FILL`。这是本项目第一笔用真实链上数据走完安全→报价→往返模拟→入场记账的纸面成交。
- **首笔交易结果**：买入 05:04:40（block 58282673）成本 `$30.083188603132335`，qty `61602156457353186916782`；卖出 05:11:24（block 58286848）reason=`stop`，回款 `$19.386420519052102`。**已实现 -$10.696768084080233，约 -35.6%，持仓 6 分 44 秒。** C 账户 cash/equity 均为 `989.3032319159197`，`max_drawdown_pct=1.07%`，未触发日内暂停或永久熔断。
- **止损规则 -20%，实际亏 -35.6%，原因是结构性的**：`markAndExit` 用当前区块实时报价给持仓估值，而该 mark 已经扣掉卖出侧费用与冲击（约 7%），且退出检查每 60 秒一轮。该币价格路径为 04:55 `0.000538` → 05:20 `0.000354` 的下跌趋势，C 在 05:03 的反弹（0.000449→0.000484）上入场；随后 05:09 跌到 `0.000390`、05:10 最低 `0.000334`。两次退出 tick 之间价格再跌约 13%，叠加约 7% 往返成本，把 -20% 的止损变成 -35.6% 的实际亏损。**这不是记账 bug，是 60 秒轮询粒度在分钟内跌 15% 的币上的固有滑点。**
- **stale 重试（`f575cec`）机械上生效但不够**：A 的 `USD_SOURCE_STALE` 计数从 1 增至 3——06:30 A 对 `0x78b96280` 出信号、安全通过、成本 `4.624%`，在 3 分钟 pending 窗口内重试后仍两次撞上过期 FX，最终未成交。修复让它重试了（旧版会直接删除），但每 2 分钟才刷新的源加上 3 分钟窗口只够约 2 次尝试。
- 最近 3 小时共 3 个信号：05:03 C 成交、05:21 C 同币 `ALREADY_OWNED`、06:30 A 因 FX 过期未成交。运行态 `lag=0`、`analyzed=4`、`cycle≈13s`、`rounds=4610`、`failed_rounds=54`。A/B 仍 cash=1000、trades=0；实验起止时间未变。
- **n=1，不能据此判断策略盈亏能力**；也不要因为这一笔就回调 8% 闸或改动策略规则，需要更多样本。

### 2026-09-09 07:20 UTC：退出滞后修复已部署（`aae5c26`）

- 用户要求先修退出滞后。原因确认为：持仓只在每 60 秒整轮开头 `markAndExit` 一次，首笔交易的止损位在 05:09 分被击穿，卖出落在 05:11:24，其间又跌约 13%；叠加 mark 本身已扣除的约 7% 卖出侧费用与冲击，把 -20% 的止损规则变成 -35.6% 的实际亏损。
- 修法：新增 `exitOnlyTick`（`abc-runtime.mjs` 导出，经 `abc.mjs` 转出），在两轮之间每 15 秒跑一次；无持仓时立即返回 `{checked:0}`，不发任何 RPC，因此常态零成本，且完全不碰采集预算或日志供应商。tick 失败只记 `run.last_exit_tick_error`，下一整轮仍会正常 mark。
- **这只是把检查间隔从 60 秒收紧到 15 秒，不消除滑点**：分钟内跌 15% 的币仍可能在 15 秒内跳过止损；且当一整轮耗时接近 60 秒时，两轮之间没有空隙可跑 tick。止损位、退出规则、各项门槛与成本闸均未改动。
- 新增回归用例（`abc-repair-verify.mjs`）：tick 间隔小于整轮、无持仓时零 RPC、有持仓时被检查、击穿止损能在两轮之间成交、成交记为 `paper=true/live=false`。本地与 VPS 三组检查全过。
- 部署后：`current=releases/aae5c26`、PID `1131395`、`rounds=4649`、`lag=0`、`analyzed=4`、`cycle≈29.7s`。A/B cash=1000/trades=0，C 保持 `cash=equity=989.3032319159197`、`trades=2`，实验起止时间未变。`exit_ticks` 当前为空属正常——此刻无持仓，tick 不计数。

### 2026-09-09：VPS 磁盘清理与 `releases/392da39` 的作用（重要，勿删）

- `releases/` 从 4.8G 降到 413M（释放 3.61 GiB，`/` 使用率 53% → 50%）。删除了 18 个旧 release：046418e、09565dd、110a361、11c1211、17aaf30、53e448a、77bb73f、7a9ca4e、8b12593、a763915、b1d2cd1、c254302、dca180d、de36de4、ea84fb1、eb74f20、efec104、fe765fa。
- 保留 4 个：`aae5c26`（current，运行中）、`0c2b9ed`、`f575cec`（回滚点），以及 **`392da39`**。
- **`releases/392da39` 不是可有可无的旧版本：它持有真实的 `node_modules` 目录，`aae5c26`/`0c2b9ed`/`f575cec` 以及 `staging/v11-cost-20260908` 的 `node_modules` 都是指向它的符号链接。删掉它会让正在运行的 worker 和隔离目录一起失效。** 若要彻底清掉它，必须先把 `node_modules` 迁到 `<VPS_ROOT>/shared/` 并重指所有链接，不要在 worker 运行时做。
- 新 release 沿用现有做法：`cp -a` 上一个 release 后只替换改动文件，`node_modules` 符号链接自然继承指向 392da39，不需要重新 `npm ci`。以后每次发布后顺手清掉过期 release，别再攒到 29 个。
- 清理脚本 `staging/prune-releases.py` 保留：它会先断言 current 与 worker cwd 一致、且没有任何保留目录的符号链接指向待删目录，再删除并复核 `node_modules` 仍可解析。删除后已核对 worker PID 1131395 存活、rounds 继续推进、lag=0、三账户与实验起止时间不变。

### 新 session 下一步顺序

1. 只读核实 current、PID cwd、run、accounts；重点查 `screening_evals` 是否出现 `paper_filled=1`，以及 `ROUND_TRIP_COST_OVER_GATE` 与 `USD_SOURCE_STALE` 的新计数。
2. 首笔成交出现后，逐笔核对入场记账、费用证据与后续退出估值；不要为凑成交调整任何条件。
3. `holderData` 的 `SOURCE_UNAVAILABLE` / `HOLDERS_NOT_FETCHED` 仍会吃掉部分信号，是次要待办：查是否为预算内未完成的分页预热，可在不增加请求量的前提下优先给已出信号的池。
4. 8% 成本闸与 120 秒 FX 门槛现在都是冻结件，未获用户新的明确授权不得再调整，也不得通过改仓位、haircut 或成本模型间接绕过。
5. 在 Mac 上把 `f575cec`、`0c2b9ed` 推送到公开仓库 main。

---

## 历史交接记录（以下旧版本、PID和状态仅作历史证据）


更新：2026-09-07 北京时间。最后一次 VPS 只读核查：2026-09-06 17:08:20 UTC（北京时间 09-07 01:08:20）。下文运行数字均为此时快照，新 session 必须刷新，不能当作实时状态。

## 1. 项目目标与当前边界

Robinhood Chain（chain ID 4663）上的 meme coin 自动筛选与交易研究。当前只运行 ABC 三策略并行纸面模拟，不签名、不广播真实交易，没有盈利能力验证。

用户原始风险意图：本金 1,000 USDT，累计亏损 800 停止；偏高风险高收益，盈利先回本，之后 10–20 倍卖半仓、保留尾仓。当前 ABC 是三个独立的 1,000 USD 虚拟对照账户，不是已投入 3,000 USDT。策略各有不同退出规则，不能把全部策略描述成同一套十倍退出。

用户偏好：从实际断点继续；保留账户、实验起止时间和历史；让 Grok 通过任务书与 GitHub PR 协作；不以降筛选门槛、放宽 FX 或造数据换成交。之后应优先在 VPS 验证网络与运行，不在 Mac 同时启动同一实验。

## 2. 仓库与部署

- 本地：`<LOCAL_REPO>`
- GitHub：<https://github.com/seanbc618-tech/robinhood-meme-bot>，public，MIT。
- 本地 main 与已推送代码：`dca180d`，交接前工作区干净；本交接文件是随后新增文档。
- VPS SSH：`<VPS_USER>@<VPS_HOST>`，默认端口，现有密钥认证可用。
- VPS 当前目录：`<VPS_ROOT>/current`
- current 指向：`releases/dca180d`。
- VPS Node：v22.23.1；项目最低 Node >=22.13（依赖 `node:sqlite`）。
- VPS 数据：`<VPS_ROOT>/shared/data/abc/abc.sqlite`。
- VPS 凭据：`<VPS_ROOT>/shared/.env.rpc`、`.env.telegram`，权限 600，经 release 内符号链接读取。
- release 的 `data` 指向 `../../shared/data`。Telegram 去重记录在 shared/data/telegram-sent.json。
- 当前 detached worker PID 快照：996082。没有安装 systemd、Docker 或开机自启；SSH 断开不影响运行，主机重启后需人工启动。

本地旧 ABC PID 38807 已正常退出并释放锁，之后才迁移数据库；不要重新启动它。本地 data/abc 是迁移时留存状态，已经不再代表生产。原来的 data/paper.sqlite 未重置，旧模拟也未重启。

凭据只留在已有私有配置中；不要输出、写进文档、PR 或 Git。历史聊天包含过密钥，不要复制到新交接。无需用户提供钱包私钥。

## 3. 最近完成的工作

| 提交 | 内容 |
|---|---|
| dca180d | FX 独立观测留存、第二个年轻池槽、采集顺序轮换、分槽行情延迟摘要；部署到 VPS |
| 675b451 | 公开日志 RPC 429 后切备用日志源、追赶积压、行情延迟与有效评估摘要 |
| 8dc1b14 | 恢复每小时纸面持仓 Telegram 摘要 |

PR #1/#2 已在此前合并，筛选诊断直接包含在源码里，不再运行旧版手动补丁脚本。相关交付见 tasks/ 下 PR 与 SCREENING 文档；旧报告中的 PID、单槽和时间预算可能已过时，以当前源码为准。

迁移前后 abc.sqlite 和 Telegram 去重文件 SHA256 一致，数据库 integrity_check=ok；起止时间、账户和原槽 seated_at 保留。具体哈希与首两轮证据见 `data/vps-deployment-dca180d.md`（本地私有、被 Git 忽略）。部署操作说明见 `tasks/VPS_FX_WATCH_DEPLOYMENT.md`。

## 4. 最近运行快照

- status=WAITING，PID 存活，rounds=927，历史 failed_rounds=37。
- 最新一轮 cycle_ms=3737，analyzed=2，collect_deferred=0，last_block=56143893。
- A/B/C 均 cash=1000、equity=1000、positions=0、trades=0。
- started_at=1788633484975；ends_at=1789843084975（2026-09-19 18:38:04.975 UTC）。不得为迁移或测试改写。
- 槽 1：`0xBF99FE5B07FE544e085893CDA276aF9371Ae2266`；seated_at=1788663020596 未改。639 根有效 USD 分钟，历史最长连续 49，最新尾段连续 19。
- 槽 2：`0x048FD456121f6C09dDE7d233B0F2cD8045f44eca`；seated_at=1788714170009。5 根有效 USD 分钟，连续 5。
- 两槽最新有效分钟起点均 1788714360。尾段计数只表示截至该分钟的连续性，还须检查它距当前时间多远。
- 最近一小时拒绝主要为窗口未齐、毕业年龄不足、FX_SOURCE_STALE，以及老池对 C 的超龄拒绝。跨迁移累计，不能全算作 VPS 新运行结果。

“进程活着”“有效分钟增长”“出现纸面成交”“有盈利能力”是不同验收层次。新双槽部署尚未达到 C 连续30分钟、B连续120分钟的完整实测验收。

## 5. 采集与 FX 的真实行为

- 每轮目标从开始时刻 +60秒调度，无并行两轮；退出优先，随后观察池，再同步目录。
- 当前 `COLLECT_BUDGET_MS=45000`，log chunk=300块，普通覆盖至少900块，积压时允许扩大但仍受预算约束；以源码为准，旧报告中的35秒不是当前常量。
- rpcRetry 最多3次，串行重试；每次请求超时不超过 min(12秒, 剩余预算)。不要把“3次重试”说成3个并发请求。
- Alchemy 用于普通读取，公开 RPC 用于日志，SolidRPC 配置为备用。VPS 首轮公开日志请求也发生429，备用成功接管；迁到VPS没有消除上游限流。
- 入观察槽仅允许一次显式积压跳过并记录 gap，之后追游标，不周期性跳 head；不把缺失分钟伪造成无成交 K 线。
- FX 来源为 CoinGecko，包含源 last_updated_at 与本机 observed_at。`fx_observations` 按分钟+观测时刻留存多条；旧 `fx_snap` 仍可读。
- 分别为 ETH / USDG 选择合格快照，两个时间戳都必须在分钟结束 ±120秒。旧的有效观测不会被后来不合格观测覆盖。没有真实合格源数据仍然是 gap；不回写修饰历史已关桶。
- 槽1保留 A/B 历史，最长36h；毕业24h后继续观察2h，并考虑120分钟窗口。槽2只接毕业年龄<5.5h的不同池，6h到期，没有合格池时空置。两槽轮流优先采集，持仓仍优先。
- 这是有限观察池，不是全市场扫描覆盖；A/B/C 目前仍会对采集到的池逐一评估，由各自年龄门槛拒绝不适用池。

## 6. 策略与退出简表

| 策略 | 入场思路 | 已实现退出 |
|---|---|---|
| A | 毕业>=2h，前30分钟高点突破、回踩、再站上，买方与净流入确认 | -12%止损；+25%卖初始半仓，之后12%追踪；60分钟内峰值未达+10%则退出 |
| B | 毕业>=24h，完整120分钟窗口，均线抬升、突破、放量与买方确认 | -15%止损；+40%卖初始半仓，之后18%追踪；最长6h |
| C | 毕业30min–6h，连续30分钟，跨桶确认首波+30%，回撤15–30%，缩卖与回升确认 | 回本前-20%止损；2倍报价下尝试回本；回本后10倍卖剩余半仓；回本前2h且峰值未达+10%退出；剩余尾仓仍受账户风险约束 |

账户永久熔断条件为 equity<=200，日内相对基线亏损>=30暂停新买，最多5仓。退出需要可用报价；负净额退出保留代币，不伪造成已卖出。纸面成本含 haircut 与 gas；不能当真实成交。精确计算以 abc-paper.mjs / abc-entry.mjs / abc-collect.mjs 为准。

## 7. Telegram

保留成交、熔断事件即时通知，以及每个 UTC 小时一份持仓摘要；不是普通采集错误逐条刷屏。摘要含现金、净值、持仓、行情延迟及最近60分钟评估数。

run.last_holdings_hour 与 data/telegram-sent.json 双重去重；只有成功/已发送才推进小时标记。迁移保留去重记录，本轮未额外发送测试消息。最后成功小时快照为 2026-09-06T17。新 session 检查是否按小时继续推进，不要反复发测试通知。

## 8. 新 session 的优先待办

1. 先只读刷新 VPS 当前 release、PID、run时间、两槽游标、最后有效分钟延迟、每槽连续窗口、筛选拒绝与账户；别从本地 status 判断生产。
2. 检查 VPS 双槽能否持续形成30/120分钟窗口；定位真实 FX 源滞后、RPC或采集缺口，不放宽120秒门槛。B同时需要毕业24h。
3. **交接时新发现，尚未修复：** abc-runtime.mjs 小时摘要排除的是 `GRADUATION_OVER6H`，实际策略/落库 detail_code 是 `GRADUATION_OVER_6H`。因此旧池对C的超龄拒绝仍可能被计入“有效评估”。需修正精确码并用实际落库样本验证；不要相信前次文字声称已排除。
4. **待核查：** cycle 中先写 run.usd_source_age_sec，再 Object.assign(run,readRun(store),...)，可能被旧 run 覆盖。核对该字段与当前 FX 观测，修复前不把该摘要字段当实时证据。
5. Creator 净卖出仍有 UNKNOWN 占位；真实含LP Top10 raw 需要数据源明确字段，不能把 legacy 排除基础设施数据改名冒充 raw。诊断未知保留未知。
6. 验证正常退出、重启恢复与纸面成交后对账时，使用隔离样本；不能为了制造成交重置生产或放宽买卖规则。未授权进入实盘。

本次仅编写交接并只读查状态；未修复以上新发现项，未重启、重新部署或修改生产数据。

## 9. 入口、验证与接手命令

主要文件：abc.mjs（CLI）；abc-runtime.mjs（调度/通知）；abc-collect.mjs（采集/SQLite/FX/槽）；abc-strategy.mjs（信号）；abc-entry.mjs（入场/标价退出）；abc-paper.mjs（账本/退出规则）；chain.mjs（RPC/报价/FX）；abc-screening*.mjs（筛选证据/漏斗）；telegram.mjs（发送/去重）。

只读命令：

```sh
ssh <VPS_USER>@<VPS_HOST> 'cd ~/robinhood-meme-bot/current && node abc.mjs status'
ssh <VPS_USER>@<VPS_HOST> 'cd ~/robinhood-meme-bot/current && node abc.mjs report'
ssh <VPS_USER>@<VPS_HOST> 'cd ~/robinhood-meme-bot/current && node abc.mjs screening-report'
```

直接审计运行中SQLite：Python sqlite3，URI `file:<VPS_ROOT>/shared/data/abc/abc.sqlite?mode=ro`，`PRAGMA query_only=ON`。不要对活动库 VACUUM/checkpoint。VPS 未安装 rg，文本搜索可用 grep 或 Python，无需为查日志安装工具。

现有验证（dca180d 已在 Mac 与 VPS 通过三组）：

```sh
node abc-repair-verify.mjs
node abc-verify.mjs
node abc-screening-verify.mjs
```

以后确需维护重启时，先检查 PID 与 release，再用现有 stop/start；不要把下面操作当作本交接要求立即执行：

```sh
cd ~/robinhood-meme-bot/current
node abc.mjs stop
# 确认旧进程退出、锁释放后：
node abc.mjs start 336
```

start 会沿用已有 started_at/ends_at，不是重置实验。发布代码使用新 release，保留 shared 数据与凭据；不要直接将本地旧数据库覆盖回正在运行的VPS。

给新 session 的第一句话可用：

> 请先阅读 PROJECT_HANDOFF.md，从 VPS 只读复核当前状态。优先检查双槽连续窗口和小时摘要的两个待办；保留现有账户与实验时间，不启动本地 worker，不进入实盘。

## 10. 2026-09-07 接续检查：本地修复完成，VPS 连接阻塞

- 两次使用既有 SSH 地址 `<VPS_USER>@<VPS_HOST>:22` 只读连接，均返回 `Connection refused`，远端命令未执行。不能据此判断 worker 是否停止；第4节数字仍是旧快照。
- 本地 `abc-runtime.mjs` 已修正小时摘要排除码为 `GRADUATION_OVER_6H`；将本轮 FX 年龄及 stale 标记赋值移到最后一次合并持久化 run 之后，避免旧值覆盖。未改筛选/FX阈值、策略或账户逻辑。
- 三组现有验证均通过：`ALL_REPAIR_CHECKS_PASSED 0`、`ALL_OFFLINE_CHECKS_PASSED 0`、`ALL_SCREENING_CHECKS_PASSED 0`；`git diff --check` 通过。
- 临时隔离库执行三轮 FX 源年龄 20、180、10 秒，确认年龄及 >120 秒标记更新正确；账户余额、净值、持仓、交易历史和实验起止时间不变。初次额外检查误将账户首次运行时的日基线初始化也要求字节不变，因此失败；改为明确核对资金、历史与起止时间后通过，未为此修改产品逻辑。
- 对本地迁移留存 SQLite 使用 readOnly/query_only 查询，复用修正后的实际摘要 SQL，以全历史为样本，旧查询 C 有效评估=66，修正后=0；精确对应66条 `GRADUATION_OVER_6H`。这是历史样本校验，不是当前 VPS 最近一小时验收。
- 本轮未部署、未重启、未启动本地 worker、未发送 Telegram、未执行真实交易、未修改生产数据库或本地迁移留存数据库。改动尚未提交或推送。
- 下一步先恢复既有 VPS SSH 访问或取得更新的连接地址/端口，再执行第8节只读核查。生产实验时间仍须核对为 started_at=1788633484975、ends_at=1789843084975；当前无法在线确认。源码修复尚未在 VPS 生效，双槽30/120分钟窗口与当前 FX/RPC缺口仍未完成在线验收。Creator/Top10未知项继续保留未知。

### SSH 已恢复及只读复核（2026-09-06 17:27:00 UTC）

用户确认地址未变后再次连接成功，现有 SSH agent 密钥认证通过，无需密码；此前拒绝连接原因未确定。第10节连接阻塞已解除。

- release 仍为 dca180d，PID 996082 存活，rounds=946，failed_rounds=37；游标已推进到56155242。
- ABC现金/净值均1000，持仓0，完整交易轮0；started_at=1788633484975、ends_at=1789843084975保持原值。
- 槽1 seated_at=1788663020596：658个有效分钟，最长连续49，最新连续38；毕业年龄14.61h，B尚未满足24h及120分钟窗口。
- 槽2 seated_at=1788714170009：24个有效分钟且连续24；毕业年龄约0.49h，尚未满足C连续30分钟。
- 两槽最新有效分钟1788715500；距该分钟结束60.7秒。窗口尚未完成验收，不能宣称有盈利能力。
- 最近60分钟实际落库含C超龄拒绝56条、STRATEGY_NOT_TRIGGERED 6条，支持本地摘要码修复；三策略各有FX_SOURCE_STALE 4条。
- 最新FX观测1788715612，ETH源更新时间1788715460，源年龄约152秒；run仍显示100.19秒/false，直接证实旧摘要字段不可用。保留120秒门槛，不修饰历史缺口。
- last_holdings_hour仍为2026-09-06T17，与当前UTC小时一致，尚不能证明下一小时推进。
- 本轮继续全程远端只读，未部署本地修复或重启，也未发送测试消息。后续仍需窗口验收及维护发布安排。

## 11. 已授权统一部署完成：b1d2cd1

2026-09-06 17:32:36 UTC 在线核验：本地 main / GitHub main / VPS current 均为修复提交 b1d2cd19347d4eadf1a5c900d7a22be46b69bf4a。两处摘要修复已生效。新PID 998231，实际进程cwd为 releases/b1d2cd1；旧PID 996082已正常退出并释放锁。

- VPS新release完成 npm ci --ignore-scripts 和三组现有验证，全部通过；未修改依赖锁定版本。npm提示现有依赖31项漏洞（16 low / 4 moderate / 11 high），未执行可能改变依赖的audit fix。
- abc-runtime.mjs SHA256：89ef704fe2deb9ac821fd20dfc60f9bdd994e3f78780ffe567a244ba3823eddf，本地/VPS一致。
- 停机时rounds=950，STOPPED；恢复首轮rounds=951、WAITING、failed_rounds=37。FX年龄95.5569999217987秒，与该轮真实观测源时间计算一致，stale=false。
- shared/deployment-b1d2cd1/保存停机SQLite备份、before.json和Telegram去重副本。继续使用原shared/data，不迁回本地旧库。
- 资金、净值、持仓、交易历史、账户created_at、观察槽及seated_at、实验started_at=1788633484975 / ends_at=1789843084975、通知去重哈希均通过前后核验。账户整对象检查因正常新增reject_counts和signal_state而不相等；逐字段核验确认仅运行诊断推进，没有资金或历史重置。
- 未启动Mac worker，未发送测试通知，未进行真实交易。新版本继续原纸面实验。30/120分钟持续窗口及下一UTC小时通知仍需后续实测，部署完成不代表策略验收或盈利能力。

第二轮只读核验：rounds=952、failed_rounds仍37、WAITING，FX年龄已更新为155.744秒；槽1最新连续44分钟，槽2首次达到连续30分钟，两槽最新有效分钟1788715860，距分钟结束约58秒。该快照证明槽2出现30分钟窗口，不等于持续窗口验收或纸面成交。

## 12. 零成交修复部署：c254302

2026-09-06 18:03 UTC 完成修复发布。修复提交 `c2543028b9011c11c2b5e86626b871852db49827`，本地、VPS release 与 GitHub main 一致。

- `abc-entry.mjs`：采集阶段可使用轻量缓存对象；真实信号进入安全检查、报价、往返模拟和入场估值前，若缺少流动性/价格字段则用当前决策区块 `poolFor` 重新读取完整池状态。RPC失败会落为明确拒绝，不把未知当零或通过。
- `abc-strategy.mjs`：C 的 `fired`/波段失效/回调失效重置保留 `low_minute`；旧的 `seek + low` 缺字段状态以当前已观测桶保守补齐，不虚构历史时间。
- `abc-screening-funnel.mjs`：`GRADUATION_OVER_6H`归入`AGE_INCOMPLETE`，只修正诊断分类。
- 新增缓存池 hydration、C重置反弹和超龄分类回归用例。Mac 与 VPS 的 repair/offline/screening 三组检查均通过；VPS npm ci 未改变锁定依赖。代码文件哈希已核对一致。
- 发布前旧PID 998231 在完成当前轮后正常停止；停机备份在 `shared/deployment-c254302-before/`。新 `current` 指向 `releases/c254302`，新PID 1002273 已完成首轮，rounds=1002、failed_rounds=37、status=WAITING。
- 恢复后 `started_at=1788633484975`、`ends_at=1789843084975`不变；三账户现金/净值/持仓/交易历史/created_at、观察槽及seated_at均与停机快照一致。Telegram去重未被重复启动消息改写，小时摘要推进至`2026-09-06T18`。
- 修复没有放宽策略、FX、持有人或5%往返成本门槛。C本金15美元与当前最低gas/haircut模型仍使5%成本门槛理论不可达；因此修复对象后，C仍可能合法地因`ROUND_TRIP_COST_OVER_5_PERCENT`不成交。若要改变这一点，需要单独明确授权修改冻结成本模型/本金规则，不能借修bug暗中改动。
- 本次未签名、未广播、未发送测试通知、未启动Mac worker；继续为纸面模拟。

2026-09-06 18:26:09 UTC 最终只读核对：`current` 仍指向 `releases/c254302`，PID `1002273`，`rounds=1003`、`failed_rounds=37`、`status=WAITING`，`mode=ABC_PAPER_NOT_LIVE`。`started_at=1788633484975`、`ends_at=1789843084975`仍未变。最近筛选记录没有 `has_signal=1` 或 `paper_filled=1`：A/B 仍在暖机，C 记录为 `WAVE_INVALIDATED`、`GRADUATION_OVER_6H` 或 `NO_T`；运行态同时报告 RPC `SOURCE_UNAVAILABLE`、USD 源年龄约152秒并超过120秒门槛。因此当前零成交有直接数据/信号证据，不能归因于“只是还没等到”。

## 13. 2026-09-06 半小时只读跟踪

- 观察区间 `18:34:08–19:04:36 UTC`，每分钟采样30次；VPS worker PID始终为 `1002273`，`status=WAITING`，`mode=ABC_PAPER_NOT_LIVE`，`rounds=1013→1043`，`failed_rounds=37`未增加。
- 30次均为 `signals=0`、无纸面成交；A/B拒绝以暖机和`NO_T`为主，C以`NO_T`、暖机/超龄和既有`WAVE_INVALIDATED`为主，未出现新的`NO_LIQUIDITY`计数增长。三账户现金均`1000`、持仓均`0`。
- USD源年龄在约75–164秒间波动，多次超过120秒；运行态持续保留`SOURCE_UNAVAILABLE`，所以数据新鲜度仍是当前可执行信号的硬门槛。`last_holdings_hour`在观察中从`2026-09-06T18`推进到`2026-09-06T19`，小时循环正常。
- 只读跟踪未重启、未写活动SQLite、未发送通知、未签名或广播交易；本地跟踪脚本在完成30个样本后退出。

## 14. 2026-09-07 数小时后只读复核

2026-09-07 03:14:24 UTC：VPS `current` 与实际进程 cwd 均为 `releases/c254302`，PID `1002273`，`status=WAITING`，`rounds=1532`，`failed_rounds=37`。实验 `started_at=1788633484975`、`ends_at=1789843084975`未变；三账户现金/净值仍为`1000`、持仓为`0`、`complete_rounds=0`、已实现收益为`0`。

- 24小时筛选报告累计 `4278` 个唯一策略-池-分钟评估，当前观察池只有2个。A：`strategy_signal=0`；B：`age_ok=0`，仍在年龄/窗口门槛；C：仅1个历史`has_signal=1`且`paper_filled=0`，对应 `2026-09-06 17:43:50 UTC`、早于 c254302 发布的那次信号，安全检查为 `SAFETY_FAIL`，`liquidity=UNKNOWN`。c254302 发布后没有新的策略信号。
- 最近24小时每个策略的 `NO_T` 细分均为 `FX_SOURCE_STALE=174`、`MINUTE_NOT_COLLECTED=4`、`COVERAGE_NOT_CLOSED=128`；累计 catalog 为807池、546个支持池。RPC日志有96次公共端失败、6344次备用成功，最近仍记录 `SOURCE_UNAVAILABLE` 和 public `429`，所以覆盖缺口仍是主要数据瓶颈。
- `usd_source_age_sec`在最终核对为94.55秒、当前未 stale，但运行态最近错误仍为`SOURCE_UNAVAILABLE`，不能把一次新鲜样本当作缺口已经消失。`last_holdings_hour=2026-09-07T03`；Telegram 去重文件已有 `abc:hourly-holdings:...:03`，小时摘要实际已发送。`last_summary_hour=2026-09-06T14`是未被当前代码读取的遗留字段，不作为摘要健康判据。
- 当前没有需要立即重启或回滚的运行故障；主要未完成项是数据源/RPC覆盖和策略连续窗口，不能宣称已经完成策略验收或盈利验证。本次仍全程只读，无写库、重启、通知测试或真实交易。

## 15. 连续窗口与数据门槛严格度分析（2026-09-07 03:41 UTC）

- 当前 slot 1（A/B）已坐席约24.85小时，slot 2（C）约4.72小时。两个活动池最近30分钟均为完整可用分钟；A/C 当前记录均为 `STRATEGY_NOT_TRIGGERED`，所以 A/C 此刻不是被30分钟连续窗挡住。C仍在6小时年龄窗内。
- slot 1 最近120分钟有119/120个可用分钟，唯一缺口是 `2026-09-07 02:25 UTC`。该分钟的 ETH `last_updated_at=02:23:20`，距分钟结束约160秒；USDG源约80秒，但活动池是WETH报价，所以实际使用ETH源并落为`SOURCE_LAST_UPDATED_LAG`。slot 2同一FX缺口也被记录。
- 最近24小时，slot 1 有291条 `SOURCE_LAST_UPDATED_LAG`，slot 2有10条；按当前严格数据计算，两个活动池的完整120分钟窗口数均为0，而完整30分钟窗口数分别为223和128。若仅在影子计算中把历史FX允许到180秒，观察到的可用FX分钟可覆盖该缺口，120分钟结构窗口数约变为533和165；这不是已批准的生产放宽，只证明120秒+精确连续120分钟组合很脆弱。
- 最近可用FX快照按分钟取最佳观测共639分钟：ETH有81分钟超过120秒、没有超过180秒；USDG有67分钟超过120秒、没有超过180秒。当前数据源的正常延迟分布因此会把约10%–13%的历史分钟变成永久缺口。`foldStoredEvents`推进`last_complete_minute`后不会回补已落为缺口的分钟，进一步放大B的窗口断裂。
- RPC本身不是当前唯一主因：最近24小时有263条历史`SOURCE_UNAVAILABLE`覆盖缺口，公共日志端96次失败但备用端6344次成功，最新活动池游标仍在推进。当前实时评估的主瓶颈是FX源时间戳滞后和只保留2个live watch；catalog已有553个支持池但每轮只观察2个。
- 结论：B的“120分钟精确无缺口”在现有FX供应商延迟下偏严格；A/C的30分钟窗目前有实际完整数据，不能把它们的无信号归因于窗口太严。下一步若要改，应先做隔离影子对照：历史桶可采用单独的`HISTORICAL_FX_STALE_SEC=180`或可回补的迟到FX状态，入场提交仍保留120秒实时新鲜度；同时测`LIVE_WATCH_N=4/8`的RPC耗时和缺口率。当前未改变生产阈值、未重启、未写活动数据库。

## 16. 历史 FX 回补与四槽发布（2026-09-07）

提交 `11c1211` 已推送 GitHub，并部署到 VPS release `releases/11c1211`；当前进程 PID `1017318`，实际 cwd 与 `current` 均指向该 release，`code_version=abc-phase1-v8`。纸面策略身份仍为 `abc-phase1-v7`。

- `HISTORICAL_FX_STALE_SEC=180` 只用于历史 `fxForMinute` 闭合；实时 `assertFreshness`、`assertTradeFresh`、报价与入场仍严格使用 `STALE_SEC=120`。
- `foldStoredEvents` 对最近 6 小时内的 `SOURCE_LAST_UPDATED_LAG` / `OBSERVED_AT_LAG` 做有限迟到回补；回补只使用分钟之前的最近有效桶，不用未来价格，并保留 `late_fx_retry` 证据。既有不可用桶可被同分钟的合格 FX 更新为 `usd_usable=1`。
- 影子测试均从发布前 SQLite 在线备份或其相邻只读副本运行，不写活动库。相同脚本的单周期结果受 RPC 时变影响，但边界清楚：`n=4` 约 10.3 秒、分析4个池、未出现本周期 `SOURCE_UNAVAILABLE`；`n=8` 达到20秒采集预算、只分析5个池、延迟2个并有1次 RPC 超时；因此选择有界 `LIVE_WATCH_N=4`，不发布8槽。补测 `n=2` 约16.4秒、分析2个池，说明2/4差异会受 RPC 波动影响，选择4的依据是其在预算内完成4池覆盖，而不是声称固定线性加速。
- 发布后首轮为 `analyzed=4`、`cycle_ms=18104`，随后一轮 `cycle_ms=14971`、`collect_deferred=0`；当前4个活动槽。原槽1/2的最新120分钟均为 `120/120` 可用，部署后只读审计看到36个 `late_fx_retry` 桶；这解决的是数据闭合断裂，不等于已有交易信号。
- 发布后最新筛选原因已从窗口阻塞转为策略/年龄状态：槽1 A=`STRATEGY_NOT_TRIGGERED`、B=`SMA_NOT_RISING`、C=`GRADUATION_OVER_6H`；槽2 A/C=`STRATEGY_NOT_TRIGGERED`、B=`WARMUP_GRADUATION_LT_24H`；新槽3/4仍在 A/B/C 暖机。当前零成交因此不是“信号已产生但入场失败”。
- 账户 A/B/C 现金、净值、已实现收益、持仓、交易历史均与停机在线备份相同，交易数仍为0；`started_at=1788633484975`、`ends_at=1789843084975` 未变。备份位于 `shared/deployment-11c1211-before/`，SQLite `integrity_check=ok`。

当前仍需观察4槽在多个周期下的 RPC 缺口率和策略信号；历史窗口达标不构成成交或盈利证明。若4槽持续超预算，应回退到2槽，而不放宽实时120秒门槛或成本/安全门槛。

## 17. 2026-09-07 09:10 UTC 再审：已经有信号，持有人读取阻断入场

11c1211上线后截至本次查询，A有2条、C有6条信号，8条全部SAFETY_FAIL；risk_json保留7次请求超时、1次响应体超限。chain.mjs:248一次查询0到目标块的全部Transfer，VPS独立复现holderData失败而同客户端300块查询成功。不能继续沿用第16节“没有信号”的旧结论。当前3账户资金、实验时间未改，成交仍0。

旧paper.sqlite确认5买2卖，属于旧单账户引擎；ABC多个历史备份均0成交。PR前后ABC三策略函数体相同，5%成本判断、holderData实现也未由这两个PR改变。C本金15与双边最低费用及5%准入冲突仍未处理。完整本轮审计见data/research/project-rescan-2026-09-07.md。本次只读取证和写本地报告，未修改运行代码或部署。

## 18. 2026-09-07 09:36 UTC：持有人读取与 C 本金修复已部署

用户授权直接修复后，本地提交 `eb74f20`、`17aaf30`，VPS 已切换至 `releases/17aaf30`。PID `1025545` 的实际 cwd 与 current 一致，`code_version=abc-phase1-v9`，仍为 `ABC_PAPER_NOT_LIVE`。归档 SHA256 为 `12186b62f122e0511017c21738656e53fcaa61e4ae2cff0b9a31e63b80367d7f`，四个实现文件本地/VPS SHA256 一致；VPS repair/offline/screening 三组现有检查全部通过。

- 持有人历史以合约部署块为起点、每页最多5000块、独立SQLite缓存并跨轮续读；注册块只作二分定位上界，不遗漏注册前铸币。保留供应量、非负余额、头部balanceOf与区块哈希校验，去除20000条日志硬上限。单次请求受剩余预算限制，分钟采集后预热一个观察池。发现重组拒绝缓存，当前未实现自动重建；出现该诊断需单独检查并处理来源缓存。
- 两个实际信号池分别完整取得22228、19492条Transfer，供应量和头部余额校验通过。8条旧信号在隔离账户调用真实入场链路后均不再因持有人读取失败，而在真实报价后被5%往返成本门槛拒绝，损失约8.27%–8.74%。采用原桶source_block、原时点FX，但gas是当前值；这是实现路径诊断，不是严格历史收益回放，也未补记生产成交。
- C本金15/支出20迁移为本金30/支出35，与A/B一致；单笔风险敞口随之增加。保留5%往返成本上限、实时120秒新鲜度及原ABC信号与安全规则。现存C账户记录size_migration，新单版本v9，旧记录不回写。
- 准备发布时，初版离线测试意外创建了空来源缓存（0游标、0Transfer），未改账户。预部署保护因此中止切换，并恢复旧v8 PID1025081；随后17aaf30隔离注入式离线周期与网络预热，三组复验通过。最终停旧进程后，将隔离链上验证的41720条真实来源日志导入经确认仍为空的缓存；未覆盖非空账户或源数据。
- 停机账户备份与before.json位于 `shared/deployment-17aaf30-before/`，SQLite integrity_check=ok；继续原shared/data。停止时rounds=1910，09:36:38 UTC已推进1913、WAITING、failed_rounds仍37，最后cycle_ms=12475。已验证一个池缓存追至56731219，另两个池正在分页暖机，不能声称所有池已全量就绪。
- 与停机快照逐项核对：A/B/C现金及净值均1000、持仓和交易数均0，realized/unrealized、closed_rounds、created_at保持一致。实验started_at=1788633484975、ends_at=1789843084975未变。新版前三轮每策略12条评估，A/C为STRATEGY_NOT_TRIGGERED，B为WARMUP_GRADUATION_LT_24H，信号与纸面成交均0。
- 未进行真实买卖、签名或广播，未启动Mac worker。运行恢复和历史路径通过不代表盈利或已出现新成交。

GitHub尚未同步这两个提交：自动审批拒绝了向公开 `seanbc618-tech/robinhood-meme-bot` 推送，理由是未确认对该公开目标的代码导出授权。VPS部署已经完成，不依赖GitHub推送；等待用户对该公开仓库main推送的明确授权。

用户随后明确授权推送公开仓库，已成功将 eb74f20、17aaf30 推送至 origin/main。git ls-remote 核验远端 main 与本地 HEAD 均为 17aaf300e3aa71b902e47aa7156745a369aa00ec，与已部署 VPS release 17aaf30 一致。仅推送既有六个代码/验证/交付文件；本地 PROJECT_HANDOFF.md、账户数据库及环境密钥未纳入推送。此前 GitHub 授权阻塞已解除。

## 19. 2026-09-08 RPC 日志故障转移与限流修复

用户授权继续解决公共 RPC 失败后，现场取证确认：`https://rpc.mainnet.chain.robinhood.com` 的 `eth_chainId`/`eth_blockNumber` 可用，但日志请求会间歇返回 HTTP 429 或超时；Alchemy 普通读取可用，免费层的 `eth_getLogs` 对单次范围限制为10个区块；SolidRPC 在 VPS 上返回 HTTP 402 `daily response quota exceeded`，当天10000响应额度已耗尽。因此此前“公共失败→Solid备用”在额度耗尽后会把整轮一起判为 `SOURCE_UNAVAILABLE`。Robinhood官方文档仍将公共RPC列为默认端点，并推荐Alchemy作为基础设施提供商。

- 本地提交 `53e448a` 增加可配置 `ROBINHOOD_LOG_RPC_URL`、公共日志超时从4秒提高为8秒；公共失败后识别Solid配额耗尽并禁用到下一个UTC重置，现有Alchemy端点按10区块切片作为小范围日志后备，超过900区块的历史请求不伪造完成。提交 `a763915` 对健康状态里的供应商错误做URL/API key脱敏。
- 提交 `046418e` 给公共日志请求增加150ms全局节流，并给Alchemy切片增加两次短退避重试，处理连续切片触发的429。三组VPS检查仍全部通过；在公共端点故意不可达、Solid配额耗尽的隔离演练中，Transfer和Swap日志均经Alchemy返回，`alchemy_successes=2`、`solid_quota_exhausted=1`，错误状态不含API key。
- VPS 已从 `releases/a763915` 原子切换到 `releases/046418e`，PID `1043597`，实际cwd与current一致。停机备份位于 `shared/deployment-046418e-before/`，SQLite integrity_check=ok；共享账户库和来源缓存没有重置或覆盖。启动后完整周期达到 `analyzed=3`、`cycle_ms=43016`、`failed_rounds`仍为38，最近该周期 `public_failures=0`、`alchemy_successes=0`、`last_provider=public`。三账户现金仍1000、持仓0、交易0；实验 `started_at=1788633484975`、`ends_at=1789843084975`未变。
- `last_pool_error`、`last_error_kind`和`holder_history`仍可能显示前一周期留下的历史来源错误；它们不是最近周期的实时计数。持有人全量预热仍受12秒剩余预算限制，未完整时继续拒绝安全入场；RPC路由修复不等于策略成交或盈利验证。
- 已将 `53e448a`、`a763915`、`046418e`准备推送到公开仓库main；本地 `PROJECT_HANDOFF.md`、账户数据库、RPC/Telegram密钥仍不进入提交。

## 20. 2026-09-07 18:15 UTC：慢速多提供商 RPC 日志路由已部署

用户要求降低并发、改用缓慢流式请求并增加 RPC 供应商后，提交 `09565dd` 完成统一实现。归档 `/private/tmp/rh-rpc-09565dd.tar.gz` 的 SHA256 为 `07057f18be8ff5787dfefe65eaa30bef87e133c2f74bfb6c362d0fc19a1783bc`；本地与 VPS 三组 repair/offline/screening 检查及 `git diff --check` 均通过。

- `ROBINHOOD_LOG_RPC_URLS` 支持逗号分隔的 `label|URL` 慢速日志提供商列表；每个额外提供商独立限速，默认至少间隔1秒，QuickNode标签至少间隔1.2秒。日志路由顺序为公共端点、SolidRPC（配额耗尽识别并等待UTC重置）、额外慢速提供商、Alchemy小范围切片；当额外提供商可用时，大范围日志不会优先消耗Alchemy额度。健康状态新增 `slow_successes`，错误仍脱敏。
- 现场探测中，QuickNode Robinhood demo endpoint 在约1.2秒间隔下成功完成5000区块Transfer日志请求（48条日志）；立即重复请求会得到每秒限流。NodeFlare公共端点返回429 `rate_limited`，因此未启用。Dwellir、带密钥的QuickNode/NodeFlare、RobinhoodRPC等已由配置解析器支持，待提供各自密钥后再加入，不伪造可用性。
- VPS 的 `<VPS_ROOT>/shared/.env.rpc` 已原子加入 `ROBINHOOD_LOG_RPC_URLS=quicknode|https://docs-demo.robinhood-mainnet.quiknode.pro/`；Alchemy、公共RPC及Solid配置保留。新发布前备份在 `shared/deployment-09565dd-before/`，SQLite `integrity_check=ok`。
- VPS 已从 `releases/046418e` 原子切换到 `releases/09565dd`，PID `1044493`，实际cwd与current一致。启动后只读状态为 `rounds=2429`、`failed_rounds=38`、`status=WAITING`；最近周期日志健康计数出现 `public_failures=4`、`solid_quota_exhausted=1`、`slow_successes=4`、`alchemy_successes=0`，证明慢速备用已实际接管过公共RPC失败。
- 与部署前快照逐策略核对：A/B/C 的 `cash/equity=1000`、`realized/unrealized=0`、持仓数和交易数均为0，`created_at=1788633484974`保持不变；实验 `started_at=1788633484975`、`ends_at=1789843084975`保持不变。最近24小时筛选记录 A/B/C 分别为 `has_signal=2/0/6`、`paper_filled=0/0/0`；当前仍没有纸面成交。
- 本次只修复日志请求调度与故障转移，没有放宽FX新鲜度、A/B/C窗口、持有人安全检查或成本门槛；慢速请求降低了429压力，但会增加单轮延迟，需继续观察覆盖缺口和连续窗口。仍未签名、广播或执行真实交易。

提交 `09565dd` 已推送到公开仓库main，远端 `refs/heads/main=09565dd3795d2b8b0e3e0452c20e2524ebeec75a`；本地 `PROJECT_HANDOFF.md`、账户数据库、RPC/Telegram密钥仍不进入提交。

## 21. 2026-09-07 18:30 UTC：接入用户提供的 QuickNode endpoint

用户提供了一个 QuickNode Robinhood mainnet endpoint。现场探测结果：`eth_chainId` 返回 `0x1237`；`eth_getLogs` 在5区块范围内成功返回，超过5区块时服务端明确返回 Discover 计划的 `eth_getLogs is limited to a 5 range`。因此没有把它误配置成大范围日志源。

- 提交 `7a9ca4e` 将额外日志提供商语法扩展为 `label[:max_block_range]|URL`。超过指定范围的提供商会在本地直接跳过，不产生无意义的429/计划错误，再交给后续提供商；未指定上限的 QuickNode demo 仍可处理大范围请求。
- VPS `<VPS_ROOT>/shared/.env.rpc` 已原子更新为受保护配置：用户 endpoint 使用 `quicknode-discover:5` 标签，demo endpoint保留为后备；真实 token 不写入仓库、交接文档或输出。发布前备份位于 `shared/deployment-7a9ca4e-before/`，SQLite `integrity_check=ok`。
- 隔离验证中，公共RPC和Solid故意不可用、5区块请求的 `last_provider=quicknode-discover`；5000区块请求会跳过该5区块提供商并由 `quicknode-demo` 成功接管。生产已切换到 `releases/7a9ca4e`，PID `1046083`，首轮恢复后 `rounds=2444`、`failed_rounds=38`，`public_failures=45`、`slow_successes=45`。
- 停机前后 A/B/C 的 `cash/equity=1000`、`realized/unrealized=0`、持仓数和交易数均不变，`created_at=1788633484974`、实验 `started_at=1788633484975`、`ends_at=1789843084975`均保持原值；仍为纸面模拟，没有签名、广播或真实交易。

提交 `7a9ca4e` 已推送到公开仓库main，远端 `refs/heads/main=7a9ca4ebdfa84e03535b85708ac743ebd3160bc2`；本地 `PROJECT_HANDOFF.md`、账户数据库和 QuickNode token 仍不进入提交。

## 22. 2026-09-07 18:44 UTC：Blockdaemon dev key 只读探测

按官方 Robinhood RPC 文档使用 `https://svc.blockdaemon.com/robinhood/mainnet/native`，分别尝试 `X-API-Key` 和 Bearer 认证；两者均返回 HTTP 404、`code=16385`、`detail=protocol not supported`。同一 key 在 Blockdaemon 的 Ethereum native endpoint 返回 `chainId=0x1`，说明 key 本身可被 RPC API 接受，但当前 Blockdaemon 服务/项目没有 Robinhood 协议路由。

- `GET https://svc.blockdaemon.com/universal/v1/` 返回的支持协议列表也没有 `robinhood`；因此没有把 Blockdaemon 写入生产 `ROBINHOOD_LOG_RPC_URLS`，避免每次故障转移增加一个必败请求。
- 本次只读探测，没有签名、广播、写库或重启；QuickNode 当前部署保持不变。用户提供的 Blockdaemon key 未保存到仓库、VPS配置或交接记录。

## 23. 2026-09-07 18:57 UTC：dRPC key 探测与数据源分级

用户提供的 dRPC key 按官方格式组装为 `https://lb.drpc.live/robinhood/<key>`，并在本机与 VPS 各做一次只读探测。`eth_chainId=0x1237`、`net_version=4663`、`web3_clientVersion=Geth/v10.0.0/drpc`可返回；但 `eth_blockNumber`、`eth_getBlockByNumber`、`eth_getBalance`、`eth_call` 和 `eth_getLogs` 均返回 JSON-RPC `-32601 method ... does not exist/is not available`。因此当前 key/endpoint 不能提供本项目所需链上数据，未加入生产配置，也未重启 worker。

当前数据源分级保持如下：

1. **主日志路径**：官方公共RPC低频尝试，保留150ms节流；失败后转入慢速额外提供商。
2. **专用小范围日志**：用户 QuickNode Discover endpoint 使用 `quicknode-discover:5`，只承接不超过5区块的请求；超过范围本地跳过。
3. **大范围日志**：QuickNode demo endpoint优先承接；它失败时才继续后备路径。
4. **有额度成本的后备**：Alchemy仅处理不超过900区块的范围并按10区块切片，SolidRPC仅在配额恢复后作为备用；不把它们用于无界历史扫描。
5. **隔离源**：dRPC 当前仅保留探测记录，等 `eth_blockNumber` 与 `eth_getLogs` 恢复后再加入；Blockdaemon因 `protocol not supported` 同样未启用。

dRPC 官方文档说明 endpoint 将 key 放入 URL 或 `Drpc-Key` header；本次实际响应与官方状态页所示近期 Robinhood degradation 一致。dRPC key未写入仓库、VPS配置或交接记录。


## 24. 2026-09-08 07:15 UTC：v10 采集调度、分角色观察池和分钟推进已部署

- 代码提交 392da39 + 8b12593，current=releases/8b12593，PID=1067465。最终归档 SHA256=28de5eac353ac2f390521305dd36f526c6443375ec86e7696aacab567a68458a。三组 repair/offline/screening 在本地和 VPS 均通过；repair 新增真实 HTTP 取消、逐分钟幂等、缺口断开状态、待决入场过期、角色分配和目录预算耗尽用例。
- 实时目录独立 cursor，从明确记录的900块尾部开始，历史 catalog_cursor 保留追赶。实时发现先于观察池；历史追赶有独立8秒预算。活动探测一次读取 manager Swap，按区块重叠判断连续观察，未知 pool_id 和未覆盖区间不算闲置。
- 4槽分为B槽1（>=22h准备）、A槽3（>=2h）、C槽2/4（<5.5h入选，6h到期）。老槽保留至到期或有连续30分钟无交易证据且达到最短驻留（C30m、A/B120m）；持仓独立跟踪。阈值不变。
- HTTP per-origin 严格队列，deadline传至fetch取消；公共失败暂停5分钟，短期限流不再等同日额度耗尽；普通读取增加专用QuickNode回退。持有人缓存同样受取消控制。
- 各策略/token 持久化分钟游标，漏分钟逐个处理，缺口打断setup；旧信号只诊断。新信号在网络请求前持久化pending，暂时失败仅在信号闭合后2分钟内重试，永久拒绝/成功即清除。未调整安全、FX或成本阈值。
- 隔离账户3轮真实采集 live_cursor均到本轮head、analyzed4；活动探测509–538池。8个v8历史信号最终均到达成本门槛，损耗8.2701%–8.7439%；两个初始冷缓存超时的对象已显式重试完成。历史block/FX + 当前gas，仅为诊断非因果回测。两次独立往返链上模拟成功 SIMULATED_NOT_FILLED，无合格实测applyBuy、未补生产成交。
- 最终发布首轮：rounds3210，cycle14.428s，head/live_cursor57503751，历史cursor57444591（本轮+4500），活动554池，last_pool_error=null，analyzed4。预算耗尽正常报告partial progress。
- 与发布前 shared/deployment-392da39-before.json 核对经济字段与created_at完全一致，三账户cash/equity1000、trades/positions0；started_at1788633484975、ends_at1789843084975保持不变。后续核查使用实时状态，不沿用这些快照。
- 验收文档 tasks/ABC_V10_SCHEDULING.md；本地原始隔离日志 data/research/v10-acceptance-2026-09-08/；VPS隔离目录 staging/v10-audit-20260908，独立账户和holder缓存，未复制活动生产数据库。无真实交易签名或广播。

## 25. 2026-09-08：用户明确要求提交推送部署重启后完成统一发布

- 先前公开验收文档推送被自动审批拒绝，用户知悉后明确要求提交推送部署重启。现已提交并推送 de36de4d91742adcb325c8965eb728322b7fd0ff，仅补齐 tasks/ABC_V10_SCHEDULING.md；相对8b12593运行代码无变化。PROJECT_HANDOFF.md、密钥和账户库仍仅本地/私有保留。
- current=releases/de36de4，PID1068173，旧PID1067465正常退出。归档SHA256=febcfbf28c446c2c1eb493da4dc7d20b440c0ee0bb5a19d269070aa1e375b11d，本地/VPS一致。依赖复用已验证392da39/node_modules，语法检查通过。
- 重启首轮rounds3217，cycle15070ms，head/live_cursor57507559，历史cursor57474891，analyzed4，last_pool_error=null，WAITING。与shared/deployment-de36de4-before.json核对账户经济字段、创建时间和实验起止均一致，三账户成交0。此为当时快照，下次读取实时状态。

## 26. 2026-09-08：旧观察槽迁移遗漏与额外RPC日额度暂停修复

- efec10441161622d69fddd38d887a40d9231ab51 修复 ensureRoleWatchSlots 对已占用槽不校验角色的问题：B<22h、A<2h、毕业时间未知/未来均归档为 WATCH_ROLE_MISMATCH 再选池；C已经入选的5.5–6h池仍正常保留，不能用入选上限误驱逐。旧行情、账户和实验起止均保留。新增回归覆盖迁移、归档、幂等、无合格候选空槽。
- efec104上线实际归档槽1旧token 0x2D43Ef3D0E0302d7bdC8CDdA44E319d738CafAb2（原seated_at1788849915961保留），换入0x78b96280C3347E0f58a7147B73eb0EC5fFFf025d（当时毕业约63.46h），B不再被旧年轻池长期占槽。
- 现场读证显示RPC超时在发布前已存在：旧版首停前analyzed0，QuickNode demo实际HTTP429正文为 daily request limit reached。77bb73f1d5181c4996b29eb5f116c887eb225945 为额外提供商增加日额度耗尽暂停至次日UTC、短时429仅暂停30秒；不把其他错误当日额度用完。不改成交门槛，不购买额度。
- 两提交已推送main；最终current=releases/77bb73f，PID1074093。归档SHA256=cacb04281ca655049578d6aef637d490970315de2b4a1bf84b1dbdf523ae5f65，本地/VPS一致。VPS repair/offline/screening三组通过。before记录分别保存在shared/deployment-efec104-before.json和shared/deployment-77bb73f-before.json。
- 修正无效请求不代表恢复提供商耗尽的额度，仍需按实时游标/分钟覆盖判断容量，不能声称所有RPC恢复。未签名、广播任何真实交易。

## 27. 2026-09-08：v11 成本模型修复、推送与保留状态部署

- 用户要求把模型改到符合实际，随后明确从断点继续。提交 fe765fa67e1b1cb77b3ba5929ab6d82372c57fa9 已推送 origin/main，current=releases/fe765fa，PID1077427。归档SHA256=15de8ec56416eddd26046549ccc0371939705c1a436ee0e0e720e37c5d2dfce9，本地/VPS一致。repair/offline/screening三组本地及VPS均通过。
- 基准数量与回款改用有状态买入/授权/卖出模拟的实际资产差额；gas改用各调用模拟gasUsed乘链上gasPrice，另按NodeInterface逐调用查询L1分量只计一次。删除quoter额外180000gas、每腿美元下限及固定美元附加项，基础haircut=0；50/150/300bps只保留压力诊断。5%成本门槛、仓位资金限额、安全检查、新鲜度均保持。存储逐调用费用证据，复用入场模拟。
- 卖出估值用决策区块真实有余额EOA的代表性路径模拟，检查代码和余额并计授权gas；找不到合适持有人即不可用。不签名、不广播、不篡改token存储。此为代表性模拟，并非未来真实钱包成交保证。
- 两条v10历史信号旧成本6.56%/6.79%，新模型约2.80%，买gas约0.097美元、卖及授权约0.149美元；随后被历史FX的USD_SOURCE_STALE拒绝。另两条历史v8信号使用历史区块baseFee与新鲜历史FX，成本5.0484%/5.0475%，仍被5%闸拒绝。没有为验收补造成交；真实数据完整applyBuy仍未验收通过。独立exact-quantity退出模拟已成功，记账由现有离线用例覆盖。
- 发布前只读导出选定run/accounts JSON到shared/deployment-fe765fa-before.json，未复制活动数据库。旧PID1074093完成当前轮后正常退出。新版本首轮rounds3579、failed_rounds39、cycle53374ms、analyzed0；catalog_live_cursor57667053、历史cursor57664797，仍受RPC容量限制，不能宣称数据覆盖恢复。三账户cash/equity1000、trades/positions0、created_at1788633484974逐字段一致；started_at1788633484975、ends_at1789843084975保持。
- 公开说明tasks/ABC_V11_COST_MODEL.md；私有证据data/research/v11-cost-2026-09-08/含历史隔离日志及部署后只读快照。VPS隔离目录staging/v11-cost-20260908，独立账户与选定holder缓存行，不写生产账户。后续从实时只读核查继续，优先检查RPC覆盖与自然新信号，不能用本段快照代表持续健康。
