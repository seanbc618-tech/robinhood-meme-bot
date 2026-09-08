import {STRATEGY_VERSION} from './abc-collect.mjs';

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
    mark:null,exit_incomplete:false,exit_candidates:plan?.exit_candidates||[],strategy_version:version||STRATEGY_VERSION});
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

export function recomputeEquity(account) {
  if(account.positions.some(p=>p.mark==null&&BigInt(p.qty)>0n)) {
    account.equity=null;account.unrealized=null;return account;
  }
  let total=account.cash,unreal=0;
  for(const p of account.positions) {total+=p.mark;unreal+=p.mark-p.remainingCost;}
  account.equity=total;account.unrealized=unreal;return account;
}
