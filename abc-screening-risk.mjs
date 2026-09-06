/** GROK_SCREENING_V1 observe-only risk metrics (no trade gates). */
import {evidence} from './abc-screening-not.mjs';
export {dualTop10Concentration, quoteLossBreakdown} from './abc-screening-p0-metrics.mjs';

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

/**
 * Creator net-sell / balance. Always UNKNOWN when only creator address is passed
 * (net sell + balance not verifiable) - incomplete placeholder, not a full metric.
 */
export function creatorNetSellRatio({creator=null,netSellUsd=null,balanceUsd=null,balanceRaw=null}={}) {
  if(!creator) return {
    status:'UNKNOWN',value:null,source:evidence('pools/holders'),
    complete:false,note:'Creator unknown - PLACEHOLDER/unavailable; not fabricated',
  };
  if(netSellUsd==null||!Number.isFinite(netSellUsd)) return {
    status:'UNKNOWN',value:null,creator,source:evidence('swap_events'),
    complete:false,
    note:'INCOMPLETE: only creator passed (or sells unverifiable) - always UNKNOWN until deployer+sells+balance plumbed',
  };
  if(balanceRaw===0n||balanceRaw==='0') return {
    status:'OBSERVED',value:null,creator,net_sell_usd:netSellUsd,balance:0,complete:true,
    note:'Balance zero - ratio undefined',source:evidence('holderData'),
  };
  const bal=balanceUsd;
  if(bal==null) return {
    status:'UNKNOWN',value:null,creator,source:evidence('holderData'),complete:false,
    note:'Creator balance unknown - PLACEHOLDER/unavailable',
  };
  if(!(bal>0)) return {
    status:'OBSERVED',value:null,creator,net_sell_usd:netSellUsd,balance:bal,complete:true,
    note:'Non-positive balance - ratio undefined',source:evidence('holderData'),
  };
  return {
    status:'OBSERVED',value:netSellUsd/bal,creator,net_sell_usd:netSellUsd,balance:bal,
    threshold:null,complete:true,source:evidence('swap_events+holderData'),note:'Observe-only',
  };
}
