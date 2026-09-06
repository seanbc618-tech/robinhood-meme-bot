# Robinhood Chain 打狗 Bot · 制作指南

> 承接此前「扫链教程」：半自动淘汰垃圾 → 本篇把它收成 **可跑的 bot 骨架**  
> 打狗 = 发现新盘 + 硬核验 + 告警（默认）+ 可选极小仓自动买  
> **不做**：刷量 / 对倒市值、捆绑盘帮发盘方抢跑害人、盗钥钓鱼脚本

---

## 0. 先定边界（比写代码重要）

| 要做 | 不做 |
|------|------|
| 监听 Pons V2 发射 / 冲线 / 毕业 | Noxa 旧站、不明「官方 bot」 |
| 工厂核验 + 一票否决过滤 | 见 CA 就市价梭哈 |
| Telegram / 本地告警 | 刷量、假 K 线、多钱包对倒 |
| 可选：通过绿灯后 **定额小买** | 无止损、无卖出路径的「全自动印钞」 |
| 独立热钱包、仅打狗额度 | 主仓 / 交易所提现权限混用 |

绝大多数「百倍」是幸存者偏差。Bot 的价值是 **提速核验与纪律**，不是提高中奖率保证。

---

## 1. 链与发射台现状（2026-09 口径）

### 网络

| 项 | 值 |
|----|-----|
| 名称 | Robinhood Chain |
| Chain ID | `4663` |
| RPC | `https://rpc.mainnet.chain.robinhood.com` |
| 浏览器 | `https://robinhoodchain.blockscout.com` |
| 原生 Gas | ETH |
| 跨链 | 官方文档 `docs.robinhood.com/chain/bridging/`；常用 relay / Arbitrum bridge / Uniswap |

### 发射台

| 平台 | 角色 | 链接 |
|------|------|------|
| **Pons** | 主战场（类 Pump.fun） | `https://www.ponsfamily.com/launchpad` |
| **LONG** | 股票叙事 / Memestock | `https://app.long.xyz/tokens` |
| NOXA | **已停发** | 不要再往旧流程打钱 |

**Pons V1 vs V2（策略分叉）**

- **V1**：一出生就进 Uniswap 池 → 机器人、抢跑、反狙击税地狱 → 默认当 L1 彩票，bot **可不自动买**  
- **V2**：Bonding Curve → Graduate → 再建池（常见叙事为毕业后进 V4 池）→ 适合「出生→冲线→毕业→24h 存活」全生命周期追踪
- **注意**：材料里提过 V2 曾出现「Public Launches 关闭、仅白名单可创建」阶段——**以当时链上/官网为准**。Bot 要能识别「无新盘」≠「程序挂了」

### 毕业状态机（线 B，必须写进 enrich）

不要把 Pons 页面的「Graduated」当成可买信号。链上更接近：

```
发币 → Curve 交易 → 达毕业条件 → Curve 结束
  → Sweep → 创建 Uniswap V4 池 → PoolRegistered / positionId
```

Bot 建议拆成事件：`on_curve` / `graduating` / `pool_registered`。  
**只有 `pool_registered` 之后**，L2/L3 才考虑自动买；冲线阶段默认只告警。

### 衰减线（线 C）可编码规则

- 2h 量腰斩 + 持有人停 + 净买入转负 → 卖/移出
- 24h 量 < 首个 2h 的 20% → 当死盘
- 持有人增但 top10 更集中 → 降权
- 创作者减仓 → 至少减仓或清仓  

Bot 默认只认真对待 **能核到 Pons V2 工厂 / curve** 的盘；LONG 走「名单盯梢」子模块，别和 Pons 瀑布扫混成一个激进买入器。

---

## 2. Bot 定位：三档能力，按开关升级

```
L1 哨兵（必做）     发现 + 过滤 + 推送，人工点买
L2 副驾（推荐）     绿灯后弹出「一键买 X USD」草案，你确认才签
L3 小狗（高危）     绿灯后自动定额买入 + 强制止损/超时卖出
```

**建议：先 L1 跑一周，再开 L2；L3 仅用「永不心疼」的热钱包零花钱。**

对照旧教程三条扫链线，映射到模块：

