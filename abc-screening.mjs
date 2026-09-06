/** GROK_SCREENING_V1 — diagnose-only screening evidence barrel. */
import {CODE_VERSION} from './abc-collect.mjs';
import {zeroAddress} from 'viem';
import {
  NO_T_DETAIL,diagnoseTargetMinute,mapFxReason,fxStatusFromDiag,evidence,
} from './abc-screening-not.mjs';
import {
  attributedBuyRecipients,maxBuyShare5m,creatorNetSellRatio,quoteLossBreakdown,
} from './abc-screening-risk.mjs';

export const SCREENING_VERSION='screening-v1';
export {
  NO_T_DETAIL,diagnoseTargetMinute,mapFxReason,fxStatusFromDiag,
  attributedBuyRecipients,maxBuyShare5m,creatorNetSellRatio,quoteLossBreakdown,
};

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
  } else if(!holders) {
    push('holder_count',null,15,'UNKNOWN','HOLDERS_NOT_FETCHED','holderData',{missing:true});
    push('top10_circulating_bps',null,6000,'UNKNOWN','HOLDERS_NOT_FETCHED','holderData',{missing:true});
  } else {
    const hc=holders.holder_count;
    if(hc==null) push('holder_count',null,15,'UNKNOWN','HOLDER_COUNT_MISSING','holders.summary');
    else push('holder_count',hc,15,hc>=15?'PASS':'FAIL',hc>=15?'ok':'FEWER_THAN_15_HOLDERS','holders.summary.holder_count');
    const t10=holders.top10_circulating_bps;
    if(t10==null) push('top10_circulating_bps',null,6000,'UNKNOWN','TOP10_MISSING','holders.summary');
    else push('top10_circulating_bps',t10,6000,t10<=6000?'PASS':'FAIL',
      t10<=6000?'ok':'TOP10_OVER_60_PERCENT_CIRCULATING','holders.summary.top10_circulating_bps',
      {denominator:'circulating_ex_infra',total_supply_bps:holders.top10_total_supply_bps??null});
  }
  if(roundTrip==null) push('round_trip_loss_pct',null,0.05,'UNKNOWN','ROUND_TRIP_NOT_RUN','plannedRoundTrip');
  else if(roundTrip.loss_pct==null||!Number.isFinite(roundTrip.loss_pct)) push('round_trip_loss_pct',null,0.05,'UNKNOWN','LOSS_PCT_UNKNOWN','plannedRoundTrip');
  else push('round_trip_loss_pct',roundTrip.loss_pct,0.05,roundTrip.loss_pct<=0.05?'PASS':'FAIL',
    roundTrip.loss_pct<=0.05?'ok':'ROUND_TRIP_COST_OVER_5_PERCENT','plannedRoundTrip.loss_pct');
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

export function classifyFunnelStage({watched,diag,ev,gradTs,minute,safetyOk,paperFilled}) {
  if(!watched) return 'NOT_OBSERVED';
  if(paperFilled) return 'PAPER_FILL';
  if(ev?.signal&&safetyOk===true) return 'SAFETY_PASS';
  if(ev?.signal&&safetyOk===false) return 'SAFETY_FAIL';
  if(ev?.signal) return 'STRATEGY_SIGNAL';
  if(ev?.reason&&String(ev.reason).startsWith('WARMUP')) return 'AGE_INCOMPLETE';
  if(ev?.reason==='GRADUATION_TIME_UNKNOWN'||gradTs==null) return 'AGE_INCOMPLETE';
  if(ev?.reason==='NO_T'||(diag&&diag.detail_code&&diag.filter_reject)) return 'DATA_INCOMPLETE';
  if(ev?.reason==='WINDOW_INCOMPLETE'||ev?.reason==='WARMUP') return 'DATA_INCOMPLETE';
  if(ev&&!ev.signal) return 'NO_STRATEGY_SIGNAL';
  return 'OBSERVED';
}

export function upsertScreeningEval(store,row) {
  ensureScreeningSchema(store);
  store.db.prepare(`INSERT INTO screening_evals(
      strategy,token,minute,code_version,screening_version,observed_at,
      aggregate_reason,detail_code,funnel_stage,has_signal,safety_ok,paper_filled,
      grad_ts,source_json,metrics_json,checks_json,risk_json
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(strategy,token,minute,code_version) DO UPDATE SET
      screening_version=excluded.screening_version, observed_at=excluded.observed_at,
      aggregate_reason=excluded.aggregate_reason, detail_code=excluded.detail_code,
      funnel_stage=excluded.funnel_stage, has_signal=excluded.has_signal,
      safety_ok=COALESCE(excluded.safety_ok,screening_evals.safety_ok),
      paper_filled=CASE WHEN excluded.paper_filled>screening_evals.paper_filled THEN excluded.paper_filled ELSE screening_evals.paper_filled END,
      grad_ts=excluded.grad_ts, source_json=excluded.source_json, metrics_json=excluded.metrics_json,
      checks_json=excluded.checks_json, risk_json=excluded.risk_json`).run(
    row.strategy,row.token,row.minute,row.code_version||CODE_VERSION,SCREENING_VERSION,row.observed_at||Date.now(),
    row.aggregate_reason??null,row.detail_code??null,row.funnel_stage,
    row.has_signal?1:0,row.safety_ok==null?null:(row.safety_ok?1:0),row.paper_filled?1:0,
    row.grad_ts??null,
    row.source?JSON.stringify(row.source):null, row.metrics?JSON.stringify(row.metrics):null,
    row.checks?JSON.stringify(row.checks):null, row.risk?JSON.stringify(row.risk):null);
}

