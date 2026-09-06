/** GROK_SCREENING_V1 observe-only risk metrics (no trade gates). */
import {HAIRCUT_BPS} from './abc-collect.mjs';
import {evidence} from './abc-screening-not.mjs';

export function attributedBuyRecipients(swaps,transfersByTx,infraSet) {
  const recipients={};
  const infra=infraSet instanceof Set?infraSet:new Set([...(infraSet||[])].map(a=>String(a).toLowerCase()));
  for(const e of swaps||[]) {
    const tokenAmount=BigInt(e.token_amount), quoteAmount=BigInt(e.quote_amount);
    const usdVol=Number(e.quote_vol_usd!=null?e.quote_vol_usd:e.usd_vol||0);
    if(!(tokenAmount>0n&&quoteAmount<0n)||!(usdVol>0)) continue;
    const deltas=new Map();
    for(const tr of transfersByTx.get(e.tx)||[]) {
      const value=BigInt(tr.value);
      deltas.set(String(tr.dest).toLowerCase(),(deltas.get(String(tr.dest).toLowerCase())||0n)+value);
      deltas.set(String(tr.frm).toLowerCase(),(deltas.get(String(tr.frm).toLowerCase())||0n)-value);
    }
    const positive=[...deltas].filter(([a,v])=>v>0n&&!infra.has(a));
    const total=positive.reduce((s,[,v])=>s+v,0n);
    if(total>0n) for(const [a,v] of positive) recipients[a]=(recipients[a]||0)+usdVol*Number(v)/Number(total);
  }
  return recipients;
}

export function maxBuyShare5m(buckets,minute) {
  const window=(buckets||[]).filter(b=>b.minute>minute-5*60&&b.minute<=minute);
  const totals={}; let buy=0;
  for(const b of window) for(const [a,v] of Object.entries(b.buy_recipients||{})) {
    const n=Number(v); if(!(n>0)) continue; totals[a]=(totals[a]||0)+n; buy+=n;
  }
  if(!(buy>0)) return {status:'UNKNOWN',value:null,denominator:0,numerator:null,address:null,
    source:evidence('buckets.buy_recipients',{minutes:window.map(b=>b.minute)}),
    note:'No attributable external buy USD; not 0% concentration'};
  let maxA=null,maxV=0;
  for(const [a,v] of Object.entries(totals)) if(v>maxV){maxV=v;maxA=a;}
  return {status:'OBSERVED',value:maxV/buy,denominator:buy,numerator:maxV,address:maxA,
    source:evidence('buckets.buy_recipients',{minutes:window.map(b=>b.minute)}),
    threshold:null,note:'Observe-only; no trade threshold'};
}

export function creatorNetSellRatio({creator=null,netSellUsd=null,balanceUsd=null,balanceRaw=null}={}) {
  if(!creator) return {status:'UNKNOWN',value:null,source:evidence('pools/holders'),note:'Creator unknown — not fabricated'};
  if(netSellUsd==null||!Number.isFinite(netSellUsd)) return {status:'UNKNOWN',value:null,creator,source:evidence('swap_events'),note:'Creator net sell not verifiable'};
  if(balanceRaw===0n||balanceRaw==='0') return {status:'OBSERVED',value:null,creator,net_sell_usd:netSellUsd,balance:0,note:'Balance zero — ratio undefined',source:evidence('holderData')};
  const bal=balanceUsd;
  if(bal==null) return {status:'UNKNOWN',value:null,creator,source:evidence('holderData'),note:'Creator balance unknown'};
  if(!(bal>0)) return {status:'OBSERVED',value:null,creator,net_sell_usd:netSellUsd,balance:bal,note:'Non-positive balance — ratio undefined',source:evidence('holderData')};
  return {status:'OBSERVED',value:netSellUsd/bal,creator,net_sell_usd:netSellUsd,balance:bal,threshold:null,source:evidence('swap_events+holderData'),note:'Observe-only'};
}

export function quoteLossBreakdown(plan) {
  if(!plan) return {status:'UNKNOWN',parts:null,note:'No plan quotes available'};
  const parts={
    quoter_fee_and_impact_merged:{status:plan.buy&&plan.sell?'OBSERVED':'UNKNOWN',value:null,
      note:'Quoter embeds fee+impact; listed as merged when inseparable'},
    haircut_bps:{status:plan.haircut_bps!=null?'OBSERVED':'UNKNOWN',value:plan.haircut_bps??null},
    buy_gas_usd:{status:Number.isFinite(plan.buyGas)?'OBSERVED':'UNKNOWN',value:plan.buyGas??null},
    sell_gas_usd:{status:Number.isFinite(plan.sellGas)?'OBSERVED':'UNKNOWN',value:plan.sellGas??null},
    l1_allowance:{status:'UNKNOWN',value:null,note:'L1 allowance not isolated in paper plan'},
    total_round_trip_loss_usd:{status:Number.isFinite(plan.loss)?'OBSERVED':'UNKNOWN',value:plan.loss??null},
    total_round_trip_loss_pct:{status:Number.isFinite(plan.loss_pct)?'OBSERVED':'UNKNOWN',value:plan.loss_pct??null},
  };
  if(Number.isFinite(plan.initial)&&Number.isFinite(plan.recovered)&&Number.isFinite(plan.buyGas)&&Number.isFinite(plan.sellGas)) {
    const sellUsd=plan.recovered+plan.sellGas, principal=plan.initial-plan.buyGas;
    parts.quoter_fee_and_impact_merged.value=Number.isFinite(sellUsd)?principal-sellUsd:null;
    parts.quoter_fee_and_impact_merged.status=parts.quoter_fee_and_impact_merged.value==null?'UNKNOWN':'OBSERVED';
  }
  return {status:'OBSERVED',parts,source:evidence('plannedRoundTripFromQuotes',{haircut_bps:HAIRCUT_BPS}),
    note:'Nominal pool.liquidity is not USD depth; observe-only'};
}