| 旧教程线 | Bot 模块 |
|----------|----------|
| 线 A：GMGN 0–20 分钟战壕 | `discover.trenches` + 否决规则 |
| 线 B：Bitquery 出生证明 / 毕业池 | `discover.bitquery` / `chain.events` |
| 线 C：核验 checklist | `filter.*` + `sim.sell` |

---

## 3. 总架构

```
                    ┌─────────────┐
   Bitquery WS/API ─┤  Discover   ├─┐
   RPC logs/WS    ─┤  (发射/毕业) ├─┤
   GMGN/第三方API ─┤             ├─┤
                    └─────────────┘ │
                                    ▼
                    ┌─────────────┐
                    │   Enrich    │  deployer 历史、持有人、curve 进度、报价资产
                    └──────┬──────┘
                           ▼
                    ┌─────────────┐
                    │   Filter    │  一票否决 + 留下规则（全过才绿灯）
                    └──────┬──────┘
                           ▼
              ┌────────────┴────────────┐
              ▼                         ▼
        ┌──────────┐              ┌──────────┐
        │  Notify  │              │ Execute  │  默认关闭
        │ TG/本地  │              │ 买/卖    │  L2确认 / L3自动
        └──────────┘              └────┬─────┘
                                       ▼
                                 ┌──────────┐
                                 │ Position │  止损、超时、毕业事件
                                 └──────────┘
```

---

## 4. 目录建议

```
robinhood-dog-bot/
├── README.md
├── .env.example                 # RPC、Bitquery key、TG token、热钱包（勿提交）
├── config/
│   ├── chain.yaml               # 4663、RPC、浏览器
│   ├── factories.yaml           # Pons V2 factory / 已知合约（需你自行链上核对后填写）
│   ├── filters.yaml             # 否决与留下阈值
│   ├── money.yaml               # 单笔上限、日亏损熔断、Gas 预留
│   └── mode.yaml                # L1 | L2 | L3
├── src/
│   ├── main.py
│   ├── discover/
│   │   ├── bitquery_pons.py     # TokenLaunched / 毕业池订阅或轮询
│   │   ├── rpc_watch.py         # 可选：直接听工厂事件（更稳但要 ABI）
│   │   └── external_pulse.py    # 可选：GMGN 等（当辅助，不作唯一真相）
│   ├── enrich/
│   │   ├── deployer.py          # 24h 发盘次数、历史 rug 标记
│   │   ├── holders.py           # 持有人数变化（Blockscout API 等）
│   │   ├── curve.py             # 进度、报价资产 ETH/USDG/NVDA…
│   │   └── pool.py              # 毕业后池子、LP 锁定线索
│   ├── filter/
│   │   ├── veto.py              # 一票否决
│   │   ├── keep.py              # 留下规则（须同时满足）
│   │   └── sim_trade.py         # eth_call 模拟买→approve→卖，失败则否决
│   ├── notify/
│   │   └── telegram.py
│   ├── execute/
│   │   ├── router.py            # 按报价资产选兑换路径
│   │   ├── buy.py
│   │   └── sell.py
│   ├── position/
│   │   ├── watch.py             # 持仓监控
│   │   └── exit_rules.py        # 止损%、超时、毕业后规则
│   ├── risk/
│   │   ├── limits.py
│   │   └── kill_switch.py       # 文件/TG 命令一键停机并可选清仓
│   └── ledger/
│       └── trades.csv           # 为什么买、过滤快照、结果
├── scripts/
│   ├── paper_only.py            # 只告警记账，不下单
│   ├── dry_sim.py               # 对历史 CA 跑过滤器
│   └── flat_all.py
└── data/
```

---

## 5. 发现层：数据从哪来

### 5.1 Bitquery（旧教程「出生证明」主路）

- IDE：`https://ide.bitquery.io/`  
- 文档入口（Pons）：`https://docs.bitquery.io/docs/blockchain/robinhood/pons-api/`  
- 用途：最近 `TokenLaunched`、curve、deployer、`pairToken`、毕业后正式池列表  

字段最少要落库：

| 字段 | 用途 |
|------|------|
| `token` | CA |
| `curve` | 冲线/买卖路径 |
| `deployer` | 狂发过滤 |
| `pairToken` | `0x0…0`≈ETH；否则核 USDG/NVDA 等 |
| `ts` | Age 过滤 |

注意：订阅会吃额度；生产用带 key 的流式端点，并做 **去重 + 本地水位**。

