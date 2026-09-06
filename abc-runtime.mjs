import {existsSync,readFileSync,unlinkSync,writeSync,openSync,closeSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {ROOT,client,save,failure} from './chain.mjs';
import {broadcast,enabled} from './telegram.mjs';
import {
  abcDir,openAbc,initAccounts,readAccount,writeAccount,readRun,writeRun,
  syncCatalog,graduationTs,loadBuckets,
  enrichPool,collectBuckets,catalogStats,assertFreshness,
  ANALYZE_LIMIT,CYCLE_TARGET_MS,DEFAULT_HOURS,STRATEGY_VERSION,
  classifyError,blockContext,usdRates,stringify,usdSourceAge,STALE_SEC,
  markV1BucketsInvalid,CODE_VERSION,COLLECT_BUDGET_MS,
  slimSignalResult,poolFromRow,isolateNonContemporaneousFx,
  pickLiveWatch,skipBacklogForLive,LIVE_WATCH_N,saveFxSnap,logBlocksNeeded,
  extendActiveWatchBounds,
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
    if(!/^(fill:|halt:|hourly-holdings:)/.test(key)||!enabled()) return {skipped:true};
    try {return await broadcast('abc:'+key,text);}
    catch(e) {run.telegram_error=failure(e);return {error:failure(e)};}
  })();
}

function accountSummary(a) {
  const money=v=>v==null?'不可用':Number(v).toFixed(2);
  return `策略 ${a.strategy}：现金 ${money(a.cash)}，净值 ${money(a.equity)} USD\n已实现 ${money(a.realized)}，浮动 ${money(a.unrealized)}；持仓 ${a.positions.length}，熔断 ${a.halted_permanent?'累计':a.halted_day?'当日':'无'}\n`+
    (a.positions.length?a.positions.map(p=>`${p.token}：估值 ${money(p.mark)} USD`).join('\n'):'当前空仓');
}

