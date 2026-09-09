import {failure} from './chain.mjs';
import {
  readAccount,writeAccount,plannedRoundTrip,plannedRoundTripFromQuotes,netExitValue,
  requireRoundTrip,haircutQty,HAIRCUT_BPS,STRATEGY_VERSION,ROUND_TRIP_LOSS_MAX,
  classifyError,quoteExact,assertTradeFresh,poolFor,
} from './abc-collect.mjs';
import {
  applyDayBaseline,canEnter,applyBuy,applySell,exitDecision,sellQtyFor,recomputeEquity,pnlMultiple,
} from './abc-paper.mjs';
import {signalId} from './abc-strategy.mjs';
import {safetyScreen} from './abc-safety-evidence.mjs';

export async function markAndExit(store,account,block,rates,gasPrice,now,io={}) {
  const quoteNet=io.netExitValue||netExitValue;
  const getPool=io.poolFor||poolFor;
  const clock=io.now||(()=>Date.now());
  const problems=[];
  for(const p of account.positions) {
    try {
      const pool=await getPool(p.token,block.number);
      const marked=await quoteNet(pool,p.qty,block,rates,gasPrice,HAIRCUT_BPS,p.exit_candidates||[]);
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
          const q=await quoteNet(pool,mid,block,rates,gasPrice,HAIRCUT_BPS,p.exit_candidates||[]);
          if(q.net>=target) hi=mid;else lo=mid+1n;
        }
        qty=hi;
      }
      if(qty===0n) continue;
      const commitAt=clock();
      const stale=assertTradeFresh(block,rates,commitAt);
      if(stale) {p.exit_incomplete=true;count(account,stale);writeAccount(store,account);continue;}
      const fill=await quoteNet(pool,qty,block,rates,gasPrice,HAIRCUT_BPS,p.exit_candidates||[]);
      if(fill.uneconomic||fill.net<0) {
        p.exit_incomplete=true;count(account,'UNECONOMIC_EXIT');writeAccount(store,account);continue;
      }
      if(dec.reason==='recover'&&fill.net<p.cost-p.proceeds) throw new Error('RECOVERY_QUOTE_BELOW_TARGET');
      applySell(account,p,qty,fill.net,dec.reason,block.number,{quote_block:block.number,decision_ts:now,fill_ts:commitAt});
      if(account.positions.includes(p)&&BigInt(p.qty)>0n) {
        const rem=await quoteNet(pool,p.qty,block,rates,gasPrice,HAIRCUT_BPS,p.exit_candidates||[]);
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
  // Collection can use a lightweight row-shaped pool. Entry checks and quotes
  // require the live liquidity, sqrt price, full PoolKey, and launch metadata.
  // Hydrate only incomplete cached objects so test/injected full pools remain
  // deterministic and the live path never treats missing fields as zero.
  let entryPool=pool;
  if(!entryPool||entryPool.liquidity==null||entryPool.sqrtPriceX96==null) {
    try {
      entryPool=await (io.poolFor||poolFor)(token,block.number);
    } catch(error) {
      const kind=classifyError(error);
      count(account,kind);writeAccount(store,account);
      return {skipped:kind,safety:{ok:false,reasons:[kind],error:failure(error)}};
    }
  }
  const screen=await (io.safetyScreen||safetyScreen)(store,entryPool,block,rates);
  if(!screen.ok) {for(const r of screen.reasons) count(account,r);writeAccount(store,account);return {skipped:screen.reasons.join(','),safety:screen};}
  const principal=account.principal_limit;
  let plan;
  try {plan=await (io.plannedRoundTrip||plannedRoundTrip)(entryPool,principal,block,rates,gasPrice,HAIRCUT_BPS);}
  catch(error) {count(account,classifyError(error));writeAccount(store,account);return {skipped:failure(error),safety:{...screen,plan:null,checks:screen.checks||null}};}
  if(plan.cash_out>account.spend_limit) {count(account,'CASH_OUT_OVER_CAP');writeAccount(store,account);return {skipped:'CASH_OUT_OVER_CAP',safety:screen,plan};}
  if(account.cash-plan.cash_out<account.reserve) {count(account,'RESERVE_FLOOR');writeAccount(store,account);return {skipped:'RESERVE_FLOOR',safety:screen,plan};}
  if(!(plan.loss_pct<=ROUND_TRIP_LOSS_MAX)) {count(account,'ROUND_TRIP_COST_OVER_GATE');writeAccount(store,account);return {skipped:'ROUND_TRIP_COST_OVER_GATE',safety:{...screen,ok:false,checks:(screen.checks||[]).concat([{name:'round_trip_loss_pct',value:plan.loss_pct,threshold:ROUND_TRIP_LOSS_MAX,status:'FAIL',reason:'ROUND_TRIP_COST_OVER_GATE',source:'plannedRoundTrip.loss_pct'}])},plan};}
  const sim=plan.simulation?{ok:true,sim:plan.simulation}:await (io.requireRoundTrip||requireRoundTrip)(entryPool,plan.amountIn,block);
  if(!sim.ok) {count(account,sim.reason==='USDG_SIMULATION_REQUIRES_FUNDED_ACCOUNT'?sim.reason:'ROUND_TRIP_SIM_FAILED');writeAccount(store,account);return {skipped:sim.reason,safety:screen,plan};}
  let stress={};
  try {
    if(io.stress) stress=io.stress;
    else for(const bps of [50n,150n,300n]) {
      const qty=haircutQty(plan.buy.amountOut,bps);
      const sell=await quoteExact(entryPool,entryPool.token,qty,block.number);
      stress['bps_'+String(bps)]=plannedRoundTripFromQuotes(plan.buy,{...sell,executionFeeWei:plan.sell.executionFeeWei},entryPool,principal,qty,rates,gasPrice,bps);
    }
  } catch {stress.incomplete=true;}
  const commitAt=clock();
  const stale=assertTradeFresh(block,rates,commitAt);
  if(stale) {count(account,stale);writeAccount(store,account);return {skipped:stale,safety:screen,plan};}
  const ok=applyBuy(account,{token,qty:plan.qty,cost:plan.cash_out,block:block.number,signal_ts:signal.minute,
    signal_block:signal.block,decision_ts:now,quote_block:block.number,fill_ts:commitAt,reason:'entry',
    plan:{loss_pct:plan.loss_pct,buy_gas:plan.buyGas,sell_gas:plan.sellGas,haircut_bps:Number(HAIRCUT_BPS),fee_evidence:plan.fee_evidence,exit_candidates:screen.holders?.top10?.map(h=>h.address)||[],stress,simulation:sim.sim?.status},
    version:STRATEGY_VERSION});
  if(!ok) {count(account,'APPLY_BUY_REJECTED');writeAccount(store,account);return {skipped:'APPLY_BUY_REJECTED',safety:screen,plan};}
  account.used_signals.push(sid);
  try {
    const marked=await quoteNet(entryPool,plan.qty,block,rates,gasPrice,HAIRCUT_BPS,screen.holders?.top10?.map(h=>h.address)||[]);
    const pos=account.positions.find(p=>p.token===token);
    if(pos) {pos.mark=marked.mark;pos.mark_raw=marked.net;}
  } catch {const pos=account.positions.find(p=>p.token===token);if(pos) pos.mark=null;}
  recomputeEquity(account);
  applyDayBaseline(account,commitAt);
  writeAccount(store,account);
  return {filled:true,plan,safety:screen};
}
function count(account,reason) {
  account.reject_counts[reason]=(account.reject_counts[reason]||0)+1;
}
