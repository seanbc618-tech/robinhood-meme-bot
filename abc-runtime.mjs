import {existsSync,readFileSync,unlinkSync,writeSync,openSync,closeSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {ROOT,client,save,failure,logRpcHealth,warmHolderHistory} from './chain.mjs';
import {broadcast,enabled} from './telegram.mjs';
import {
  abcDir,openAbc,initAccounts,readAccount,writeAccount,readRun,writeRun,
  syncCatalog,graduationTs,loadBuckets,probePoolActivity,
  enrichPool,collectBuckets,catalogStats,assertFreshness,markingRates,
  ANALYZE_LIMIT,CYCLE_TARGET_MS,DEFAULT_HOURS,STRATEGY_VERSION,
  classifyError,blockContext,usdRates,stringify,usdSourceAge,STALE_SEC,
  markV1BucketsInvalid,CODE_VERSION,COLLECT_BUDGET_MS,
  slimSignalResult,poolFromRow,isolateNonContemporaneousFx,
  pickLiveWatch,skipBacklogForLive,LIVE_WATCH_N,saveFxSnap,logBlocksNeeded,
  extendActiveWatchBounds,migrateCSize,invalidateCarriesAcrossGaps,
} from './abc-collect.mjs';
import {
  recordEvalFromCycle,ensureScreeningSchema,
} from './abc-screening.mjs';
import {applyDayBaseline,recomputeEquity} from './abc-paper.mjs';
import {evaluators} from './abc-strategy.mjs';
import {markAndExit,tryEnter} from './abc-entry.mjs';

export function acquireLock(dir) {
  mkdirSync(dir,{recursive:true});
  const lock=resolve(dir,'pid');
  if(existsSync(lock)) {
    const pid=Number(readFileSync(lock,'utf8'));
    let alive=false;try{process.kill(pid,0);alive=true;}catch(e){if(e.code!=='ESRCH') throw e;}
    if(alive) throw new Error('ABC simulation already running: '+pid);
    unlinkSync(lock);
  }
  const fd=openSync(lock,'wx',0o600);
  writeSync(fd,String(process.pid));
  closeSync(fd);
  return lock;
}
export function releaseLock(dir) {
  const lock=resolve(dir,'pid');
  try {if(existsSync(lock)&&Number(readFileSync(lock,'utf8'))===process.pid) unlinkSync(lock);} catch {}
}

function notifySafe(run,key,text) {
  return (async()=>{
    if(!/^(fill:|halt:|daily:)/.test(key)||!enabled()) return {skipped:true};
    try {return await broadcast('abc:'+key,text);}
    catch(e) {run.telegram_error=failure(e);return {error:failure(e)};}
  })();
}

const EXIT_NAMES={stop:'止损',trail:'回撤止盈',timeout:'超时',partial_tp:'分批止盈',recover:'回本',half:'减半',risk:'风控'};
const bjTime=ms=>new Date(ms+8*3600000).toISOString();
export function dailyText(store,run,from,now) {
  const sym=token=>store.db.prepare('SELECT symbol FROM pools WHERE token=?').get(token)?.symbol||token.slice(0,8);
  const usd=v=>(v>=0?'+':'')+v.toFixed(2);
  const accs=['A','B','C'].map(s=>readAccount(store,s));
  const idle=Math.round((now-(run.last_completed_at||0))/60000);
  const lines=[`📊 ABC 日报 ${bjTime(now).slice(5,10)}（模拟盘，非实盘）`,
    `统计 ${bjTime(from).slice(5,16).replace('T',' ')} 到 ${bjTime(now).slice(5,16).replace('T',' ')}（北京时间）`,'',
    `运行：${idle<=3?'正常':`⚠️ 已 ${idle} 分钟没跑完一轮`}，${run.last_daily_failed==null?`累计失败 ${run.failed_rounds||0} 轮`:`期间失败 ${(run.failed_rounds||0)-run.last_daily_failed} 轮`}`,'',
    '账户（各从 1000 起步）：',
    ...accs.map(a=>`${a.strategy} ${a.equity==null?'净值不可用':`${a.equity.toFixed(2)}（${usd(a.equity-1000)}）`}${a.paused_reason?'，已暂停买入':''}`)];
  if(accs.every(a=>a.equity!=null)) lines.push(`合计 ${usd(accs.reduce((sum,a)=>sum+a.equity,0)-3000)}`);
  const closed=accs.flatMap(a=>(a.closed_rounds||[]).filter(r=>r.closed>=from).map(r=>
    `${a.strategy} ${sym(r.token)} ${r.pnl>=0?'+':''}${(100*r.pnl/r.cost).toFixed(1)}%（${EXIT_NAMES[r.reason]||r.reason}）`));
  const held=accs.flatMap(a=>a.positions.map(p=>`${a.strategy} ${sym(p.token)} 买入 ${p.cost.toFixed(2)}，现值 ${p.mark==null?'不可用':p.mark.toFixed(2)}`));
  lines.push('',`平仓 ${closed.length} 笔`,...closed,`持仓 ${held.length} 个`,...held);
  const signals=store.db.prepare('SELECT strategy,token,minute,paper_filled,checks_json FROM screening_evals WHERE has_signal=1 AND minute>=? AND minute<?')
    .all(Math.floor(from/1000),Math.floor(now/1000));
  const why={};
  for(const r of signals) {
    if(r.paper_filled) continue;
    const a=accs.find(x=>x.strategy===r.strategy);
    const checks=JSON.parse(r.checks_json||'[]');
    const fail=checks.find(c=>c.status==='FAIL');
    const missing=checks.find(c=>c.status==='UNKNOWN'&&!c.diagnose_only&&c.reason!=='ROUND_TRIP_DEFERRED_UNTIL_ENTRY');
    const k=a.paused_reason?`${r.strategy} 暂停中`
      :a.trades.some(t=>t.side==='buy'&&t.token===r.token&&t.at<r.minute*1000)?'这个币已经买过'
      :fail?(fail.reason==='ROUND_TRIP_COST_OVER_GATE'?'手续费+滑点超 5%':fail.reason)
      :missing?(/^(holder|top10)/.test(missing.name)?'持有人数据没拿到':`数据没拿到（${missing.name}）`)
      :'其他';
    why[k]=(why[k]||0)+1;
  }
  const bought=signals.filter(r=>r.paper_filled).length;
  lines.push('',`信号 ${signals.length} 个，买入 ${bought} 个${signals.length>bought?'，没买的原因：':''}`,
    ...Object.entries(why).sort((x,y)=>y[1]-x[1]).map(([k,n])=>`${k} ×${n}`));
  return lines.join('\n');
}
// One report a day after 09:00 Beijing time, covering everything since the previous one. It replaced
// the hourly holdings message (2026-09-25); fills and halts still go out as they happen.
export async function notifyDaily(store,run,now=Date.now()) {
  const day=bjTime(now).slice(0,10);
  if(!enabled()||Number(bjTime(now).slice(11,13))<9||run.last_daily_day===day) return;
  const result=await notifySafe(run,`daily:${day}`,dailyText(store,run,run.last_daily_at||now-86400000,now));
  if(result?.message_id||result?.duplicate) Object.assign(run,{last_daily_day:day,last_daily_at:now,last_daily_failed:run.failed_rounds||0});
  writeRun(store,run);
}

function reportFromAccounts(accounts,run,catalog) {
  const out={mode:'ABC_PAPER_NOT_LIVE',version:STRATEGY_VERSION,run,catalog,accounts:{},notes:[]};
  for(const a of accounts) {
    const complete=a.closed_rounds||[];
    const pnls=complete.map(r=>r.pnl);
    const best=pnls.length?Math.max(...pnls):null;
    const netMinusBest=best==null?null:pnls.reduce((s,x)=>s+x,0)-best;
    out.accounts[a.strategy]={
      cash:a.cash,equity:a.equity,realized:a.realized,unrealized:a.unrealized,
      max_drawdown:a.max_drawdown,max_drawdown_pct:a.max_drawdown_pct,
      positions:a.positions.length,open_positions:a.positions.map(p=>({token:p.token,qty:p.qty,cost:p.cost,mark:p.mark,exit_incomplete:p.exit_incomplete})),
      complete_rounds:complete.length,net_profit_complete:pnls.reduce((s,x)=>s+x,0),
      net_profit_minus_best_complete:netMinusBest,failed_sells:a.failed_sells,exit_incomplete:a.exit_incomplete,
      reject_counts:a.reject_counts,halted_permanent:a.halted_permanent,halted_day:a.halted_day,
      day_key:a.day_key,day_baseline:a.day_baseline,model:a.model,capital_note:a.capital_note,
    };
  }
  out.notes.push('No invented backtest or win-rate: only observed paper fills and warmup/reject counts.');
  out.notes.push('Stress haircuts of 1.5%/3% are cost sensitivity on same-block quotes when recorded, not a causal full replay.');
  out.notes.push('Unclosed positions at expiry are kept; no synthetic close.');
  return out;
}
export function nextTickDeadline(tickStart,interval=CYCLE_TARGET_MS) {
  return tickStart+interval;
}
export async function sleepUntil(deadline,shouldStop,stepMs=50) {
  while(Date.now()<deadline&&!(shouldStop&&shouldStop())) await new Promise(r=>setTimeout(r,stepMs));
}

export const EXIT_TICK_MS=15000;
// Held positions are only marked once per full cycle, so a stop can sit unfilled for a whole
// minute while the token keeps falling. Re-check them between cycles: this quotes only what is
// held and touches neither the collection budget nor the log providers.
export async function exitOnlyTick(store,now=Date.now(),io={}) {
  const accounts=['A','B','C'].map(s=>readAccount(store,s)).filter(a=>a.positions.length>0);
  if(!accounts.length) return {checked:0};
  const block=await (io.blockContext||blockContext)();
  const rates=markingRates(await (io.usdRates||usdRates)(),now/1000);
  assertFreshness(block,rates,now/1000);
  const gasPrice=io.gasPrice!=null?io.gasPrice:await client.getGasPrice();
  for(const account of accounts) await markAndExit(store,account,block,rates,gasPrice,now,io);
  return {checked:accounts.length};
}

function isTransientEntry(result) {
  const reasons=[result.skipped,...(result.safety?.reasons||[])].filter(Boolean).join(' ');
  // Staleness is a timing artifact of a source that refreshes every ~2 minutes, not a verdict
  // on the signal; the pending window may still find a fresh observation before it expires.
  // A stablecoin problem used to fail the whole cycle, which left pending signals for the next
  // one; now that the cycle runs through it, keep them pending the same way.
  return /SOURCE_UNAVAILABLE|RPC_TIMEOUT|RPC_DEADLINE|timed out|timeout|429|HOLDER_HISTORY_INCOMPLETE|HOLDER_HISTORY_WARMUP|HOLDER_HISTORY_DEADLINE|USD_SOURCE_STALE|USD_OBSERVED_STALE|BLOCK_STALE|USD_SOURCE_MISSING|STABLECOIN_SOURCE_STALE|STABLECOIN_OFF_PEG/i.test(reasons);
}

export async function cycle(store,now=Date.now(),io={}) {
  const t0=Date.now();
  ensureScreeningSchema(store);
  const run=readRun(store);
  run.status='CYCLE';run.last_started_at=now;run.code_version=CODE_VERSION;
  run.last_pool_error=null; // Current-cycle status; historical errors remain in recorded diagnostics.
  writeRun(store,run);
  const block=await (io.blockContext||blockContext)();
  const rates=await (io.usdRates||usdRates)();
  assertFreshness(block,rates,now/1000);
  // Entries keep the full rates so a stablecoin problem is reported by name; marks, exits and the
  // FX record use markingRates, which leaves USDG unpriced while any stablecoin is in doubt.
  const markRates=markingRates(rates,now/1000);
  saveFxSnap(store,markRates);
  const gasPrice=io.gasPrice!=null?io.gasPrice:await client.getGasPrice();
  const accounts={};
  for(const s of ['A','B','C']) accounts[s]=readAccount(store,s);
  const held=[...new Set(['A','B','C'].flatMap(k=>accounts[k].positions.map(p=>p.token)))];
  for(const s of ['A','B','C']) accounts[s]=await markAndExit(store,accounts[s],block,markRates,gasPrice,now,io);
  run.exits_ms=Date.now()-t0;
  const collectDeadline=io.deadline|| (t0+(io.collectBudgetMs??COLLECT_BUDGET_MS));
  Object.assign(run,readRun(store),{status:run.status,last_started_at:run.last_started_at,code_version:CODE_VERSION,exits_ms:run.exits_ms});
  const ending=now>=run.ends_at||existsSync(resolve(store.dir,'stop.json'));
  // Live discovery has its own deadline; historical catch-up retains its old cursor.
  let catalog={added:0};
  if(!io.skipCatalog) {
    try {
      catalog=await (io.syncCatalog||syncCatalog)(store,block,{...io,liveCatalog:true,catalogMaxBlocks:6000n,deadline:Math.min(collectDeadline,Date.now()+8000)});
      if(!io.syncCatalog&&!io.blockContext&&Date.now()+1000<collectDeadline)
        run.discovery_activity=await probePoolActivity(store,block,{deadline:Math.min(collectDeadline,Date.now()+4000)});
    } catch(error) {run.last_pool_error={token:null,error:failure(error),kind:classifyError(error),at:Date.now()};}
  }
  const watch=pickLiveWatch(store,held,io.liveWatchN??LIVE_WATCH_N,now);
  run.live_watch={n:watch.n,catalog_ok:watch.catalog_ok,tokens:watch.live.map(r=>r.token),note:watch.note};
  // Alternate the first unheld slot so catch-up cannot monopolize the shared budget.
  const queue=(run.rounds||0)%2?[...watch.live].reverse():watch.live;
  const analyzed=[];
  const warmup={A:0,B:0,C:0};
  const signals=[];
  const rpcProfile=[];
  let deferred=0;
  const rpcIo={...io,deadline:collectDeadline,rpcProfile,rpcEpoch:io.rpcEpoch||0};
  // A cycle runs 20-45 s but marked held positions only at its start, so the 15 s exit check
  // held only between cycles: a stop could sit up to a minute. Check again between steps.
  let lastExitCheck=Date.now();
  const exitCheck=async()=>{
    if(Date.now()-lastExitCheck<EXIT_TICK_MS||!['A','B','C'].some(s=>accounts[s].positions.length)) return;
    try {
      const tick=await exitOnlyTick(store,Date.now(),io);
      if(tick.checked) {const r=readRun(store);r.exit_ticks=(r.exit_ticks||0)+1;r.last_exit_tick_at=Date.now();writeRun(store,r);}
    } catch(error) {
      const r=readRun(store);r.last_exit_tick_error={error:failure(error),kind:classifyError(error),at:Date.now()};writeRun(store,r);
    }
    // Space checks from the end of the last one: each re-quotes every holding on the shared RPC
    // queue, so a slow check must not run again right away and crowd out collection.
    lastExitCheck=Date.now();
    // The tick wrote the accounts; later steps must not write back stale copies over its exits.
    for(const s of ['A','B','C']) accounts[s]=readAccount(store,s);
  };
  for(const row of [...held.map(t=>store.db.prepare('SELECT * FROM pools WHERE token=?').get(t)).filter(Boolean),...queue]) {
    await exitCheck();
    if(analyzed.includes(row.token)) continue;
    if(Date.now()>collectDeadline) {deferred++;continue;}
    try {
      const cached=poolFromRow(row);
      const pool=cached||await (io.enrichPool||enrichPool)(store,row.token,block.number);
      if(!io.skipLiveJump) await skipBacklogForLive(store,row,block,rpcIo);
      const liveRow=store.db.prepare('SELECT * FROM pools WHERE token=?').get(row.token)||row;
      const folded=await (io.collectBuckets||collectBuckets)(store,liveRow,pool,block,rates,rpcIo);
      const fresh=store.db.prepare('SELECT * FROM pools WHERE token=?').get(row.token)||row;
      const grad=graduationTs(fresh);
      // Judge only minutes this pool's logs fully cover. A later minute is not missing, just not
      // collected yet; judging it early wiped the setup and the minute was never looked at again.
      const chainMinute=Math.floor(Number(block.timestamp)/60)*60-60;
      const lastComplete=folded?.lastFull!=null?Math.min(chainMinute,folded.lastFull):chainMinute;
      const buckets=loadBuckets(store,row.token,lastComplete-8*3600,lastComplete+60);
      for(const strat of ['A','B','C']) {
        const acc=accounts[strat];
        acc.pending_signals??={};
        const pending=acc.pending_signals[row.token];
        if(pending) {
          if(now<pending.expires_at&&!ending) {
            const result=await tryEnter(store,acc,row.token,pending.signal,pool,block,rates,gasPrice,now,io);
            Object.assign(acc,readAccount(store,acc.strategy));
            signals.push({strategy:strat,token:row.token,minute:pending.signal.minute,result:slimSignalResult(result),retry:true});
            if(!io.skipScreeningRecord) recordEvalFromCycle(store,{strategy:strat,token:row.token,minute:pending.signal.minute,
              ev:{signal:pending.signal,persist:acc.signal_state[row.token]},gradTs:grad,watched:true,buckets,pool,
              safety:{...(result.safety||{}),plan:result.plan||null},paperFilled:!!result.filled,codeVersion:CODE_VERSION});
            if(result.filled||!isTransientEntry(result)) delete acc.pending_signals[row.token];
          } else delete acc.pending_signals[row.token];
          writeAccount(store,acc);
        }
        acc.evaluated_minutes??={};
        const previousMinute=acc.evaluated_minutes[row.token];
        // Migration starts at the next current minute, never replays old account state backwards.
        const from=previousMinute==null?lastComplete:previousMinute+60;
        for(let evalMinute=from;evalMinute<=lastComplete;evalMinute+=60) {
          let prev=acc.signal_state[row.token]||null;
          const present=buckets.some(b=>b.minute===evalMinute);
          // A declared missing minute breaks a causal multi-minute setup.
          if(!present) prev=null;
          const ev=evaluators[strat](buckets,prev,grad,evalMinute);
          if(!present) ev.persist=null;
          acc.evaluated_minutes[row.token]=evalMinute;
          acc.signal_state[row.token]=ev.persist;
          if(ev.reason) {
            // Keep aggregate NO_T (and other reasons) exactly as before for reject_counts compatibility
            acc.reject_counts[ev.reason]=(acc.reject_counts[ev.reason]||0)+1;
            if(String(ev.reason).startsWith('WARMUP')) warmup[strat]++;
          }
          // Same 3-minute life as a pending signal, now that the judged minute can trail the chain.
          const shouldEnter=ev.signal&&!ending&&evalMinute===lastComplete&&now<(evalMinute+180)*1000&&!acc.pending_signals[row.token];
          if(shouldEnter) acc.pending_signals[row.token]={signal:ev.signal,expires_at:(ev.signal.minute+180)*1000};
          // Commit both the minute cursor and pending intent before network I/O.
          writeAccount(store,acc);
          let enterResult=null;
          if(shouldEnter) {
            const result=await tryEnter(store,acc,row.token,ev.signal,pool,block,rates,gasPrice,now,io);
            enterResult=result;
            Object.assign(acc,readAccount(store,acc.strategy));
            if(result.filled||!isTransientEntry(result)) delete acc.pending_signals[row.token];
            writeAccount(store,acc);
            signals.push({strategy:strat,token:row.token,minute:ev.signal.minute,result:slimSignalResult(result)});
          }
          // Diagnose-only unique eval row; does not gate buys
          try {
            if(!io.skipScreeningRecord) {
              recordEvalFromCycle(store,{
                strategy:strat,token:row.token,minute:evalMinute,ev,gradTs:grad,watched:true,
                buckets,pool,safety:enterResult?{...(enterResult.safety||{}),plan:enterResult.plan||null}:null,
                paperFilled:!!(enterResult&&enterResult.filled),
                codeVersion:CODE_VERSION,
              });
            }
          } catch(screenErr) {
            run.last_screening_error=failure(screenErr);
          }
        }
      }
      analyzed.push(row.token);
    } catch(error) {
      const kind=classifyError(error);
      store.bump(kind);
      run.last_pool_error={token:row.token,error:failure(error),kind,at:Date.now()};
    } finally {
      store.db.prepare('UPDATE pools SET last_analyzed_at=? WHERE token=?').run(now,row.token);
    }
  }
  if(!io.skipCatalog&&!io.syncCatalog) {
    try {run.catalog_backfill=await syncCatalog(store,block,{...io,catalogMaxBlocks:6000n,deadline:Math.min(t0+53000,Date.now()+8000)});}
    catch(error) {run.last_pool_error={token:null,error:failure(error),kind:classifyError(error),at:Date.now()};}
  }
  await exitCheck();
  // Warm one watch's full holder history after price collection and catalog.
  // Injected offline collectors never make this extra network request.
  if(!io.collectBuckets&&!io.blockContext&&watch.live.length&&Date.now()+2500<t0+58000) {
    // A pool that just signalled is the one whose holder history is about to be needed, so
    // warm it next instead of waiting its turn: histories run from each token's own birth
    // block and a rotation of four never catches a pool up before its seat expires.
    const signalled=new Set(signals.map(s=>s.token));
    const queue=watch.live.filter(r=>signalled.has(r.token));
    const from=queue.length?queue:watch.live;
    const row=from[(run.rounds||0)%from.length];
    // Keep this small. Raising it to 28 chunks tripled the log request rate, the public
    // endpoint answered 429, and the 30s pause that follows dumped collection onto the
    // 10-block Alchemy path: the live cursor fell 588k blocks behind and cycles reported
    // analyzed=0. Holder history only gates safety on signals that occur; collection is
    // what produces them, so collection wins the budget.
    try {
      const h=await warmHolderHistory(row.token,block.number,{
        birthUpper:row.registered_block??row.first_seen_block,
        deadline:Math.min(t0+57000,Date.now()+12000),maxChunks:8,
      });
      run.holder_history={token:row.token,complete:h.complete,stage:h.stage,cursor:h.cursor,at:Date.now()};
    } catch(e) {run.holder_history={token:row.token,error:failure(e),at:Date.now()};}
  }
  await exitCheck();
  Object.assign(run,readRun(store),{
    status:run.status,last_started_at:run.last_started_at,code_version:CODE_VERSION,exits_ms:run.exits_ms,
    live_watch:run.live_watch,last_pool_error:run.last_pool_error,
    holder_history:run.holder_history,discovery_activity:run.discovery_activity,catalog_backfill:run.catalog_backfill,
  });
  // Apply this cycle's FX diagnostics after merging persisted collector state.
  run.usd_source_age_sec=usdSourceAge(rates,now/1000);
  run.usd_source_older_than_120s=run.usd_source_age_sec>STALE_SEC;
  run.collect_deferred=deferred;
  run.rpc_profile=rpcProfile.slice(0,20);
  run.log_rpc_health={...logRpcHealth};
  run.miss_counts=store.db.prepare('SELECT reason,count(*) c FROM minute_status GROUP BY reason').all();
  run.rpc_gap_counts=store.db.prepare('SELECT reason,count(*) c FROM coverage_gaps GROUP BY reason').all();
  for(const s of ['A','B','C']) accounts[s]=readAccount(store,s);
  const delay=Date.now()-t0;
  run.last_completed_at=Date.now();
  run.last_block=String(block.number);
  run.last_block_ts=Number(block.timestamp);
  run.cycle_ms=delay;
  run.cycle_overrun=delay>CYCLE_TARGET_MS;
  run.analyzed=analyzed.length;
  run.catalog=catalogStats(store);
  run.catalog_delta=catalog;
  run.warmup=warmup;
  run.signals=signals;
  const blk=logBlocksNeeded(store);
  run.coverage={analyzed:analyzed.length,supported:run.catalog.supported,live_watch:watch.n,catalog_ok:watch.catalog_ok,
    blocks_per_sec:Number(blk)/90,log_blocks_per_pool:String(blk),note:watch.note};
  run.accounts=Object.fromEntries(['A','B','C'].map(k=>{
    const a=accounts[k];
    return [k,{cash:a.cash,equity:a.equity,realized:a.realized,unrealized:a.unrealized,positions:a.positions.length,
      halted_permanent:a.halted_permanent,halted_day:a.halted_day,rejects:a.reject_counts,problems:a.problems}];
  }));
  run.fresh_at=Date.now();
  run.status=ending?(existsSync(resolve(store.dir,'stop.json'))?'STOPPING':'ENDING'):'WAITING';
  if(delay>CYCLE_TARGET_MS) run.last_delay_ms=delay;
  writeRun(store,run);
  save(resolve(store.dir,'status.json'),run);
  return run;
}

export async function worker(hours,foreground=false) {
  const dir=abcDir();
  const lock=acquireLock(dir);
  const stopPath=resolve(dir,'stop.json');
  if(existsSync(stopPath)) unlinkSync(stopPath);
  const store=openAbc(dir);
  let stopping=false;
  const onStop=()=>{
    if(stopping) process.exit(0);
    stopping=true;save(resolve(dir,'stop.json'),{requested_at:Date.now(),pid:process.pid});
  };
  process.on('SIGTERM',onStop);process.on('SIGINT',onStop);
  try {
    initAccounts(store);
    migrateCSize(store);
    for(const strategy of ['A','B','C']) {
      const account=readAccount(store,strategy);
      account.model='SIMULATED_ROUTE_AND_NODE_GAS_V11';
      writeAccount(store,account);
    }
    let run=readRun(store);
    if(run&&run.code_version!==CODE_VERSION) {
      if(!run.code_version||run.code_version==='abc-phase1-v1') {
        markV1BucketsInvalid(store);
        run.v1_buckets_invalidated=true;
      }
      isolateNonContemporaneousFx(store);
      if(!['abc-phase1-v10','abc-phase1-v11'].includes(run.code_version)) extendActiveWatchBounds(store);
      run.code_version=CODE_VERSION;
      writeRun(store,run);
    }
    const carried=invalidateCarriesAcrossGaps(store);
    if(run&&carried) {run.gap_carries_invalidated=(run.gap_carries_invalidated||0)+carried;writeRun(store,run);}
    const now=Date.now();
    if(!run||!run.started_at) {
      if(!Number.isFinite(hours)||hours<=0||hours>DEFAULT_HOURS) throw new Error('Hours must be in (0,336]');
      run={id:new Date(now).toISOString().replace(/[:.]/g,'-'),pid:process.pid,mode:'ABC_PAPER_NOT_LIVE',
        started_at:now,ends_at:now+hours*3600000,hours,status:'STARTING',version:STRATEGY_VERSION,code_version:CODE_VERSION,
        catalog_cursor:null,rounds:0,failed_rounds:0,foreground,pnl_note:'Virtual USD paper fills; not live trades'};
    } else {
      run.pid=process.pid;run.status='RESUMED';run.foreground=foreground;
      delete run.finished_at;delete run.unclosed;
    }
    writeRun(store,run);save(resolve(dir,'status.json'),run);
    await notifySafe(run,`start:${run.started_at}`,`▶️ ABC PAPER 模拟（非实盘）已启动\n时长至 ${new Date(run.ends_at).toISOString()}\n分策略观察槽 ${LIVE_WATCH_N} 个：A/B 与年轻 C 分开，按已观测活跃度轮换，不是全目录。不签名、不广播。`);
    let lastExitStart=null;
    while(!stopping&&Date.now()<run.ends_at&&!existsSync(resolve(dir,'stop.json'))) {
      run=readRun(store);
      const tickStart=Date.now();
      const interval=lastExitStart==null?null:tickStart-lastExitStart;
      lastExitStart=tickStart;
      run.exit_start_interval_ms=interval;
      run.exit_tick_starts=(run.exit_tick_starts||[]).concat(tickStart).slice(-30);
      writeRun(store,run);
      try {
        const snap=await cycle(store,tickStart);
        run=readRun(store);run.rounds=(run.rounds||0)+1;writeRun(store,run);
        save(resolve(store.dir,'status.json'),run);
        const accs=['A','B','C'].map(s=>readAccount(store,s));
        for(const a of accs) {
          for(const t of a.trades) {
            if(!t.id) continue;
            await notifySafe(run,`fill:${t.id}`,`🧾 ABC PAPER 成交（非实盘）\n策略${a.strategy} ${t.side} ${t.token}\n数量（代币原始单位）：${t.qty}\n${t.side==='buy'?'含费支出':'扣费收入'} USD：${Number(t.net).toFixed(4)}\n成交时间：${new Date(t.at).toISOString()}\n成交编号：${t.id}\n原因：${t.reason}`);
          }
          if(a.halted_permanent) await notifySafe(run,`halt:${a.strategy}:perm`,`🛑 ABC PAPER ${a.strategy} 永久停止新买（净值<=200），继续尝试可报价退出。`);
          if(a.halted_day) await notifySafe(run,`halt:${a.strategy}:day:${a.day_key}`,`🛑 ABC PAPER ${a.strategy} 当日亏损熔断，停止新买。`);
        }
        if(run.last_pool_error&&run.last_pool_error.kind==='SOURCE_UNAVAILABLE') {
          const key=`src:${run.last_pool_error.kind}:${String(run.last_pool_error.error).slice(0,40)}`;
          await notifySafe(run,key,`⚠️ ABC PAPER 源故障变化\n${run.last_pool_error.kind}\n${run.last_pool_error.error}\n本轮不伪造K线或成交。`);
        }
      } catch(error) {
        const kind=classifyError(error);
        store.bump(kind);
        run=readRun(store);
        run.failed_rounds=(run.failed_rounds||0)+1;
        run.status='WAITING_AFTER_SOURCE_ERROR';
        run.last_error=failure(error);
        run.last_error_kind=kind;
        for(const s of ['A','B','C']) {
          const a=readAccount(store,s);
          a.equity=null;a.unrealized=null;a.entry_frozen_reason='EQUITY_UNKNOWN';
          a.problems=[{error:failure(error),freeze:true}];
          writeAccount(store,a);
        }
        writeRun(store,run);save(resolve(dir,'status.json'),run);
        if(run.prev_error!==run.last_error) await notifySafe(run,`err:${run.failed_rounds}`,`⚠️ ABC PAPER 本轮失败（非实盘）\n${kind}\n${run.last_error}\n净值置 null，不伪造行情。`);
        run.prev_error=run.last_error;writeRun(store,run);
      }
      await notifyDaily(store,run);
      const next=Math.min(nextTickDeadline(tickStart),run.ends_at);
      const shouldStop=()=>stopping||existsSync(resolve(dir,'stop.json'));
      while(Date.now()<next&&!shouldStop()) {
        await sleepUntil(Math.min(Date.now()+EXIT_TICK_MS,next),shouldStop,200);
        if(shouldStop()||Date.now()>=next) break;
        try {
          const tick=await exitOnlyTick(store,Date.now());
          if(tick.checked) {
            run=readRun(store);
            run.exit_ticks=(run.exit_ticks||0)+1;run.last_exit_tick_at=Date.now();
            writeRun(store,run);
          }
        } catch(error) {
          // A failed between-cycle check is diagnostic only; the next full cycle still marks.
          run=readRun(store);
          run.last_exit_tick_error={error:failure(error),kind:classifyError(error),at:Date.now()};
          writeRun(store,run);
        }
      }
    }
    run=readRun(store);
    const accs=['A','B','C'].map(s=>readAccount(store,s));
    const unclosed=accs.flatMap(a=>a.positions.map(p=>({strategy:a.strategy,...p})));
    run.status=existsSync(resolve(dir,'stop.json'))?'STOPPED':'COMPLETED';
    run.unclosed=unclosed;
    run.finished_at=Date.now();
    writeRun(store,run);
    save(resolve(dir,'status.json'),run);
    save(resolve(dir,'report.json'),reportFromAccounts(accs,run,catalogStats(store)));
    await notifySafe(run,`end:${run.started_at}`,`⏹ ABC PAPER 结束：${run.status}\n未平仓 ${unclosed.length} 个（保留，未虚构平仓）。\n未执行实盘。`);
  } finally {
    store.close();releaseLock(dir);
  }
}
export function printStatus(dir) {
  const path=resolve(dir,'status.json');
  console.log(existsSync(path)?readFileSync(path,'utf8'):'Not started');
}

export function printReport(dir) {
  const store=openAbc(dir);
  try {
    initAccounts(store);
    const run=readRun(store);
    if(!run) {console.log('Not started');return;}
    const accs=['A','B','C'].map(s=>readAccount(store,s));
    console.log(stringify(reportFromAccounts(accs,run,catalogStats(store))));
  } finally {store.close();}
}
