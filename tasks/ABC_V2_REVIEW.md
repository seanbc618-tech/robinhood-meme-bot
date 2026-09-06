# v2 独立复验：逻辑修复通过部分检查，运行验收未通过

两套现有验证脚本均通过。当前只读数据库有2209根valid分钟桶、16根invalid旧桶；valid桶按币排序内部相邻间隔均60秒。说明已恢复生成连续桶，但不等于实时连续决策。

当前最后完成轮耗时2275158ms（约37.9分钟），27完成轮/33失败轮；检查时上一轮完成距今约22分钟。三账户1000，0成交。不能称一分钟实时策略测试正常。

待修复/核验：
1. cycle将池队列逐个采集，持仓退出仅轮开始执行；长达38分钟的采集阻塞违反60秒退出目标。需限制单轮采集预算/每请求超时，独立保留60秒持仓处理机会，不能放宽120秒新鲜度。先定位慢RPC方法与区块范围，不输出带key URL。
2. writeAccount已用bigint-safe stringify，但writeRun仍用JSON.stringify。tryEnter返回{filled:true,plan}包含qty/quote的BigInt，cycle把result加入run.signals再writeRun，成功成交路径仍可能写run失败。现有tryEnter测试未覆盖完整cycle有成交结果。补真实cycle成功买入后run落库测试。
3. foldStoredEvents遇已存在的invalid旧桶直接跳过且用其价格更新lastPrice，可向新桶传播已判invalid数据。必须保留旧记录但不得作为新桶价格种子，缺桶保持缺失或另版本存储有效重建结果。
4. 当前回补桶以采集时FX换算历史事件，只在fx_note写NOT_HISTORICAL_FX，loadBuckets仍将其当策略USD窗口；与冻结历史因果口径有差距。明确隔离缺历史FX桶，或采用从当前起前向保存的对应时点FX；不得仅靠标签宣称已解决。

本次未停止/重启任何worker，未修改资金或交易数据，未发送真实交易。当前结果仅支持部分逻辑修复和数据积累恢复，不支持盈利验证通过。
