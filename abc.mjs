import {spawn} from 'node:child_process';
import {openSync,closeSync,existsSync,readFileSync,unlinkSync,writeSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {formatUnits,zeroAddress} from 'viem';
import {ROOT,A,client,save,failure} from './chain.mjs';
import {broadcast,enabled} from './telegram.mjs';
import {
  abcDir,openAbc,initAccounts,readAccount,writeAccount,readRun,writeRun,
  syncCatalog,graduationTs,loadBuckets,bucketMap,takeWindow,uniqueRecipients,recipientShare,
  enrichPool,collectBuckets,plannedRoundTrip,plannedRoundTripFromQuotes,netExitValue,
  safetyScreen,requireRoundTrip,pickQueue,catalogStats,assertFreshness,quoteFresh,
  haircutQty,HAIRCUT_BPS,ANALYZE_LIMIT,CYCLE_TARGET_MS,DEFAULT_HOURS,STRATEGY_VERSION,
  classifyError,blockContext,usdRates,poolFor,quoteExact,quoteUsd,stringify,usdSourceAge,STALE_SEC,
  assertTradeFresh,markV1BucketsInvalid,CODE_VERSION,COLLECT_BUDGET_MS,
  slimSignalResult,poolFromRow,isolateNonContemporaneousFx,
  pickLiveWatch,skipBacklogForLive,LIVE_WATCH_N,rpcTimeout,saveFxSnap,logBlocksNeeded,
  extendActiveWatchBounds,
} from './abc-collect.mjs';

export function remainingFraction(p) {
  const q=BigInt(p.qty),i=BigInt(p.initialQty);
  if(i===0n) return 0;
  return Number(q*1000000000000n/i)/1e12;
}
export function pnlMultiple(p,netRemaining) {
  const f=remainingFraction(p);
  if(!(f>0)||!(p.cost>0)||!Number.isFinite(netRemaining)) return null;
  return (netRemaining/f)/p.cost;
}
export function utcDay(now=Date.now()) {return new Date(now).toISOString().slice(0,10);}

export function applyDayBaseline(account,now=Date.now()) {
  if(account.equity===null||account.equity===undefined||!Number.isFinite(account.equity)) {
    account.entry_frozen_reason='EQUITY_UNKNOWN';
    return account;
  }
  const day=utcDay(now);
  if(account.day_key!==day) {
    account.day_key=day;
    account.day_baseline=account.equity;
    account.halted_day=false;
  } else if(account.day_baseline==null) {
    account.day_baseline=account.equity;
  }
  if(account.day_baseline-account.equity>=30) account.halted_day=true;
  account.entry_frozen_reason=null;
  if(account.equity<=200) account.halted_permanent=true;
  if(Number.isFinite(account.equity)) {
    if(account.equity>account.peak_equity) account.peak_equity=account.equity;
    const dd=account.peak_equity-account.equity;
    if(dd>account.max_drawdown) {
      account.max_drawdown=dd;
      account.max_drawdown_pct=account.peak_equity>0?dd/account.peak_equity:0;
    }
  }
  return account;
}

export function canEnter(account) {
  if(account.halted_permanent) return 'HALTED_PERMANENT';
  if(account.halted_day) return 'HALTED_DAY_LOSS';
  if(account.entry_frozen_reason) return account.entry_frozen_reason;
  if(account.equity===null) return 'EQUITY_UNKNOWN';
  if(account.positions.length>=5) return 'MAX_POSITIONS';
  if(account.problems.some(p=>p.freeze)) return 'MARK_UNAVAILABLE';
  return null;
}

export function applyBuy(s,{token,qty,cost,block,signal_ts,signal_block,decision_ts,quote_block,fill_ts,reason,plan,version}) {
  if(s.halted_permanent||s.halted_day||s.cash-cost<s.reserve||s.positions.length>=5||s.seen.includes(token)) return false;
  if(!(cost>0&&cost<=s.spend_limit&&BigInt(qty)>0n)) throw new Error('INVALID_PAPER_BUY');
  const id=`${s.strategy}:buy:${token}:${signal_ts}:${s.trades.length}`;
  s.cash-=cost;s.seen.push(token);
  s.positions.push({token,qty:String(qty),initialQty:String(qty),cost,remainingCost:cost,proceeds:0,
    half:false,opened:fill_ts||Date.now(),open_block:String(block),signal_ts,signal_block:signal_block==null?null:String(signal_block),
    decision_ts,quote_block:String(quote_block||block),fill_ts,peak_multiple:1,trail_armed:false,
    mark:null,exit_incomplete:false,strategy_version:version||STRATEGY_VERSION});
  s.trades.push({id,side:'buy',token,qty:String(qty),net:cost,block:String(block),at:fill_ts||Date.now(),
    reason:reason||'entry',signal_ts,signal_block:signal_block==null?null:String(signal_block),
    decision_ts,quote_block:String(quote_block||block),fill_ts,plan,paper:true,abc:true,live:false,version:version||STRATEGY_VERSION});
  return true;
}

export function applySell(s,p,qty,net,reason,block,meta={}) {
  qty=BigInt(qty);const held=BigInt(p.qty);
  if(qty<=0n||qty>held||!Number.isFinite(net)) throw new Error('INVALID_PAPER_SELL');
  const allocated=p.remainingCost*Number(qty)/Number(held);
  const id=`${s.strategy}:sell:${p.token}:${p.signal_ts||p.opened}:${reason}:${s.trades.length}`;
  s.cash+=net;s.realized+=net-allocated;p.remainingCost-=allocated;p.proceeds+=net;p.qty=String(held-qty);
  if(reason==='partial_tp'||reason==='half') p.half=true;
  if(reason==='partial_tp') p.trail_armed=true;
  s.trades.push({id,side:'sell',token:p.token,qty:String(qty),net,reason,block:String(block),at:meta.fill_ts||Date.now(),
    signal_ts:p.signal_ts,signal_block:p.signal_block,decision_ts:meta.decision_ts||Date.now(),
    quote_block:String(meta.quote_block||block),fill_ts:meta.fill_ts||Date.now(),paper:true,abc:true,live:false,
    version:p.strategy_version||STRATEGY_VERSION});
  if(BigInt(p.qty)===0n) {
    s.closed_rounds.push({token:p.token,cost:p.cost,proceeds:p.proceeds,pnl:p.proceeds-p.cost,opened:p.opened,closed:meta.fill_ts||Date.now(),reason});
    s.positions=s.positions.filter(x=>x!==p);
  }
}

export function exitDecision(account,p,multiple,now) {
  if(!Number.isFinite(multiple)) return null;
  if(account.halted_permanent) return {reason:'risk',qty:'all'};
  const age=now-p.opened;
  const strat=account.strategy;
  if(strat==='A') {
    if(multiple<=0.88) return {reason:'stop',qty:'all'};
    if(age>=3600000&&(p.peak_multiple||0)<1.10) return {reason:'timeout',qty:'all'};
    if(!p.half&&multiple>=1.25) return {reason:'partial_tp',qty:'half_initial'};
    if(p.trail_armed&&p.peak_multiple&&multiple<=p.peak_multiple*0.88) return {reason:'trail',qty:'all'};
  } else if(strat==='B') {
    if(multiple<=0.85) return {reason:'stop',qty:'all'};
    if(age>=6*3600000) return {reason:'timeout',qty:'all'};
    if(!p.half&&multiple>=1.40) return {reason:'partial_tp',qty:'half_initial'};
    if(p.trail_armed&&p.peak_multiple&&multiple<=p.peak_multiple*0.82) return {reason:'trail',qty:'all'};
  } else if(strat==='C') {
    const recovered=p.proceeds>=p.cost;
    if(!recovered&&multiple<=0.80) return {reason:'stop',qty:'all'};
    if(!recovered&&age>=2*3600000&&(p.peak_multiple||0)<1.10) return {reason:'timeout',qty:'all'};
    if(!recovered&&multiple>=2) return {reason:'recover',qty:'binary_cover'};
    if(recovered&&!p.half&&multiple>=10) return {reason:'half',qty:'half_remaining'};
  }
  return null;
}

export function sellQtyFor(p,kind) {
  const held=BigInt(p.qty);
  if(kind==='all') return held;
  if(kind==='half_initial') {
    const half=BigInt(p.initialQty)/2n;
    return half>held?held:half;
  }
  if(kind==='half_remaining') return held/2n;
  return held;
}

function sum(rows,key) {return rows.reduce((a,r)=>a+(r[key]||0),0);}
function avg(rows,key) {return rows.length?sum(rows,key)/rows.length:null;}

export function evaluateA(buckets,persist,gradTs,minuteT) {
  const t=buckets.find(b=>b.minute===minuteT);
  if(!t||!(t.close_usd>0)) return {signal:null,persist:persist||{phase:'idle'},reason:'NO_T'};
  if(gradTs==null) return {signal:null,persist:persist||{phase:'idle'},reason:'GRADUATION_TIME_UNKNOWN'};
  if(minuteT-gradTs<2*3600) return {signal:null,persist:persist||{phase:'idle'},reason:'WARMUP_GRADUATION_LT_2H'};
  const map=bucketMap(buckets);
  const last30=takeWindow(map,minuteT-30*60,minuteT);
  if(!last30) return {signal:null,persist:persist||{phase:'idle'},reason:'WARMUP'};
  const Lnow=Math.max(...last30.map(b=>b.high_usd));
  let s=persist&&persist.phase?{...persist}:{phase:'idle'};
  if(s.phase==='fired') s={phase:'idle'};
  if(s.phase==='idle') {
    if(t.close_usd>Lnow*1.005) s={phase:'breakout',L:Lnow,breakout_minute:minuteT};
    return {signal:null,persist:s};
  }
  if(s.phase==='breakout') {
    const dt=(minuteT-s.breakout_minute)/60;
    if(dt<1) return {signal:null,persist:s};
    if(dt>15) return {signal:null,persist:{phase:'idle'},reason:'BREAKOUT_EXPIRED'};
    if(t.close_usd<s.L*0.98) return {signal:null,persist:{phase:'idle'},reason:'BREAKOUT_INVALIDATED'};
    if(t.low_usd>=s.L*0.98&&t.low_usd<=s.L*1.02&&t.close_usd>=s.L)
      return {signal:null,persist:{...s,phase:'pullback',pullback_minute:minuteT,pullback_high:t.high_usd}};
    return {signal:null,persist:s};
  }
  if(s.phase==='pullback') {
    const dt=(minuteT-s.pullback_minute)/60;
    if(dt<1) return {signal:null,persist:s};
    if(dt>10) return {signal:null,persist:{phase:'idle'},reason:'PULLBACK_EXPIRED'};
    if(t.close_usd<s.L*0.98) return {signal:null,persist:{phase:'idle'},reason:'BREAKOUT_INVALIDATED'};
    const last5=takeWindow(map,minuteT-5*60,minuteT);
    const prev5=takeWindow(map,minuteT-10*60,minuteT-5*60);
    if(!last5||!prev5) return {signal:null,persist:s,reason:'WINDOW_INCOMPLETE'};
    const nBuy=uniqueRecipients(last5).size,nPrev=uniqueRecipients(prev5).size;
    const net=sum(last5,'net_inflow_usd');
    if(t.close_usd>s.pullback_high&&net>0&&nBuy>nPrev&&nBuy>=8) {
      return {signal:{strategy:'A',minute:minuteT,L:s.L,block:t.source_block},persist:{phase:'fired',fire_minute:minuteT}};
    }
    return {signal:null,persist:s};
  }
  return {signal:null,persist:s};
}

export function evaluateB(buckets,persist,gradTs,minuteT) {
  const t=buckets.find(b=>b.minute===minuteT);
  if(!t||!(t.close_usd>0)) return {signal:null,persist:persist||{},reason:'NO_T'};
  if(gradTs==null) return {signal:null,persist:persist||{},reason:'GRADUATION_TIME_UNKNOWN'};
  if(minuteT-gradTs<24*3600) return {signal:null,persist:persist||{},reason:'WARMUP_GRADUATION_LT_24H'};
  const priced=buckets.filter(b=>b.minute<minuteT&&b.close_usd!=null);
  if(priced.length<120) return {signal:null,persist:persist||{},reason:'WARMUP_LT_120M'};
  const map=bucketMap(buckets);
  const last60=takeWindow(map,minuteT-60*60,minuteT);
  const prev60=takeWindow(map,minuteT-120*60,minuteT-60*60);
  const last15=takeWindow(map,minuteT-15*60,minuteT);
  const w1=takeWindow(map,minuteT-30*60,minuteT-15*60);
  const w2=takeWindow(map,minuteT-45*60,minuteT-30*60);
  const w3=takeWindow(map,minuteT-60*60,minuteT-45*60);
  const w4=takeWindow(map,minuteT-75*60,minuteT-60*60);
  if(!last60||!prev60||!last15||!w1||!w2||!w3||!w4) return {signal:null,persist:persist||{},reason:'WINDOW_INCOMPLETE'};
  if(last60.some(b=>b.close_usd==null)||prev60.some(b=>b.close_usd==null)) return {signal:null,persist:persist||{},reason:'WINDOW_INCOMPLETE'};
  const sma1=avg(last60,'close_usd'),sma2=avg(prev60,'close_usd');
  const recentHigh=Math.max(...last60.map(b=>b.high_usd));
  if(!(sma1>sma2)) return {signal:null,persist:persist||{phase:'idle'},reason:'SMA_NOT_RISING'};
  if(!(t.close_usd>recentHigh*1.005)) {
    const s=persist||{phase:'idle'};
    if(s.phase==='fired'&&t.close_usd<s.level) return {signal:null,persist:{phase:'armed',level:recentHigh}};
    return {signal:null,persist:s,reason:'NO_BREAKOUT'};
  }
  const vol=sum(last15,'volume_usd');
  const avgVol=(sum(w1,'volume_usd')+sum(w2,'volume_usd')+sum(w3,'volume_usd')+sum(w4,'volume_usd'))/4;
  if(!(avgVol>0&&vol>avgVol*1.5)) return {signal:null,persist:persist||{phase:'idle'},reason:'VOLUME_NOT_EXPANDED'};
  if(!(sum(last15,'net_inflow_usd')>0)) return {signal:null,persist:persist||{phase:'idle'},reason:'NET_INFLOW_NOT_POSITIVE'};
  if(uniqueRecipients(last15).size<8) return {signal:null,persist:persist||{phase:'idle'},reason:'BUYERS_LT_8'};
  const s=persist&&persist.phase?{...persist}:{phase:'idle'};
  if(s.phase==='fired') return {signal:null,persist:s,reason:'BREAKOUT_ALREADY_USED'};
  return {signal:{strategy:'B',minute:minuteT,level:recentHigh,block:t.source_block},persist:{phase:'fired',level:recentHigh,fire_minute:minuteT}};
}

export function evaluateC(buckets,persist,gradTs,minuteT) {
  const t=buckets.find(b=>b.minute===minuteT);
  if(!t||!(t.close_usd>0)) return {signal:null,persist:persist||{phase:'seek'},reason:'NO_T'};
  if(gradTs==null) return {signal:null,persist:persist||{phase:'seek'},reason:'GRADUATION_TIME_UNKNOWN'};
  const age=minuteT-gradTs;
  if(age>6*3600) return {signal:null,persist:persist||{phase:'seek'},reason:'GRADUATION_OVER_6H'};
  const map=bucketMap(buckets);
  const last30=takeWindow(map,minuteT-29*60,minuteT+60);
  const ready=!!last30&&!last30.some(b=>b.close_usd==null)&&age>=30*60;
  let s=persist&&persist.phase?{...persist}:{phase:'seek',low:null};
  if(s.phase==='fired') s={phase:'seek',low:t.low_usd};
  if(s.phase==='seek') {
    if(s.low==null||t.low_usd<s.low) {s.low=t.low_usd;s.low_minute=t.minute;}
    if(s.low_minute!=null&&t.minute>s.low_minute&&s.low>0&&t.high_usd>=s.low*1.30)
      s={phase:'wave',low:s.low,peak:t.high_usd,low_minute:s.low_minute};
    return {signal:null,persist:s,reason:ready?null:'WARMUP_LT_30_CONSECUTIVE'};
  }
  if(s.phase==='wave') {
    if(t.high_usd>s.peak) s={...s,peak:t.high_usd};
    if(t.close_usd<s.peak*0.70) return {signal:null,persist:{phase:'seek',low:t.low_usd},reason:'WAVE_INVALIDATED'};
    if(t.close_usd<=s.peak*0.85&&t.close_usd>=s.peak*0.70)
      return {signal:null,persist:{...s,phase:'pullback',pullback_start:minuteT,pullbacks:[minuteT]}};
    return {signal:null,persist:s};
  }
  if(s.phase==='pullback') {
    if(t.close_usd<s.peak*0.70) return {signal:null,persist:{phase:'seek',low:t.low_usd},reason:'WAVE_INVALIDATED'};
    const pullbacks=[...(s.pullbacks||[]),minuteT];
    s={...s,pullbacks};
    if(pullbacks.length<4) return {signal:null,persist:s};
    const prev3min=pullbacks.slice(-4,-1);
    const prev3=prev3min.map(m=>map.get(m)).filter(Boolean);
    if(prev3.length!==3) return {signal:null,persist:s,reason:'WINDOW_INCOMPLETE'};
    const last3=takeWindow(map,minuteT-3*60,minuteT);
    const prev3flow=takeWindow(map,minuteT-6*60,minuteT-3*60);
    const last5=takeWindow(map,minuteT-5*60,minuteT);
    if(!last3||!prev3flow||!last5) return {signal:null,persist:s,reason:'WINDOW_INCOMPLETE'};
    if(!ready) return {signal:null,persist:s,reason:age<30*60?'WARMUP_GRADUATION_LT_30M':'WARMUP_LT_30_CONSECUTIVE'};
    const sellNow=sum(last3,'sell_usd'),sellPrev=sum(prev3flow,'sell_usd');
    const net=sum(last3,'net_inflow_usd');
    const buyers=uniqueRecipients(last5).size;
    const conc=recipientShare(last5);
    if(!(t.close_usd>Math.max(...prev3.map(b=>b.high_usd)))) return {signal:null,persist:s};
    if(!(sellNow<sellPrev)) return {signal:null,persist:s,reason:'SELL_NOT_DRYING'};
    if(!(net>0)) return {signal:null,persist:s,reason:'NET_INFLOW_NOT_POSITIVE'};
    if(buyers<8) return {signal:null,persist:s,reason:'BUYERS_LT_8'};
    if(!(conc.buy>0)||conc.share>0.25) return {signal:null,persist:s,reason:'CONCENTRATION_OVER_25_PERCENT'};
    return {signal:{strategy:'C',minute:minuteT,peak:s.peak,block:t.source_block},persist:{phase:'fired',fire_minute:minuteT,peak:s.peak}};
  }
  return {signal:null,persist:s};
}

export function signalId(strategy,token,minute) {return `${strategy}:${token}:${minute}`;}

const evaluators={A:evaluateA,B:evaluateB,C:evaluateC};

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
    if(!/^(fill:|halt:)/.test(key)||!enabled()) return {skipped:true};
    try {return await broadcast('abc:'+key,text);}
    catch(e) {run.telegram_error=failure(e);return {error:failure(e)};}
  })();
}