### 5.2 自建 RPC 监听（进阶）

- 对 **已核实的 Pons V2 Factory** 听 `TokenLaunched` / 毕业相关事件  
- 优点：不依赖第三方索引延迟  
- 前提：ABI + 工厂地址你自己从 Blockscout 核对进 `factories.yaml`（**本文不写死地址**，防过期误导）

### 5.3 外部脉冲（辅助）

- GMGN Robinhood、GeckoTerminal new pools、DexPaprika  
- 只作「漏索引补洞」；**工厂对不上 → 不买**

### 5.4 LONG 子模块

- 不适合毫秒抢盘；适合定时拉 NVDA/TSLA/GME 相关新对  
- 输出进同一 Filter，但 `allow_auto_buy: false` 默认锁死

---

## 6. 过滤层：把旧 checklist 写成代码

### 6.1 一票否决（命中即丢）

写进 `filters.yaml`，与扫链教程对齐：

- 名称含：`official` / `airdrop` / `Teneo` / `Robinhood` / `HOOD` 空投话术等  
- 创作者 24h 发盘数 `> N`（教程参考 >20，自行收紧）  
- 捆绑% 或内部% `> 30`（若数据源有）  
- 模拟卖出失败 / 只能买不能卖  
- 5 分钟单边成交或明显同址对倒  
- 非白名单工厂（假 Pons、杂池）  
- Age 过新且仍在反狙击窗（新手：**0–10 秒默认不买**）  
- 平台温度过冷（可选：接 Dune/ponsinomics 日活阈值，冷市降级为只告警）

### 6.2 留下规则（须同时满足）

- 工厂 / V2 curve 核验通过  
- 持有人在增加（不是 2～3 个地址演独角戏）  
- 存在双向成交  
- 报价资产在白名单（ETH / USDG / 你允许的股票代币）  
- 你配置了「叙事标签」可选：股票挂钩 / 可复述梗；纯随机乱码可降权  

### 6.3 模拟交易（上 L2/L3 前必做）

```
eth_call 路径（概念）：
  1) 模拟从报价资产买入目标 token
  2) 模拟 approve（若需要）
  3) 模拟卖回报价资产
任一步 revert → 否决，永不进 Execute
```

真实链上税、黑名单、区块延迟仍可能让模拟「过了」但实盘砸脸——所以 **单笔硬顶** 不可省。

---

## 7. 执行层（默认关闭）

### 资金纪律（`money.yaml` 示意）

```yaml
hot_wallet_only: true
reserve_gas_eth: 0.02          # 永不买盘的 Gas 垫
max_buy_usd_per_token: 30      # L3 单币
max_open_positions: 5
max_daily_loss_usd: 100        # 触及 → kill_switch
slippage_bps: 300              # 土狗滑点要宽，但别无限
mode: L1                       # L1|L2|L3
```

对照旧教程资金分层思路：打狗仓是 **L1 彩票仓**，不是主策略仓；和资金费率/ADR/统计套利账户物理隔离。

### 买入

- 路径随 `pairToken` 变：ETH 直兑 vs 先经过 USDG/NVDA  
- 优先限价/有上限的 router 调用；失败重试有次数帽  
- 成功后立刻写 ledger：过滤快照哈希、tx、当时进度  

### 卖出（没有卖出规则 = 不准开 L3）

建议最少三条（可并存）：

1. 硬止损：−X%  
2. 时间止损：持有 > T 分钟仍弱 → 市价出  
3. 事件：毕业瞬间流动性异常 / LP 抽逃线索 → 优先逃  

---

## 8. 主循环（伪代码）

```
启动：加载 factories + filters；mode=L1 默认
循环：
  拉新事件（Bitquery / RPC）→ 去重
  enrich(token)
  if veto: log丢弃; continue
  if not keep: log观察; continue
  if not sim_sell_ok: 否决; continue
  notify(绿灯卡片：CA、curve、deployer、进度、链接)
  if mode == L1: continue
  if mode == L2: 等确认超时则放弃
  if mode == L3: buy(定额) → 登记 position
  对每个 position：检查 exit_rules → sell
  若日亏损/熔断文件存在 → 停买；可选 flat_all
```

---

## 9. 告警卡片建议字段

