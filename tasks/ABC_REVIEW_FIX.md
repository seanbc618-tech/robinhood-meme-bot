# ABC 一期验收：未通过，定点修复任务
沿用 ABC_PHASE1.md 授权和边界。不要修改原模拟。先备份 ABC 源码与 SQLite（使用 SQLite backup 一致性快照，不直接复制活动 WAL 库），修复下面问题，做运行路径验收。不得删除或覆盖一期旧数据；对受污染/缺桶记录保留并标注 invalid。不要把修复前后作为同一策略版本统计。写 ABC_REPAIR_DELIVERY.md。允许仅对 ABC 做完成验证后的优雅停机及重启，原结束时间、账户保持；若已经有成交先报告影响，不能重置资金。

P0 abc-collect.mjs collectBuckets：rangeStart=minuteStart(startTs)+60 丢弃起始分钟，而 last_cursor_block 每次推进到当前 head。正常60秒轮询时起始部分桶和末尾未完成桶都被跳过，下一轮再跳起始桶，因此无法连续暖机。必须以最后成功提交的完整分钟边界管理游标，或持久化原始事件与未完桶；不推进超出可复原边界。事务提交桶+游标，模拟相邻多轮（比如12:00:20、12:01:20、12:02:20）证明12:01桶全部事件恰好一次，跨重启同样成立。失败后回补不得漏桶。核查现有生产 buckets/minute 间距给证据。历史USD价格用当前汇率转换回补数据有口径偏差，禁止未来汇率当历史真值；明确源时间及近似，缺失历史汇率不造历史USD。

P0 abc.mjs cycle：acc.signal_state=ev.persist 和 reject_counts 只改内存，未触发 applyBuy/writeAccount 时没有保存，末尾 readAccount 又丢弃这些更新，A/C不能跨轮推进。每个策略每次评估提交状态及拒绝原因（原子一致），成功买入也不得被旧对象覆盖。用真实 cycle 路径mock两三轮+重启证明A阶段继续、拒绝计数保留，不只直接调用evaluateA。

P1 evaluateB：prevHigh 当前取 prev60（t-120至t-60），应取 last60（t-60至t）。测试必须让两窗口高点不同、当前只越过较早高点而未越过最近高点，结果不应买。breakoutKey 带滑动窗口起点，每分钟都会改变，不能当同一次突破幂等；使用持久突破状态/重新跌回后才可再次触发，保持同币不重买限制。

P0 markAndExit：部分卖出后 p.mark 仍为卖出前全仓价值，随后 cash+旧mark 导致净值双计、错误风控；买入后也沿用买前equity而持仓mark=null。每次成交后按剩余实际数量重新quote计算全账户净值，无法估值则null。重算并持久化熔断后再允许后续入场。当前账户200熔断是在exitDecision之后才计算，必须先标记所有持仓/计算全账户权益并持久化熔断再退出，避免同轮延迟。完整路径用买入->部分卖出->同轮下一信号验证现金、剩余qty、剩余成本、净值与realized+unrealized一致。

P1 新鲜度：tryEnter/markAndExit 使用cycle开始的now；昂贵holderData/模拟/报价可能耗时数分钟，仍用旧now通过检查并回填旧fill_ts。在实际提交成交前取Date.now校验区块/报价/源汇率，超120秒拒绝或取得新报价；退出同样不得用陈旧报价虚构成交。保留真实决策和完成时间。测试模拟耗时跨120秒拒绝落账。assertFreshness目前只校验rates.observed_at，退出还允许source last_updated旧于120s，按任务书统一或显式声明未达标，不暗改。

P1 netExitValue 把 usd-gas 截成0，真实负净收益被抹掉；估值可设保守零，但执行账必须保留实际gas成本或显式跳过不经济退出且保留仓位，不能销毁token并免掉费用。测试 proceeds<gas 情况。

P1 classifyError 用 not available/not supported 泛匹配成 INVALID_DECLARED_GAP，不是源头确认。方法不支持属于能力不支持，临时不可用 SOURCE_UNAVAILABLE，只有确认归档截断/永久源缺失才 INVALID_DECLARED_GAP。

其他：C同一桶内low/high无法判断先后，不能仅凭同桶极值宣称先上涨30%；用跨桶确认或原始日志次序。排队分析失败也要更新公平轮转进度，避免前10失败池永久占据名额。统计warmup/reject必须真实持久化。确认JSON内stress BigInt是否会让实际首次买入writeAccount JSON.stringify报错（plannedRoundTripFromQuotes带BigInt/quote嵌套），入库统一序列化，加入真实tryEnter成功落库测试。

验证尽量在临时目录和注入读取函数下跑完整cycle，不写正式账户合成数据；离线已有测试通过不足以验收。关键失败路径必须先复现再修复。分别 node --check 每个文件。修复版本明确为v2，报告实际第一轮连续桶证据、账户/进程/原结束时间、受影响数据范围、是否真实买卖：无。未完成如实列出。