function accountSummary(a) {
  return `${a.strategy}: cash=${a.cash.toFixed(2)} equity=${a.equity==null?'null':a.equity.toFixed(2)} realized=${a.realized.toFixed(4)} pos=${a.positions.length} halt=${a.halted_permanent?'perm':a.halted_day?'day':'no'}`;
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

export function recomputeEquity(account) {
  if(account.positions.some(p=>p.mark==null&&BigInt(p.qty)>0n)) {
    account.equity=null;account.unrealized=null;return account;
  }
  let total=account.cash,unreal=0;
  for(const p of account.positions) {total+=p.mark;unreal+=p.mark-p.remainingCost;}
  account.equity=total;account.unrealized=unreal;return account;
}

export async function markAndExit(store,account,block,rates,gasPrice,now,io={}) {
  const quoteNet=io.netExitValue||netExitValue;
  const getPool=io.poolFor||poolFor;
  const clock=io.now||(()=>Date.now());
  const problems=[];
  for(const p of account.positions) {
    try {
      const pool=await getPool(p.token,block.number);
      const marked=await quoteNet(pool,p.qty,block,rates,gasPrice);
      p.mark=marked.mark;p.mark_raw=marked.net;p.mark_block=String(block.number);p.exit_incomplete=false;
      const multiple=pnlMultiple(p,marked.mark);
      if(multiple!=null&&multiple>(p.peak_multiple||0)) p.peak_multiple=multiple;
    } catch(error) {
      p.mark=null;p.exit_incomplete=true;account.failed_sells++;account.exit_incomplete++;
      problems.push({token:p.token,error:failure(error),freeze:true});
    }
  }
  account.problems=problems;
  recomputeEquity(account);
  applyDayBaseline(account,now);
  writeAccount(store,account);
  for(const p of [...account.positions]) {
    if(p.mark==null) continue;
    const multiple=pnlMultiple(p,p.mark);
    const dec=exitDecision(account,p,multiple,now);
    if(!dec) continue;
    try {
      const pool=await getPool(p.token,block.number);
      let qty=sellQtyFor(p,dec.qty);
      if(dec.reason==='recover') {
        const target=p.cost-p.proceeds;
        let lo=1n,hi=qty;
        for(let i=0;i<14&&lo<hi;i++) {
          const mid=(lo+hi)/2n;
          const q=await quoteNet(pool,mid,block,rates,gasPrice);
          if(q.net>=target) hi=mid;else lo=mid+1n;
        }
        qty=hi;
      }
      if(qty===0n) continue;
      const commitAt=clock();
      const stale=assertTradeFresh(block,rates,commitAt);
      if(stale) {p.exit_incomplete=true;count(account,stale);writeAccount(store,account);continue;}
      const fill=await quoteNet(pool,qty,block,rates,gasPrice);
      if(fill.uneconomic||fill.net<0) {
        p.exit_incomplete=true;count(account,'UNECONOMIC_EXIT');writeAccount(store,account);continue;
      }
      if(dec.reason==='recover'&&fill.net<p.cost-p.proceeds) throw new Error('RECOVERY_QUOTE_BELOW_TARGET');
      applySell(account,p,qty,fill.net,dec.reason,block.number,{quote_block:block.number,decision_ts:now,fill_ts:commitAt});
      if(account.positions.includes(p)&&BigInt(p.qty)>0n) {
        const rem=await quoteNet(pool,p.qty,block,rates,gasPrice);
        p.mark=rem.mark;p.mark_raw=rem.net;
      }
      recomputeEquity(account);
      applyDayBaseline(account,commitAt);
      writeAccount(store,account);
    } catch(error) {
      p.mark=null;p.exit_incomplete=true;account.failed_sells++;account.exit_incomplete++;
      account.problems.push({token:p.token,error:failure(error),freeze:true});
      recomputeEquity(account);writeAccount(store,account);
    }
  }
  return account;
}

export async function tryEnter(store,account,token,signal,pool,block,rates,gasPrice,now,io={}) {
  const clock=io.now||(()=>Date.now());
  const quoteNet=io.netExitValue||netExitValue;
  const sid=signalId(account.strategy,token,signal.minute);
  if(account.used_signals.includes(sid)) return {skipped:'IDEMPOTENT'};
  const frozen=canEnter(account);
  if(frozen) {count(account,frozen);writeAccount(store,account);return {skipped:frozen};}
  if(account.seen.includes(token)) {count(account,'ALREADY_OWNED');writeAccount(store,account);return {skipped:'ALREADY_OWNED'};}
  if(Number(block.timestamp)<signal.minute+60) {count(account,'FILL_BEFORE_SIGNAL_COMPLETE');writeAccount(store,account);return {skipped:'FILL_BEFORE_SIGNAL_COMPLETE'};}
  const screen=await (io.safetyScreen||safetyScreen)(store,pool,block,rates);
  if(!screen.ok) {for(const r of screen.reasons) count(account,r);writeAccount(store,account);return {skipped:screen.reasons.join(',')};}
  const principal=account.principal_limit;
  let plan;
  try {plan=await (io.plannedRoundTrip||plannedRoundTrip)(pool,principal,block,rates,gasPrice,HAIRCUT_BPS);}
  catch(error) {count(account,classifyError(error));writeAccount(store,account);return {skipped:failure(error)};}
  if(plan.cash_out>account.spend_limit) {count(account,'CASH_OUT_OVER_CAP');writeAccount(store,account);return {skipped:'CASH_OUT_OVER_CAP'};}
  if(account.cash-plan.cash_out<account.reserve) {count(account,'RESERVE_FLOOR');writeAccount(store,account);return {skipped:'RESERVE_FLOOR'};}
  if(!(plan.loss_pct<=0.05)) {count(account,'ROUND_TRIP_COST_OVER_5_PERCENT');writeAccount(store,account);return {skipped:'ROUND_TRIP_COST_OVER_5_PERCENT'};}
  const sim=await (io.requireRoundTrip||requireRoundTrip)(pool,plan.amountIn,block);
  if(!sim.ok) {count(account,sim.reason==='USDG_SIMULATION_REQUIRES_FUNDED_ACCOUNT'?sim.reason:'ROUND_TRIP_SIM_FAILED');writeAccount(store,account);return {skipped:sim.reason};}
  let stress={};
  try {
    if(io.stress) stress=io.stress;
    else for(const bps of [150n,300n]) {
      const qty=haircutQty(plan.buy.amountOut,bps);
      const sell=await quoteExact(pool,pool.token,qty,block.number);
      stress['bps_'+String(bps)]=plannedRoundTripFromQuotes(plan.buy,sell,pool,principal,qty,rates,gasPrice,bps);
    }
  } catch {stress.incomplete=true;}
  const commitAt=clock();
  const stale=assertTradeFresh(block,rates,commitAt);
  if(stale) {count(account,stale);writeAccount(store,account);return {skipped:stale};}
  const ok=applyBuy(account,{token,qty:plan.qty,cost:plan.cash_out,block:block.number,signal_ts:signal.minute,
    signal_block:signal.block,decision_ts:now,quote_block:block.number,fill_ts:commitAt,reason:'entry',
    plan:{loss_pct:plan.loss_pct,buy_gas:plan.buyGas,sell_gas:plan.sellGas,haircut_bps:50,stress,simulation:sim.sim?.status},
    version:STRATEGY_VERSION});
  if(!ok) {count(account,'APPLY_BUY_REJECTED');writeAccount(store,account);return {skipped:'APPLY_BUY_REJECTED'};}
  account.used_signals.push(sid);
  try {
    const marked=await quoteNet(pool,plan.qty,block,rates,gasPrice);
    const pos=account.positions.find(p=>p.token===token);
    if(pos) {pos.mark=marked.mark;pos.mark_raw=marked.net;}
  } catch {const pos=account.positions.find(p=>p.token===token);if(pos) pos.mark=null;}
  recomputeEquity(account);
  applyDayBaseline(account,commitAt);
  writeAccount(store,account);
  return {filled:true,plan};
}
function count(account,reason) {
  account.reject_counts[reason]=(account.reject_counts[reason]||0)+1;
}

export function nextTickDeadline(tickStart,interval=CYCLE_TARGET_MS) {
  return tickStart+interval;
}
export async function sleepUntil(deadline,shouldStop,stepMs=50) {
  while(Date.now()<deadline&&!(shouldStop&&shouldStop())) await new Promise(r=>setTimeout(r,stepMs));
}

export async function cycle(store,now=Date.now(),io={}) {
  const t0=Date.now();
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
          acc.reject_counts[ev.reason]=(acc.reject_counts[ev.reason]||0)+1;
          if(String(ev.reason).startsWith('WARMUP')) warmup[strat]++;
        }
        writeAccount(store,acc);
        if(ev.signal&&!ending) {
          const result=await tryEnter(store,acc,row.token,ev.signal,pool,block,rates,gasPrice,now,io);
          Object.assign(acc,readAccount(store,acc.strategy));
          signals.push({strategy:strat,token:row.token,minute:ev.signal.minute,result:slimSignalResult(result)});
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
        const hour=new Date().toISOString().slice(0,13);
        if(run.rounds===1||run.last_summary_hour!==hour) {
          await notifySafe(run,`hour:${hour}`,`📊 ABC PAPER 每小时摘要（非实盘）\n轮次：${run.rounds} 失败轮：${run.failed_rounds||0}\n覆盖：分析${run.analyzed}/${run.catalog?.supported||0} 池（上限${ANALYZE_LIMIT}）\n${accs.map(accountSummary).join('\n')}\n未执行实盘。`);
          run.last_summary_hour=hour;writeRun(store,run);
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

function printStatus(dir) {
  const path=resolve(dir,'status.json');
  console.log(existsSync(path)?readFileSync(path,'utf8'):'Not started');
}

function printReport(dir) {
  const store=openAbc(dir);
  try {
    initAccounts(store);
    const run=readRun(store);
    if(!run) {console.log('Not started');return;}
    const accs=['A','B','C'].map(s=>readAccount(store,s));
    console.log(stringify(reportFromAccounts(accs,run,catalogStats(store))));
  } finally {store.close();}
}

const cmd=process.argv[2];
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const dir=abcDir();
  if(cmd==='start') {
    if(existsSync(resolve(dir,'pid'))) {
      const pid=Number(readFileSync(resolve(dir,'pid'),'utf8'));
      let alive=false;try{process.kill(pid,0);alive=true;}catch(e){if(e.code!=='ESRCH') throw e;}
      if(alive) throw new Error('ABC simulation already running: '+pid);
      unlinkSync(resolve(dir,'pid'));
    }
    const hours=Number(process.argv[3]||DEFAULT_HOURS);
    if(!Number.isFinite(hours)||hours<=0||hours>DEFAULT_HOURS) throw new Error('Hours must be in (0,336]');
    mkdirSync(dir,{recursive:true});
    const log=openSync(resolve(dir,'process.log'),'a',0o600);
    const child=spawn(process.execPath,[resolve(ROOT,'abc.mjs'),'worker',String(hours)],{cwd:ROOT,detached:true,stdio:['ignore',log,log]});
    child.unref();closeSync(log);console.log('ABC paper simulation dispatched, PID '+child.pid);
  } else if(cmd==='run') {
    worker(Number(process.argv[3]||DEFAULT_HOURS),true).catch(e=>{console.error(failure(e));process.exitCode=1;});
  } else if(cmd==='worker') {
    worker(Number(process.argv[3]||DEFAULT_HOURS),false).catch(e=>{console.error(failure(e));process.exitCode=1;});
  } else if(cmd==='status') printStatus(dir);
  else if(cmd==='stop') {
    save(resolve(dir,'stop.json'),{requested_at:Date.now()});
    if(existsSync(resolve(dir,'pid'))) {
      const pid=Number(readFileSync(resolve(dir,'pid'),'utf8'));
      try {process.kill(pid,'SIGTERM');} catch(e) {if(e.code!=='ESRCH') throw e;}
    }
    console.log('ABC stop requested; worker finishes current cycle.');
  } else if(cmd==='report') printReport(dir);
  else throw new Error('Usage: node abc.mjs start [hours] | run [hours] | status | stop | report');
}
