/** GROK_SCREENING_V1 — screening upsert / recordEval. */
import {CODE_VERSION} from './abc-collect.mjs';
import {diagnoseTargetMinute,evidence} from './abc-screening-not.mjs';
import {maxBuyShare5m,creatorNetSellRatio,quoteLossBreakdown} from './abc-screening-risk.mjs';
import {
  SCREENING_VERSION,ensureScreeningSchema,jsonSafe,buildSafetyChecks,classifyFunnelStage,mergeScreeningEvalRow,
} from './abc-screening-funnel.mjs';

export function upsertScreeningEval(store,row) {
  ensureScreeningSchema(store);
  const codeVersion=row.code_version||CODE_VERSION;
  const prev=store.db.prepare(
    'SELECT * FROM screening_evals WHERE strategy=? AND token=? AND minute=? AND code_version=?'
  ).get(row.strategy,row.token,row.minute,codeVersion);
  let prevNorm=null;
  if(prev) {
    prevNorm={
      strategy:prev.strategy,token:prev.token,minute:prev.minute,code_version:prev.code_version,
      observed_at:prev.observed_at,aggregate_reason:prev.aggregate_reason,detail_code:prev.detail_code,
      funnel_stage:prev.funnel_stage,has_signal:!!prev.has_signal,
      safety_ok:prev.safety_ok==null?null:!!prev.safety_ok,paper_filled:!!prev.paper_filled,
      grad_ts:prev.grad_ts,
      source:prev.source_json?JSON.parse(prev.source_json):null,
      metrics:prev.metrics_json?JSON.parse(prev.metrics_json):null,
      checks:prev.checks_json?JSON.parse(prev.checks_json):null,
      risk:prev.risk_json?JSON.parse(prev.risk_json):null,
    };
  }
  const merged=mergeScreeningEvalRow(prevNorm,row);
  store.db.prepare(`INSERT INTO screening_evals(
      strategy,token,minute,code_version,screening_version,observed_at,
      aggregate_reason,detail_code,funnel_stage,has_signal,safety_ok,paper_filled,
      grad_ts,source_json,metrics_json,checks_json,risk_json
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(strategy,token,minute,code_version) DO UPDATE SET
      screening_version=excluded.screening_version, observed_at=excluded.observed_at,
      aggregate_reason=excluded.aggregate_reason, detail_code=excluded.detail_code,
      funnel_stage=excluded.funnel_stage, has_signal=excluded.has_signal,
      safety_ok=excluded.safety_ok,
      paper_filled=excluded.paper_filled,
      grad_ts=excluded.grad_ts, source_json=excluded.source_json, metrics_json=excluded.metrics_json,
      checks_json=excluded.checks_json, risk_json=excluded.risk_json`).run(
    merged.strategy,merged.token,merged.minute,codeVersion,SCREENING_VERSION,merged.observed_at||Date.now(),
    merged.aggregate_reason??null,merged.detail_code??null,merged.funnel_stage,
    merged.has_signal?1:0,merged.safety_ok==null?null:(merged.safety_ok?1:0),merged.paper_filled?1:0,
    merged.grad_ts??null,
    merged.source?jsonSafe(merged.source):null, merged.metrics?jsonSafe(merged.metrics):null,
    merged.checks?jsonSafe(merged.checks):null, merged.risk?jsonSafe(merged.risk):null);
  return merged;
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
    metrics_scope:{
      creator_net_sell:'PLACEHOLDER_UNTIL_DEPLOYER_AND_SELLS — UNKNOWN if only creator address passed',
      quote_loss_fee_impact:'MERGED_LABEL — quoter fee+impact inseparable; haircut listed separately',
      rejection_path_evidence:safety?.plan||safety?.checks?'present_when_tryEnter_returns_safety_or_plan':'unavailable_on_paths_without_plan',
    },
  };
  const planRt=safety?.plan?{loss_pct:safety.plan.loss_pct}:null;
  const checks=safety?.checks||buildSafetyChecks({
    pool,holders:safety?.holders||null,holdersError:safety?.error||null,roundTrip:planRt,
  });
  const funnel=classifyFunnelStage({watched,diag,ev,gradTs,minute,safetyOk:safety?.ok,paperFilled});
  const row={
    strategy,token,minute,code_version:codeVersion,observed_at:Date.now(),aggregate_reason:aggregate,detail_code,
    funnel_stage:funnel,has_signal:!!ev?.signal,safety_ok:safety?.ok,paper_filled:paperFilled,grad_ts:gradTs??null,
    source:diag?.source||evidence('evaluate+store'),metrics:diag?.metrics||null,checks,risk,
  };
  return upsertScreeningEval(store,row);
}
