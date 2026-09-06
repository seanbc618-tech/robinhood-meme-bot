> 当前版本：ABC 链上纸面模拟研究工具。模拟成交不代表实盘成交或已验证盈利。历史任务交付报告是当时快照，最新运行状态以本机数据为准。
>
> 许可证：[MIT](LICENSE)，Copyright (c) 2026 seanbc618-tech。第三方依赖保留各自许可证。
>
> 协作维护：提交源码与任务说明，不提交 `.env.*` 凭据、`data/` 运行数据或 `node_modules/`。接手前阅读 `tasks/` 中最新交付和复验说明；保留账户与观察槽，未经明确授权不启用实盘、不重置资金。

# Robinhood 打狗 Bot

已完成：Pons 事件观察、热点筛选、V4 双向报价/连续买卖模拟、收据记账与 Telegram 播报。
**还不是可实盘交易的 bot，没有盈利验证。** 不读取私钥、不发链上交易。
已获授权安装并锁定 `viem 2.56.3`、`@uniswap/v4-sdk 2.3.3`，Node 22.13+。
Python 首版保持可用；新增功能入口见下节。
保留原始《制作指南》，本文件记录本轮具体决定和实际完成情况。

## 新增功能与 Telegram

## 持续模拟观察

```sh
node sim-run.mjs start 24
node sim-run.mjs status
node sim-run.mjs stop
```

本轮启动 24 小时后台观察：每轮分析最近注册池中的 5 个，结束后等待 5 分钟。
通过筛选才执行真实 RPC 连续买卖模拟；不因没有信号而放松筛选。
首轮、每小时汇总、首次候选、错误变化和结束推送 Telegram。每轮结果保存在 `data/sim-run/`。
现已接入持续纸面账户 `data/paper.sqlite`：初始 $1,000，预留 $200，最多 5 个持仓，单笔 $30 加模拟费用。
每轮先检查存量持仓，再扫描新信号；新信号才建仓，不把上一轮历史候选回填成买入。
2 倍按数量重新询价回收成本，10 倍卖剩余半仓，尾仓保留；净值不高于 $200 后永久停止新增买入并尝试退出。
持仓、现金、已实现/未实现盈亏、模拟成交和熔断状态保存在同一 SQLite 状态中，重新启动继续使用。
行情缺失时净值/未实现盈亏为 null，并禁止新开仓；已有已实现盈亏不丢失。
成交模型为真实按量报价减 3% 折扣，另计估算执行 Gas（最低 $0.25）加 $0.25 数据费预留。
这些是模型费用，并非精确实盘费用。虚拟现金为 USD，不模拟持有 ETH/USDG 的汇率敞口。
当前模拟卖出使用 Quoter，不宣称真实钱包授权或卖单已执行；入场要求候选已通过往返模拟。
手动关键用例已验证持仓重载、回本、半仓、尾仓和熔断重载。没有开启真实交易。
不需要钱包入金；没有常驻系统服务，Mac 睡眠、关机或进程被结束会中断运行。
网络失败保留为失败轮次，下一个周期继续检查；不在失败轮次伪造行情或成交。

```sh
node chain.mjs check
node chain.mjs discover 5
node chain.mjs analyze TOKEN_ADDRESS
node chain.mjs quote TOKEN_ADDRESS 0.005
node chain.mjs simulate TOKEN_ADDRESS 0.005
node telegram.mjs test
node telegram.mjs report
```

`quote/simulate` 的金额单位是池子的报价资产（ETH 或 USDG），不是美元。
无账户参数的连续模拟仅支持 ETH，并使用临时虚拟 ETH 余额；USDG 模拟需第四个参数指定有资金的公开钱包地址。
所有调用都是只读 RPC 模拟，不签名、不广播交易。

Telegram 已配置到“情报小分队”。凭据只存 `.env.telegram`，权限 `0600`，被 git 忽略。
不会从群里接受交易命令。`discover` 完成后自动发扫描汇总；`ledger record` 发收据状态；`ledger account` 触发熔断时发通知。
`report` 重发最新扫描报告（相同区块已成功推送则跳过），`test` 是一次性连接测试。
成功发送的消息 ID 保存在 `data/telegram-sent.json`；失败不记录成功、不自动重试。发送超时有送达不确定性。
当前是命令运行时播报，**未安装常驻后台扫描服务**。不要并发运行多个推送进程。