export async function notifyHourlyHoldings(store,run) {
  const hour=new Date().toISOString().slice(0,13);
  if(run.last_holdings_hour===hour) return;
  const accs=['A','B','C'].map(s=>readAccount(store,s));
  const result=await notifySafe(run,`hourly-holdings:${run.started_at}:${hour}`,
    `📊 ABC 每小时持仓（纸面模拟，非实盘）\n报告时间：${new Date().toISOString()}\n状态：${run.status}\n最近完成轮：${run.last_completed_at?new Date(run.last_completed_at).toISOString():'尚无'}\n${accs.map(accountSummary).join('\n\n')}`);
  if(result?.message_id||result?.duplicate) run.last_holdings_hour=hour;
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

export async function cycle(store,now=Date.now(),io={}) {
  const t0=Date.now();
  ensureScreeningSchema(store);
  const run=readRun(store);
  run.status='CYCLE';run.last_started_at=now;run.code_version=CODE_VERSION;
  writeRun(store,run);
  const block=await (io.blockContext||blockContext)();
  const rates=await (io.usdRates||usdRates)();
  assertFreshness(block,rates,now/1000);
  saveFxSnap(store,rates);
  run.usd_source_age_sec=usdSourceAge(rates,now/1000);
  run.usd_source_older_than_120s=run.usd_source_age_sec>STALE_SEC;
  const gasPrice=io.gasPrice!=null?io.gasPrice:await client.getGasPrice();
  const accounts={};
  for(const s of ['A','B','C']) accounts[s]=readAccount(store,s);
  const held=[...new Set(['A','B','C'].flatMap(k=>accounts[k].positions.map(p=>p.token)))];
  for(const s of ['A','B','C']) accounts[s]=await markAndExit(store,accounts[s],block,rates,gasPrice,now,io);
  run.exits_ms=Date.now()-t0;
  const collectDeadline=io.deadline|| (t0+(io.collectBudgetMs??COLLECT_BUDGET_MS));
  Object.assign(run,readRun(store),{status:run.status,last_started_at:run.last_started_at,code_version:CODE_VERSION,exits_ms:run.exits_ms});
  const ending=now>=run.ends_at||existsSync(resolve(store.dir,'stop.json'));
  const watch=pickLiveWatch(store,held,io.liveWatchN??LIVE_WATCH_N);
  run.live_watch={n:watch.n,catalog_ok:watch.catalog_ok,tokens:watch.live.map(r=>r.token),note:watch.note};
  const queue=watch.live;
  const analyzed=[];
  const warmup={A:0,B:0,C:0};
  const signals=[];
  const rpcProfile=[];
  let deferred=0;
  const rpcIo={...io,deadline:collectDeadline,rpcProfile,rpcEpoch:io.rpcEpoch||0};
  for(const row of [...held.map(t=>store.db.prepare('SELECT * FROM pools WHERE token=?').get(t)).filter(Boolean),...queue]) {
    if(analyzed.includes(row.token)) continue;
    if(Date.now()>collectDeadline) {deferred++;continue;}
    try {
      const cached=poolFromRow(row);
      const pool=cached||await (io.enrichPool||enrichPool)(store,row.token,block.number);
      if(!io.skipLiveJump) await skipBacklogForLive(store,row,block,rpcIo);
      const liveRow=store.db.prepare('SELECT * FROM pools WHERE token=?').get(row.token)||row;
      await (io.collectBuckets||collectBuckets)(store,liveRow,pool,block,rates,rpcIo);
      const fresh=store.db.prepare('SELECT * FROM pools WHERE token=?').get(row.token)||row;
      const grad=graduationTs(fresh);
      const lastComplete=Math.floor(Number(block.timestamp)/60)*60-60;
      const buckets=loadBuckets(store,row.token,lastComplete-8*3600,lastComplete+60);
      for(const strat of ['A','B','C']) {
        const acc=accounts[strat];
        const prev=acc.signal_state[row.token]||null;
        const ev=evaluators[strat](buckets,prev,grad,lastComplete);
        acc.signal_state[row.token]=ev.persist;
        if(ev.reason) {
          // Keep aggregate NO_T (and other reasons) exactly as before for reject_counts compatibility
          acc.reject_counts[ev.reason]=(acc.reject_counts[ev.reason]||0)+1;
          if(String(ev.reason).startsWith('WARMUP')) warmup[strat]++;
        }
        writeAccount(store,acc);
        let enterResult=null;
        if(ev.signal&&!ending) {
          const result=await tryEnter(store,acc,row.token,ev.signal,pool,block,rates,gasPrice,now,io);
          enterResult=result;
          Object.assign(acc,readAccount(store,acc.strategy));
          signals.push({strategy:strat,token:row.token,minute:ev.signal.minute,result:slimSignalResult(result)});
        }
        // Diagnose-only unique eval row; does not gate buys
        try {
          if(!io.skipScreeningRecord) {
            recordEvalFromCycle(store,{
              strategy:strat,token:row.token,minute:lastComplete,ev,gradTs:grad,watched:true,
              buckets,pool,safety:enterResult?{...(enterResult.safety||{}),plan:enterResult.plan||null}:null,
              paperFilled:!!(enterResult&&enterResult.filled),
              codeVersion:CODE_VERSION,
            });
          }
        } catch(screenErr) {
          run.last_screening_error=failure(screenErr);
        }
      }
      analyzed.push(row.token);
    } catch(error) {
      const kind=classifyError(error);
      store.bump(kind);
      run.last_pool_error={token:row.token,error:failure(error),kind};
    } finally {
      store.db.prepare('UPDATE pools SET last_analyzed_at=? WHERE token=?').run(now,row.token);
    }
  }
  let catalog={added:0};
  if(!io.skipCatalog&&Date.now()<collectDeadline) {
    try {catalog=await (io.syncCatalog||syncCatalog)(store,block,rpcIo);}
    catch(error) {run.last_pool_error={token:null,error:failure(error),kind:classifyError(error)};}
  }
  Object.assign(run,readRun(store),{
    status:run.status,last_started_at:run.last_started_at,code_version:CODE_VERSION,exits_ms:run.exits_ms,
    live_watch:run.live_watch,last_pool_error:run.last_pool_error,
  });
  run.collect_deferred=deferred;
  run.rpc_profile=rpcProfile.slice(0,20);
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
    let run=readRun(store);
    if(run&&run.code_version!==CODE_VERSION) {
      if(!run.code_version||run.code_version==='abc-phase1-v1') {
        markV1BucketsInvalid(store);
        run.v1_buckets_invalidated=true;
      }
      isolateNonContemporaneousFx(store);
      extendActiveWatchBounds(store);
      run.code_version=CODE_VERSION;
      writeRun(store,run);
    }
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
    await notifySafe(run,`start:${run.started_at}`,`▶️ ABC PAPER 模拟（非实盘）已启动\n时长至 ${new Date(run.ends_at).toISOString()}\n固定观察槽 ${LIVE_WATCH_N} 个、最长保留36h（毕业+24h后再观察2h），不是全目录。不签名、不广播。`);
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
      await notifyHourlyHoldings(store,run);
      const next=Math.min(nextTickDeadline(tickStart),run.ends_at);
      await sleepUntil(next,()=>stopping||existsSync(resolve(dir,'stop.json')),200);
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