export function recordEvalFromCycle(store,{strategy,token,minute,ev,gradTs,watched=true,buckets=[],pool=null,safety=null,paperFilled=false,codeVersion=CODE_VERSION}) {
  ensureScreeningSchema(store);
  let detail_code=null, diag=null, aggregate=ev?.reason||null;
  if(ev?.reason==='NO_T'||(!ev?.signal&&!(buckets||[]).some(b=>b.minute===minute&&b.close_usd>0))) {
    diag=diagnoseTargetMinute(store,token,minute,{quote:pool?.quote,watched});
    detail_code=diag.detail_code;
    if(ev?.reason==='NO_T') aggregate='NO_T';
  } else if(!ev?.signal&&!ev?.reason) { detail_code='STRATEGY_NOT_TRIGGERED'; aggregate=aggregate||'STRATEGY_NOT_TRIGGERED'; }
  else if(ev?.reason==='WINDOW_INCOMPLETE') detail_code='WINDOW_INCOMPLETE';
  else if(ev?.reason&&String(ev.reason).startsWith('WARMUP')) detail_code=ev.reason;
  else if(ev?.reason) detail_code=ev.reason;
  const risk={
    max_buy_share_5m:maxBuyShare5m(buckets,minute),
    creator_net_sell:creatorNetSellRatio({creator:pool?.deployer||null}),
    quote_loss:quoteLossBreakdown(safety?.plan||null),
  };
  const checks=safety?.checks||buildSafetyChecks({pool,holders:safety?.holders||null,holdersError:safety?.error||null});
  const funnel=classifyFunnelStage({watched,diag,ev,gradTs,minute,safetyOk:safety?.ok,paperFilled});
  const row={
    strategy,token,minute,code_version:codeVersion,observed_at:Date.now(),aggregate_reason:aggregate,detail_code,
    funnel_stage:funnel,has_signal:!!ev?.signal,safety_ok:safety?.ok,paper_filled:paperFilled,grad_ts:gradTs??null,
    source:diag?.source||evidence('evaluate+store'),metrics:diag?.metrics||null,checks,risk,
  };
  upsertScreeningEval(store,row);
  return row;
}

function emptyFunnel() {
  return {unique_evals:0,observed:0,data_complete:0,age_ok:0,age_incomplete:0,strategy_signal:0,safety_pass:0,safety_fail:0,paper_fill:0,no_t_aggregate:0,data_or_age_block:0,
    stages:{NOT_OBSERVED:0,OBSERVED:0,DATA_INCOMPLETE:0,AGE_INCOMPLETE:0,NO_STRATEGY_SIGNAL:0,STRATEGY_SIGNAL:0,SAFETY_PASS:0,SAFETY_FAIL:0,PAPER_FILL:0},funnel:null};
}
function bump(s,stage){ if(stage&&s.stages[stage]!=null) s.stages[stage]++; else if(stage) s.stages[stage]=1; }

export function screeningReport(store,{now=Date.now(),hours=24,readOnly=true}={}) {
  ensureScreeningSchema(store);
  if(readOnly) store.db.exec('PRAGMA query_only=ON');
  try {
    const since=now-hours*3600*1000;
    const rows=store.db.prepare(`SELECT * FROM screening_evals WHERE observed_at>=? ORDER BY observed_at DESC`).all(since);
    const earliest=rows.length?Math.min(...rows.map(r=>r.observed_at)):null;
    const byStrat={A:emptyFunnel(),B:emptyFunnel(),C:emptyFunnel()};
    const detailCounts={A:{},B:{},C:{}};
    const tokens=new Set(), minutes=new Set();
    for(const r of rows) {
      const s=byStrat[r.strategy]; if(!s) continue;
      tokens.add(r.token); minutes.add(`${r.strategy}:${r.token}:${r.minute}`);
      s.unique_evals++; bump(s,r.funnel_stage);
      if(r.aggregate_reason==='NO_T'||(r.detail_code&&Object.values(NO_T_DETAIL).includes(r.detail_code))) {
        s.no_t_aggregate++; const d=r.detail_code||'NO_T_UNSPECIFIED';
        detailCounts[r.strategy][d]=(detailCounts[r.strategy][d]||0)+1;
      }
      if(r.has_signal) s.strategy_signal++;
      if(r.safety_ok===1) s.safety_pass++;
      if(r.safety_ok===0) s.safety_fail++;
      if(r.paper_filled) s.paper_fill++;
      if(r.funnel_stage!=='NOT_OBSERVED') s.observed++;
    }
    for(const strat of ['A','B','C']) {
      const s=byStrat[strat];
      s.funnel={
        observed:s.observed,
        data_complete:s.observed-s.stages.DATA_INCOMPLETE,
        age_satisfied:(s.observed-s.stages.DATA_INCOMPLETE)-s.stages.AGE_INCOMPLETE,
        strategy_signal:s.strategy_signal,safety_pass:s.safety_pass,paper_fill:s.paper_fill,
      };
    }
    return {
      mode:'ABC_SCREENING_REPORT_READONLY',screening_version:SCREENING_VERSION,code_version:CODE_VERSION,
      window_hours:hours,since,diagnostics_start_at:earliest,
      note:earliest==null?'No screening_evals in window — not backfilled':`Diagnostics from ${new Date(earliest).toISOString()}; older unknown`,
      units:{unique_evals:'(strategy,token,minute,code_version)',unique_tokens:tokens.size,unique_strategy_token_minutes:minutes.size},
      strategies:byStrat,no_t_detail:detailCounts,
      constraints_honored:['paper_only','no_strategy_trigger_change','unknown_neq_0_neq_PASS','observe_only_risk_metrics','no_profitability_claim'],
    };
  } finally { if(readOnly) try{store.db.exec('PRAGMA query_only=OFF');}catch{} }
}