热点筛选默认：至少 15 位非基础设施持有人；前十占流通部分不超过 60%；5 分钟至少 10 买/2 卖、8 个买方收币地址；
成交额至少 $1,000、净买入为正、比前 5 分钟放量至少 1.3 倍；$30 订单价格冲击不超过 3%。
通过后才做连续模拟，往返估算成本超过 15% 拒绝。这些是初版研究阈值，不是经回测证明的盈利参数。
持有人从 Transfer 重建，核对总供给和前十余额；买方地址不是独立自然人数。V4 hook 内部换币不计为外部需求。
只扫描最近 10,001 块的注册池，默认分析其中最新 5 个，最大 20 个；不声称覆盖所有热点。
股票代币等其他报价资产明确标记 `QUOTE_ASSET_NOT_IMPLEMENTED`，不作为已通过候选。

## 成交账本

更新：已接入用户提供的 SolidRPC，并验证链 ID 4663 和历史交易 `debug_traceTransaction/callTracer` 返回成功。
`chain.mjs` 日常读取使用 `ROBINHOOD_RPC_URL`（未配置时仍为公共 RPC）；`ledger.mjs` 的 ETH trace 使用
`ROBINHOOD_TRACE_RPC_URL`，并交叉核对收据区块哈希。两者在本地 `.env.rpc` 中配置，权限 0600。
Alchemy 已接通并验证主网链 ID 4663、测试网 46630，以及主网上的 Pons/Uniswap 合约读取。
Node 与 Python 读取入口均加载 `.env.rpc` 的主网地址；测试网地址单独保存，不参与主网交易路径。
本次验证 Alchemy 日志范围 10 块成功、11 块及 100 块被拒绝，因此 `eth_getLogs` 显式走公共 RPC；
普通读取走 Alchemy，trace 走 SolidRPC。这是按方法分流，不是请求失败后的自动重试。
遇到 trace 错误仍会明确标记，不能把能力验证等同于所有历史都可用。

已登记公开钱包 `0xC2dc593C69075b24Dec00dAB3F17af421f63Ca94`。
本轮链上查询：ETH=0、USDG=0、nonce=0；未初始化资金账本，避免尚未入金触发虚假的亏损熔断。
尚无钱包签名连接，不持有私钥。先完成账户启动基线和订单闭环，再进行小额入金验收。

```sh
node ledger.mjs init WALLET_ADDRESS 200
node ledger.mjs record WALLET_ADDRESS TOKEN_ADDRESS TRANSACTION_HASH entry
node ledger.mjs account WALLET_ADDRESS
```

`init` 的 200 是用户声明放在 bot 钱包外的 USDT 预留，可填 0–200。尚未提供真实钱包，因此没有初始化用户交易账户。
账本为 `data/ledger.sqlite`，仅接受该钱包直接调用指定路由的收据，等待至少 64 个块并核对区块哈希。
原因可选 `entry/recover/half/risk/manual`；已完整确认的记录不可改写。数量来自 Transfer，Gas 来自收据。
原生 ETH 需要 `debug_traceTransaction` 才能精确对账；当前公共 RPC 明确不提供该接口及两个替代 trace 方法。
这类字段记 `INVALID_DECLARED_GAP/null`；429 或网络错误属于暂时不可用，不能冒充归档缺口。
历史美元换算必须有覆盖该时刻的本地报价快照；没有则 `CONFIRMED_UNPRICED`，不能使用今天的价格回填历史成本。
账户对账不完整时新增预算为 0；净损失到 800 的停止状态持久化，重启不解除。
只支持独立钱包，暂不支持补仓、追加入金、提款对账；没有自动收据订阅或实盘订单执行器。

## 本轮验证（2026-09-05）

