import {zeroAddress} from 'viem';
import {A,failure,holderData} from './chain.mjs';
import {classifyError} from './abc-collect.mjs';

export async function safetyScreen(store,pool,block,rates) {
  const reasons=[];
  // Cheap checks first (phase / liquidity / quote). Heavy holderData only after those pass
  // when a real entry path invokes this — same order as before for buy gating.
  if(pool.launch.phase!==2) reasons.push('NOT_PHASE2');
  if(!(pool.liquidity>0n&&pool.sqrtPriceX96>0n)) reasons.push('NO_LIQUIDITY');
  const quote=pool.quote.toLowerCase();
  if(!(quote===zeroAddress.toLowerCase()||quote===A.usdg.toLowerCase())) reasons.push('UNSUPPORTED_QUOTE');
  const cheapFail=reasons.length>0;
  let holders=null;
  let holdersError=null;
  if(!cheapFail) {
    try {holders=await holderData(pool,block.number);}
    catch(error) {
      store.bump(classifyError(error));
      holdersError=classifyError(error);
      const checks=buildSafetyEvidence(pool,null,holdersError);
      return {ok:false,reasons:[holdersError],error:failure(error),checks,holders:null};
    }
    if(holders.summary.holder_count<15) reasons.push('FEWER_THAN_15_HOLDERS');
    if(holders.summary.top10_circulating_bps>6000) reasons.push('TOP10_OVER_60_PERCENT_CIRCULATING');
  }
  const checks=buildSafetyEvidence(pool,holders&&holders.summary,holdersError);
  return {ok:!reasons.length,reasons,holders:holders?holders.summary:null,checks};
}

/** Diagnose-only numeric evidence for safety gates. unknown≠0≠PASS. */
export function buildSafetyEvidence(pool,holdersSummary,holdersError) {
  const checks=[];
  const push=(name,value,threshold,status,reason,source,extra={})=>
    checks.push({name,value:value??null,threshold:threshold??null,status,reason,source,...extra});
  if(!pool||pool.launch==null||pool.launch.phase==null)
    push('phase2',null,2,'UNKNOWN','LAUNCH_PHASE_UNKNOWN','pool.launch.phase');
  else push('phase2',pool.launch.phase,2,pool.launch.phase===2?'PASS':'FAIL',
    pool.launch.phase===2?'ok':'NOT_PHASE2','pool.launch.phase');
  if(pool?.liquidity==null)
    push('liquidity',null,'>0','UNKNOWN','LIQUIDITY_UNKNOWN','pool.liquidity');
  else {
    const ok=pool.liquidity>0n&&pool.sqrtPriceX96>0n;
    push('liquidity',String(pool.liquidity),'>0',ok?'PASS':'FAIL',ok?'ok':'NO_LIQUIDITY','pool.liquidity+sqrtPriceX96');
  }
  if(pool?.quote==null)
    push('supported_quote',null,'WETH(zero)|USDG','UNKNOWN','QUOTE_UNKNOWN','pool.quote');
  else {
    const q=String(pool.quote).toLowerCase();
    const ok=q===zeroAddress.toLowerCase()||q===A.usdg.toLowerCase();
    push('supported_quote',q,'WETH(zero)|USDG',ok?'PASS':'FAIL',ok?'ok':'UNSUPPORTED_QUOTE','pool.quote');
  }
  if(holdersError) {
    push('holder_count',null,15,'UNKNOWN',String(holdersError),'holderData',{missing:true});
    push('top10_circulating_bps',null,6000,'UNKNOWN',String(holdersError),'holderData',{missing:true});
  } else if(!holdersSummary) {
    push('holder_count',null,15,'UNKNOWN','HOLDERS_NOT_FETCHED','holderData',{missing:true});
    push('top10_circulating_bps',null,6000,'UNKNOWN','HOLDERS_NOT_FETCHED','holderData',{missing:true});
  } else {
    const hc=holdersSummary.holder_count;
    if(hc==null) push('holder_count',null,15,'UNKNOWN','HOLDER_COUNT_MISSING','holders.summary');
    else push('holder_count',hc,15,hc>=15?'PASS':'FAIL',hc>=15?'ok':'FEWER_THAN_15_HOLDERS','holders.summary.holder_count');
    const t10=holdersSummary.top10_circulating_bps;
    if(t10==null) push('top10_circulating_bps',null,6000,'UNKNOWN','TOP10_MISSING','holders.summary');
    else push('top10_circulating_bps',t10,6000,t10<=6000?'PASS':'FAIL',
      t10<=6000?'ok':'TOP10_OVER_60_PERCENT_CIRCULATING','holders.summary.top10_circulating_bps',
      {denominator:'circulating_ex_infra',total_supply_bps:holdersSummary.top10_total_supply_bps??null});
  }
  push('round_trip_loss_pct',null,0.05,'UNKNOWN','ROUND_TRIP_DEFERRED_UNTIL_ENTRY','tryEnter.plannedRoundTrip',
    {note:'Heavy holderData/sim only on real entry signal path; not run during collect'});
  return checks;
}
