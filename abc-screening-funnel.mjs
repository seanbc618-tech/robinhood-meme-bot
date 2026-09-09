/** GROK_SCREENING_V1 - screening schema, checks, funnel, merge. */
import {CODE_VERSION,ROUND_TRIP_LOSS_MAX} from './abc-collect.mjs';
import {zeroAddress} from 'viem';
import {
  NO_T_DETAIL,diagnoseTargetMinute,mapFxReason,fxStatusFromDiag,evidence,
} from './abc-screening-not.mjs';
import {
  attributedBuyRecipients,maxBuyShare5m,creatorNetSellRatio,quoteLossBreakdown,dualTop10Concentration,
} from './abc-screening-risk.mjs';

export const SCREENING_VERSION='screening-v1-p0';
export {
  NO_T_DETAIL,diagnoseTargetMinute,mapFxReason,fxStatusFromDiag,
  attributedBuyRecipients,maxBuyShare5m,creatorNetSellRatio,quoteLossBreakdown,dualTop10Concentration,
};

/** BigInt-safe JSON - plain JSON.stringify throws on haircut_bps / liquidity BigInts. */
export function jsonSafe(value) {
  return JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v);
}

export function ensureScreeningSchema(store) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS screening_evals (
      strategy TEXT NOT NULL, token TEXT NOT NULL, minute INTEGER NOT NULL, code_version TEXT NOT NULL,
      screening_version TEXT NOT NULL, observed_at INTEGER NOT NULL, aggregate_reason TEXT, detail_code TEXT,
      funnel_stage TEXT NOT NULL, has_signal INTEGER NOT NULL DEFAULT 0, safety_ok INTEGER,
      paper_filled INTEGER NOT NULL DEFAULT 0, grad_ts INTEGER,
      source_json TEXT, metrics_json TEXT, checks_json TEXT, risk_json TEXT,
      PRIMARY KEY(strategy, token, minute, code_version));
    CREATE INDEX IF NOT EXISTS screening_evals_obs ON screening_evals(observed_at);`);
}

export function buildSafetyChecks({pool,holders=null,holdersError=null,roundTrip=null}={}) {
  const checks=[];
  const push=(name,value,threshold,status,reason,source,extra={})=>
    checks.push({name,value:value??null,threshold:threshold??null,status,reason,source,...extra});
  if(!pool||pool.launch==null||pool.launch.phase==null) push('phase2',null,2,'UNKNOWN','LAUNCH_PHASE_UNKNOWN','pool.launch.phase');
  else push('phase2',pool.launch.phase,2,pool.launch.phase===2?'PASS':'FAIL',pool.launch.phase===2?'ok':'NOT_PHASE2','pool.launch.phase');
  if(pool?.liquidity==null) push('liquidity',null,'>0','UNKNOWN','LIQUIDITY_UNKNOWN','pool.liquidity');
  else {
    const ok=pool.liquidity>0n&&pool.sqrtPriceX96>0n;
    push('liquidity',String(pool.liquidity),'>0',ok?'PASS':'FAIL',ok?'ok':'NO_LIQUIDITY','pool.liquidity+sqrtPriceX96');
  }
  if(pool?.quote==null) push('supported_quote',null,'WETH|USDG','UNKNOWN','QUOTE_UNKNOWN','pool.quote');
  else push('supported_quote',String(pool.quote).toLowerCase(),'WETH(zero)|USDG','UNKNOWN','QUOTE_PENDING_ALLOWLIST','pool.quote',
    {note:'Final PASS/FAIL via safetyScreen allowlist; never coerce unknown to 0/PASS'});
  if(holdersError) {
    push('holder_count',null,15,'UNKNOWN',String(holdersError),'holderData',{missing:true});
    push('top10_circulating_bps',null,6000,'UNKNOWN',String(holdersError),'holderData',{missing:true});
    const dual=dualTop10Concentration(null,{holdersError});
    push('top10_raw',null,null,'UNKNOWN',String(holdersError),'holderData',{diagnose_only:true,missing:true,gate_unchanged:true});
    push('top10_ex_lp',null,null,'UNKNOWN',String(holdersError),'holderData',{diagnose_only:true,missing:true,gate_unchanged:true,lp_exclusion:dual.lp_exclusion});
  } else if(!holders) {
    push('holder_count',null,15,'UNKNOWN','HOLDERS_NOT_FETCHED','holderData',{missing:true});
    push('top10_circulating_bps',null,6000,'UNKNOWN','HOLDERS_NOT_FETCHED','holderData',{missing:true});
    push('top10_raw',null,null,'UNKNOWN','HOLDERS_NOT_FETCHED','holderData',{diagnose_only:true,missing:true,gate_unchanged:true});
    push('top10_ex_lp',null,null,'UNKNOWN','HOLDERS_NOT_FETCHED','holderData',{diagnose_only:true,missing:true,gate_unchanged:true});
  } else {
    const hc=holders.holder_count;
    if(hc==null) push('holder_count',null,15,'UNKNOWN','HOLDER_COUNT_MISSING','holders.summary');
    else push('holder_count',hc,15,hc>=15?'PASS':'FAIL',hc>=15?'ok':'FEWER_THAN_15_HOLDERS','holders.summary.holder_count');
    const t10=holders.top10_circulating_bps;
    if(t10==null) push('top10_circulating_bps',null,6000,'UNKNOWN','TOP10_MISSING','holders.summary');
    else push('top10_circulating_bps',t10,6000,t10<=6000?'PASS':'FAIL',
      t10<=6000?'ok':'TOP10_OVER_60_PERCENT_CIRCULATING','holders.summary.top10_circulating_bps',
      {denominator:'circulating_ex_infra',total_supply_bps:holders.top10_total_supply_bps??null});
    // Additive diagnose-only dual top10 (gate above unchanged)
    const dual=dualTop10Concentration(holders);
    push('top10_raw',dual.top10_raw.value_bps,null,dual.top10_raw.status,
      dual.top10_raw.reason||'ok','holders.summary.top10_raw',
      {diagnose_only:true,denominator:dual.top10_raw.denominator,note:dual.top10_raw.note,
        includes_lp:dual.top10_raw.includes_lp===true,gate_unchanged:true});
    push('top10_ex_lp',dual.top10_ex_lp.value_bps,null,dual.top10_ex_lp.status,
      dual.top10_ex_lp.reason||'ok','holders.summary.top10_ex_lp',
      {diagnose_only:true,denominator:dual.top10_ex_lp.denominator,note:dual.top10_ex_lp.note,gate_unchanged:true});
  }
  if(roundTrip==null) push('round_trip_loss_pct',null,ROUND_TRIP_LOSS_MAX,'UNKNOWN','ROUND_TRIP_NOT_RUN','plannedRoundTrip');
  else if(roundTrip.loss_pct==null||!Number.isFinite(roundTrip.loss_pct)) push('round_trip_loss_pct',null,ROUND_TRIP_LOSS_MAX,'UNKNOWN','LOSS_PCT_UNKNOWN','plannedRoundTrip');
  else push('round_trip_loss_pct',roundTrip.loss_pct,ROUND_TRIP_LOSS_MAX,roundTrip.loss_pct<=ROUND_TRIP_LOSS_MAX?'PASS':'FAIL',
    roundTrip.loss_pct<=ROUND_TRIP_LOSS_MAX?'ok':'ROUND_TRIP_COST_OVER_GATE','plannedRoundTrip.loss_pct');
  return checks;
}

export function finalizeQuoteCheck(checks,pool,usdg) {
  const c=checks.find(x=>x.name==='supported_quote');
  if(!c||!pool?.quote) return checks;
  const q=String(pool.quote).toLowerCase();
  const ok=q===zeroAddress.toLowerCase()||(usdg&&q===String(usdg).toLowerCase());
  c.status=ok?'PASS':'FAIL'; c.reason=ok?'ok':'UNSUPPORTED_QUOTE'; c.threshold='WETH(zero)|USDG';
  return checks;
}

/**
 * Funnel stage: graduation-age != data warmups != consecutive-minute OBSERVING.
 * P0: OBSERVING = consecutive-minute / post-graduation observation window incomplete
 *     (WARMUP_LT_30_CONSECUTIVE, WINDOW_INCOMPLETE) - distinct from AGE and DATA_INCOMPLETE.
 * WARMUP != AGE (PR1); OBSERVING != AGE (P0).
 */
export function classifyFunnelStage({watched,diag,ev,gradTs,minute,safetyOk,paperFilled}) {
  if(!watched) return 'NOT_OBSERVED';
  if(paperFilled) return 'PAPER_FILL';
  if(ev?.signal&&safetyOk===true) return 'SAFETY_PASS';
  if(ev?.signal&&safetyOk===false) return 'SAFETY_FAIL';
  if(ev?.signal) return 'STRATEGY_SIGNAL';
  const reason=ev?.reason!=null?String(ev.reason):'';
  if(reason==='GRADUATION_TIME_UNKNOWN'||reason==='GRADUATION_OVER_6H'||reason.startsWith('WARMUP_GRADUATION')) return 'AGE_INCOMPLETE';
  // Consecutive-minute / observation-window incomplete -> explicit OBSERVING stage
  if(reason==='WARMUP_LT_30_CONSECUTIVE'||reason==='WINDOW_INCOMPLETE'||reason==='OBSERVING')
    return 'OBSERVING';
  // Generic history/data warmups (not graduation age, not observation window)
  if(reason==='WARMUP'||reason==='WARMUP_LT_120M')
    return 'DATA_INCOMPLETE';
  if(reason==='NO_T'||(diag&&diag.detail_code&&diag.filter_reject)) return 'DATA_INCOMPLETE';
  if(gradTs==null) return 'AGE_INCOMPLETE';
  if(ev&&!ev.signal) return 'NO_STRATEGY_SIGNAL';
  return 'OBSERVED';
}

const FUNNEL_RANK=Object.freeze({
  NOT_OBSERVED:0,OBSERVED:1,DATA_INCOMPLETE:2,AGE_INCOMPLETE:2,OBSERVING:2,
  NO_STRATEGY_SIGNAL:3,STRATEGY_SIGNAL:4,SAFETY_FAIL:5,SAFETY_PASS:6,PAPER_FILL:7,
});

/** Merge repeat evals: never lose signal/fill evidence while retaining paper_filled. */
export function mergeScreeningEvalRow(prev,next) {
  if(!prev) return next;
  const paper_filled=!!(prev.paper_filled||next.paper_filled);
  const has_signal=!!(prev.has_signal||next.has_signal);
  let funnel_stage=next.funnel_stage;
  if(paper_filled) funnel_stage='PAPER_FILL';
  else if((FUNNEL_RANK[prev.funnel_stage]||0)>(FUNNEL_RANK[next.funnel_stage]||0)) funnel_stage=prev.funnel_stage;
  let safety_ok=next.safety_ok;
  if(safety_ok==null) safety_ok=prev.safety_ok;
  const keepEntry=!!prev.has_signal&&!next.has_signal;
  return {
    ...next,
    has_signal,paper_filled,funnel_stage,safety_ok,
    aggregate_reason:keepEntry?prev.aggregate_reason:next.aggregate_reason,
    detail_code:keepEntry?prev.detail_code:next.detail_code,
    checks:keepEntry&&prev.checks?prev.checks:(next.checks??prev.checks),
    risk:keepEntry&&prev.risk?prev.risk:(next.risk??prev.risk),
    source:keepEntry&&prev.source?prev.source:(next.source??prev.source),
    metrics:keepEntry&&prev.metrics?prev.metrics:(next.metrics??prev.metrics),
    grad_ts:next.grad_ts??prev.grad_ts,
  };
}
