import {zeroAddress} from 'viem';
import {A,failure,holderData} from './chain.mjs';
import {classifyError} from './abc-collect.mjs';
import {dualTop10Concentration} from './abc-screening-risk.mjs';

export async function safetyScreen(store,pool,block,rates) {
  const reasons=[];
  // Cheap checks first (phase / liquidity / quote). Heavy holderData only after those pass
  // when a real entry path invokes this - same order as before for buy gating.
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
  // Diagnose-only: attach lp_exclusion + dual aliases when infrastructure set is present.
  let summary=holders?{...holders.summary}:null;
  if(summary&&holders.infrastructure instanceof Set&&!summary.lp_exclusion) {
    summary.lp_exclusion={status:'OBSERVED',excluded_count:holders.infrastructure.size,
      addresses:[...holders.infrastructure],
      note:'LP/infra from holderData.infrastructure (zeroAddress+manager+router+hook+locker+curve+factory+permit2)'};
    if(summary.top10_ex_lp_circulating_bps==null) summary.top10_ex_lp_circulating_bps=summary.top10_circulating_bps??null;
    if(summary.top10_ex_lp_total_supply_bps==null) summary.top10_ex_lp_total_supply_bps=summary.top10_total_supply_bps??null;
    // Legacy top10_total_supply_bps is ex-infra (chain removes infra before numerator).
    // Do NOT copy it into top10_raw_* — that field means raw-including-LP only when includes_lp=true.
    // Expose clearly named legacy diagnostic; leave true raw UNKNOWN until chain emits it.
    if(summary.top10_ex_infra_total_supply_bps==null&&summary.top10_total_supply_bps!=null) {
      summary.top10_ex_infra_total_supply_bps=summary.top10_total_supply_bps;
    }
    // If a prior path already copied legacy into top10_raw_* without includes_lp=true, force honest flag.
    if(summary.top10_raw_total_supply_bps!=null&&summary.top10_raw_includes_lp!==true) {
      summary.top10_raw_includes_lp=false;
      if(!summary.top10_raw_note) {
        summary.top10_raw_note='top10_raw_total_supply_bps without includes_lp=true — treat as ex-infra-style, NOT raw-including-LP';
      }
    }
  }
  const checks=buildSafetyEvidence(pool,summary,holdersError);
  return {ok:!reasons.length,reasons,holders:summary,checks};
}

/** Diagnose-only numeric evidence for safety gates. unknown!=0!=PASS. */
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
    push('top10_raw',null,null,'UNKNOWN',String(holdersError),'holderData',{diagnose_only:true,missing:true,gate_unchanged:true});
    push('top10_ex_lp',null,null,'UNKNOWN',String(holdersError),'holderData',{diagnose_only:true,missing:true,gate_unchanged:true});
  } else if(!holdersSummary) {
    push('holder_count',null,15,'UNKNOWN','HOLDERS_NOT_FETCHED','holderData',{missing:true});
    push('top10_circulating_bps',null,6000,'UNKNOWN','HOLDERS_NOT_FETCHED','holderData',{missing:true});
    push('top10_raw',null,null,'UNKNOWN','HOLDERS_NOT_FETCHED','holderData',{diagnose_only:true,missing:true,gate_unchanged:true});
    push('top10_ex_lp',null,null,'UNKNOWN','HOLDERS_NOT_FETCHED','holderData',{diagnose_only:true,missing:true,gate_unchanged:true});
  } else {
    const hc=holdersSummary.holder_count;
    if(hc==null) push('holder_count',null,15,'UNKNOWN','HOLDER_COUNT_MISSING','holders.summary');
    else push('holder_count',hc,15,hc>=15?'PASS':'FAIL',hc>=15?'ok':'FEWER_THAN_15_HOLDERS','holders.summary.holder_count');
    const t10=holdersSummary.top10_circulating_bps;
    if(t10==null) push('top10_circulating_bps',null,6000,'UNKNOWN','TOP10_MISSING','holders.summary');
    else push('top10_circulating_bps',t10,6000,t10<=6000?'PASS':'FAIL',
      t10<=6000?'ok':'TOP10_OVER_60_PERCENT_CIRCULATING','holders.summary.top10_circulating_bps',
      {denominator:'circulating_ex_infra',total_supply_bps:holdersSummary.top10_total_supply_bps??null});
    const dual=dualTop10Concentration(holdersSummary);
    push('top10_raw',dual.top10_raw.value_bps,null,dual.top10_raw.status,
      dual.top10_raw.reason||'ok','holders.summary.top10_raw',
      {diagnose_only:true,denominator:dual.top10_raw.denominator,note:dual.top10_raw.note,
        includes_lp:dual.top10_raw.includes_lp===true,gate_unchanged:true});
    push('top10_ex_lp',dual.top10_ex_lp.value_bps,null,dual.top10_ex_lp.status,
      dual.top10_ex_lp.reason||'ok','holders.summary.top10_ex_lp',
      {diagnose_only:true,denominator:dual.top10_ex_lp.denominator,note:dual.top10_ex_lp.note,gate_unchanged:true});
    if(dual.top10_ex_infra_total_supply_bps) {
      push('top10_ex_infra_total_supply_bps',dual.top10_ex_infra_total_supply_bps.value_bps,null,
        dual.top10_ex_infra_total_supply_bps.status,
        dual.top10_ex_infra_total_supply_bps.reason||'ok','holders.summary.top10_ex_infra_total_supply_bps',
        {diagnose_only:true,denominator:'total_supply',includes_lp:false,
          note:dual.top10_ex_infra_total_supply_bps.note,gate_unchanged:true});
    }
  }
  push('round_trip_loss_pct',null,0.05,'UNKNOWN','ROUND_TRIP_DEFERRED_UNTIL_ENTRY','tryEnter.plannedRoundTrip',
    {note:'Heavy holderData/sim only on real entry signal path; not run during collect'});
  return checks;
}