- Pons 源码固定版本 `845bd546b37515621e47b08015ce4f9d374f6eca`，来源 [ponsdotdev/ponsfamily](https://github.com/ponsdotdev/ponsfamily)。
- V4 地址来自 [Uniswap 部署清单](https://github.com/Uniswap/contracts/blob/main/deployments/4663.md)。已校验链上工厂/hook 关联、池状态和路由版本特征；未完成编译后逐字节源码匹配。
- 真实池 `0x775f7609637aaf5adb5ab837f7d4986d5931b0d3`，在区块 54,777,707 完成买→授权→卖连续模拟，4 次调用成功。
  0.005 ETH 返回 0.004802060032602147 ETH，约 3.95% 往返损耗，尚未含完整 Gas；不是实盘成交。
- 已根据真实模拟日志修正 V4 买卖方向。样本筛选识别 44 个买方收币地址，因净流出、量能衰减拒绝。
- Telegram 连接测试成功，消息 ID `3419`。真实扫描报告也已发送，回执见本地 `data/telegram-sent.json`。
- 仅做语法检查、真实 RPC 与手动关键用例核验，没有增加测试框架。

完整实盘还缺：可用 trace 数据源、用户独立钱包、完整交易成本估算和订单执行/对账闭环。
Telegram 通知成功不代表这些交易环节已经完成。

## 首版 Python 入口（保留）

Python 3.10+，在项目目录运行：

```sh
python3 bot.py scan
python3 bot.py scan --watch
python3 bot.py plan account.example.json
```

`scan` 首次读最近 1,000 个区块，随后从本地 SQLite 水位继续；每次最多处理 10,000 块。
`--watch` 每 15 秒继续；Ctrl-C 停止。本轮没有把它安装成后台服务。
数据在 `data/events.sqlite`，原始日志和解码结果一起保存。每批数据与水位同事务提交。
可用 `ROBINHOOD_RPC_URL` 指定 RPC。请求校验 TLS、链 ID、源数据新鲜度和合约存在性。
当前采用落后链头 64 块的读取窗口，这不等于 Ethereum 最终确认；检查点哈希变化会报错停止。
首个窗口之前没有覆盖，不做全历史或全市场覆盖声明。

显式回查某一区块必须使用一个新的数据库文件：

```sh
python3 bot.py scan --from-block 54758191 --db data/backfill.sqlite
```

事件包括发射、sweep、毕业、注册池。发现结果都是 `OBSERVED_ONLY`，不是可以买的热点排名。
工厂和 hook 地址及事件布局来自 [Bitquery Pons 文档](https://docs.bitquery.io/docs/blockchain/robinhood/pons-api/)。
本轮已读取对应地址的链上字节码；尚未独立核验源码/ABI。浏览器源码接口返回 HTTP 403。
官网页面本次研究入口返回地区不可用；没有绕过限制。

## 用户资金与退出约定

| 项目 | 当前定义 | 依据 |
|---|---|---|
| 初始本金 | 1,000 USDT，暂以 USD 等值记账 | 用户指定；实盘需实际汇率 |
| 总损失停止 | 累计净损失达到 800，停止新增买入并检查存量退出 | 用户指定 |
| 累计净损失 | max(0, 1000 − 当前总净值 − 已提走资金) | 实现解释；不是逐笔亏损之和，也不是峰值回撤 |
| 当前总净值 | 未动用现金 + 预留资金 + 持仓可变现净值，扣交易成本 | 输入要求，尚未自动对账 |
| 保留资金 | 200 不参与买入 | 为“不归零”提出的执行默认；建议放在 bot 钱包外 |
| 单笔预算上限 | 30 美元，且不能动用预留 200 | 可调整初版默认；不是盈利优化结果 |
| 先回本 | 单币达到入场价 2 倍，优先卖回该笔投入及卖出成本 | 暂定解释；用户没有指定回本倍数 |
| 半仓止盈 | 达到入场价 10 倍，卖掉回本后剩余数量的 50% | 在用户 10–20 倍区间取下限；可 `--half-at 20` |
| 尾仓 | 完成上述出售后不再因上涨重复卖半仓 | 用户指定；账户级停止优先 |
| 杠杆 | 不引入借贷或合约，目标为现货 | 针对避免爆仓的设计选择 |

例如忽略成本：30 美元买入 30 枚，2 倍卖 15 枚回收 30 美元；10 倍时再卖 7.5 枚，留下 7.5 枚。
不是“涨了 10 倍就一定拿到 10 倍收益”；出售所得取决于仓位、实际报价、税费和流动性。
回收的是每笔成本，并不等于已经把全账户 1,000 美元提回外部钱包。全账户自动提款尚未实现。

`plan` 只读快照，输出草案，不更新持仓、不保存熔断状态、不假设订单已成交。
连续调用时，输入方必须保留 `halted=true`，只在真实成交确认后更新数量、净回款和半仓完成状态。
因此它是待接执行器的规则计算器，**不能作为实盘资金保护装置**。
此 Python 入口不含热点筛选和钱包对账；新增的 Node 功能见上文，尚无签名模块。

`account.example.json` 是空账户格式示例。金额用十进制字符串；初始入金固定为 1,000，暂不支持追加入金。
`equity_usd` 含预留资金、不含已提款；`cash_usd` 是其中的现金部分；`withdrawn_usd` 是累计提款。
持仓格式如下（仅格式示意；运行前更新真实时间和实际数据）：

```json
{
  "token": "TOKEN_CONTRACT_ADDRESS",
  "entry_cost_usd": "30",
  "initial_qty": "30",
  "remaining_qty": "30",
  "confirmed_net_sale_proceeds_usd": "0",
  "half_sale_confirmed": false,
  "reference_price_usd": null,
  "estimated_exit_fee_usd": null,
  "price_timestamp": null
}
```

价格时间是 Unix 秒；超过 60 秒不作退出数量估算。参考价格不是该数量的可执行成交价。
退出数量标为 `indicative_qty`，后续必须按实际数量重新询价，包含税、滑点、Gas，再确认能卖出。
当前字段缺失是 `DATA_MISSING`；网络错误报错退出，不冒充“无行情”。
若后续确认缺口来自数据源自身的归档边界，则该单元记 `INVALID_DECLARED_GAP/null` 并跳过，不补造数据。

## 自建还是嫁接

结论：**自建小型策略和资金账本，后续只复用核实过的链库/官方交易 SDK；目前不整仓嫁接。**
这不是完全手写 EVM 编解码和签名。链上签名应交给成熟库；依赖现已获得授权并安装。
本轮只读克隆了两个候选到临时目录，检查了固定版本的清单、交易和退出代码，没有运行上游安装脚本。

| 候选 | 固定版本 | 代码适配结论 |
|---|---|---|
| [nirholas/robinhood-trading-bot](https://github.com/nirholas/robinhood-trading-bot) | `c5d0c2438274ad125c05d955f1fee1aec5f503f0` | Apache-2.0；依赖 hoodchain/viem。包含界面和跟单，但本版交易路径为 V3，未发现 Pons V2 支持；现有退出代码卖全仓。可参考，当前不作为主干。 |
| [LaChance-Lab/robinhood-sniper-bot](https://github.com/LaChance-Lab/robinhood-sniper-bot) | `d8ea0b61e7d53764999c0c070ca521d70d586c25` | MIT；配置和依赖较多。DEX 类型只有 V2/V3/mock；不完整配置可进入 mock，退出触发调用卖 100%。迁移 Pons V4 仍需重做关键路径。 |

另一个值得重写而非直接继承的细节：nirholas 的 `src/chain/trader.js` 中，实盘买卖记账取 `result.quote.amountOut`，纸面交易以单价乘数量记账。
这不能直接作为本项目的“实际到账后回本”账本；应从确认交易的余额变化/日志核算，并计入实际成本。
上述是源码适配审阅，不是完整安全审计，也不是对两个项目收益的评价。

Pons V2 的曲线及毕业后 V4 hook 路径与这些旧适配器不同，不能只换 RPC 和链 ID。
链的基本参数见 [Robinhood 官方连接文档](https://docs.robinhood.com/chain/connecting/)。
V4 的链上可用性见 [Uniswap 官方公告](https://blog.uniswap.org/robinhood-chain-is-live)。

## 首轮历史验证记录

2026-09-05 首次真实扫描：区块 **54,758,191–54,759,190**，记录 **23 条事件**。
链 ID `4663`；RPC 返回工厂代码 24,177 字节、hook 代码 15,167 字节。
这些结果只证明该窗口读取与解码成功，不证明合约安全、信号有效或可成交。
第二次从 **54,759,191** 接续到 **54,760,454**，新增 18 条；数据库共 41 条 `TokenLaunched`。
本轮真实窗口没有另外三类事件，因此未声称其解码已获真实样本验证。
手动演算了 2 倍回本、10 倍卖剩余半仓、尾仓不重复卖出和累计亏损 800 停止新增预算。
没有新增测试框架；没有实盘交易或收益回测。

优先顺序：
1. 独立核实 Pons V2 合约源码与 V4 hook 路由，接入按数量计算的双向报价及模拟交易。
2. 接真实成交/持仓分布数据，再定义并观察热点筛选条件；不能用新币事件数量代替购买信号。
3. 完成成交账本、账户净值与持续熔断，再接用户授权的交易库和独立热钱包。

最大实际限制：撤池或卖出失败可以越过软件止损。将 200 放在 bot 无法使用的独立账户，才能让这部分资金不依赖 bot 的卖出成功。
