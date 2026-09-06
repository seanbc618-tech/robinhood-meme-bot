import {bucketMap,takeWindow,uniqueRecipients,recipientShare} from './abc-collect.mjs';


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

export const evaluators={A:evaluateA,B:evaluateB,C:evaluateC};