```
[RH-DOG] GREEN
token: 0x…
ticker: …
venue: Pons V2 | LONG
age: 6m
pair: ETH | USDG | NVDA
curve: 0x…  progress: 82%
deployer: 0x…  launches_24h: 2
holders: 48 (Δ+12/5m)
sim_sell: OK
links: Blockscout | GMGN | Pons
mode: L1 (no auto-buy)
```

红灯同样推，方便你回放过滤是否过严。

---

## 10. 分阶段里程碑

### Phase 0 · 只读纸面（1～2 天）

- 配 RPC + Bitquery  
- `paper_only`：落 CSV（发现→否决原因→若绿灯）  
- 对照人工扫链，调阈值  

### Phase 1 · L1 哨兵上线

- Telegram 绿/红灯  
- 工厂地址写入并定期人工复核  
- 无私钥，或私钥无权自动签交易  

### Phase 2 · 模拟卖出 + L2

- `sim_trade` 稳定  
- 一键买仅热钱包、单笔很小  

### Phase 3 · L3 谨慎开（可选）

- 日熔断、超时卖、kill_switch  
- 先只跑 Graduating / 毕业后一段时间，避开 0 秒开盘战  

### 明确不做的 Phase

- 刷量 bot、捆绑多钱包抢第一笔害外人、伪装「聪明钱」的对倒脚本  

---

## 11. 坑位清单

- **GMGN 唯一真相**：漏索引会错过，也会误导；工厂核验不能省  
- **V1 当 V2**：一出生就 V3 池的盘，策略应降级  
- **pairToken 没认**：用错报价资产路径导致买贵或失败  
- **反狙击税**：越早越脏；bot 默认延后窗口  
- **Bitquery 额度**：免费用尽 → 静默漏报；要监控配额错误  
- **RPC 抖动**：Robinhood 公共 RPC 需备用 endpoint / 重试  
- **密钥**：`.env` 不进 git；打狗钱包 ≠ 主钱包  
- **幻觉百倍**：ledger 周报真实胜率；连续亏触熔断就停，别加码  
- **钓鱼**：群文件、假「一键打狗」桌面端、Google 广告首位 → 默认当假  

---

## 12. 与旧扫链教程的关系

| 扫链教程 | 本 Bot |
|----------|--------|
| 温度 → 发现 → 事件 → 池子 → 浏览器 → 才买 | 温度可作总开关；后段自动化 |
| 三条线并行 | Discover 多源 + Filter 统一 |
| 六个实操场景 | 写成 `scenarios` 测试用例更佳 |
| 屏幕摆放 / 监控日历 | L1 告警可代替「人肉刷屏」 |

旧 PDF/教程仍是 **核验直觉与场景题**；本 MD 是 **工程骨架**。先有纪律，再有速度。

---

## 13. 配置示意（`filters.yaml`）

```yaml
age:
  min_seconds: 60          # 避开最脏的前几秒～几十秒；可再加大
  max_minutes: 20          # 线 A 窗口；毕业线可另开规则

veto:
  name_blacklist_substr:
    - official
    - airdrop
    - teneo
  max_deployer_launches_24h: 20
  max_bundle_pct: 30
  max_insider_pct: 30
  require_sim_sell: true

keep:
  min_holders: 15
  require_two_way_flow: true
  allowed_quote_symbols: [ETH, WETH, USDG]  # NVDA 等按你研究再加
  require_pons_v2: true

notify:
  telegram_chat_id: "..."
```

---

## 14. 下一步可选项

1. **scaffold**：按上文目录生成空仓库 + `paper_only` 骨架  
2. **先接 Bitquery**：只做 TokenLaunched → CSV + TG（真正的 L1）  
3. **factories 核对清单**：教你在 Blockscout 上如何确认 V2 工厂并填 yaml（仍不代填过期地址）  

---

## 15. 免责声明

Memecoin / 土狗波动与骗局密度极高，可能本金迅速归零。本文是技术架构与流程说明，**不是投资建议**，不保证收益。自动买入会放大失误；默认停留在 L1。遵守你所在地法规与平台条款。

---

*文档版本：2026-09-05 · 基于既有 Robinhood 扫链材料整理的打狗 bot 制作指南*  
*发射台合约、费率、毕业机制会变：上线前用 Blockscout / 官方文档复核。*
