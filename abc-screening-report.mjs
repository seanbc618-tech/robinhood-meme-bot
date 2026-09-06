/** GROK_SCREENING_V1 — read-only screening report. */
import {CODE_VERSION} from './abc-collect.mjs';
import {NO_T_DETAIL} from './abc-screening-not.mjs';
import {SCREENING_VERSION} from './abc-screening-core.mjs';

function emptyFunnel() {
  return {unique_evals:0,observed:0,data_complete:0,age_ok:0,age_incomplete:0,strategy_signal:0,safety_pass:0,safety_fail:0,paper_fill:0,no_t_aggregate:0,data_or_age_block:0,
    stages:{NOT_OBSERVED:0,OBSERVED:0,DATA_INCOMPLETE:0,AGE_INCOMPLETE:0,NO_STRATEGY_SIGNAL:0,STRATEGY_SIGNAL:0,SAFETY_PASS:0,SAFETY_FAIL:0,PAPER_FILL:0},funnel:null};
}
function bump(s,stage){ if(stage&&s.stages[stage]!=null) s.stages[stage]++; else if(stage) s.stages[stage]=1; }

function emptyNotStartedReport({now,hours,since,reason}) {
  return {
    mode:'ABC_SCREENING_REPORT_READONLY',screening_version:SCREENING_VERSION,code_version:CODE_VERSION,
    window_hours:hours,since,diagnostics_start_at:null,
    note:reason||'screening_evals absent — not started (no schema ensure / no migration from report)',
    units:{unique_evals:'(strategy,token,minute,code_version)',unique_tokens:0,unique_strategy_token_minutes:0},
    strategies:{A:emptyFunnel(),B:emptyFunnel(),C:emptyFunnel()},no_t_detail:{A:{},B:{},C:{}},
    constraints_honored:['paper_only','no_strategy_trigger_change','unknown_neq_0_neq_PASS','observe_only_risk_metrics','no_profitability_claim','report_readonly'],
    status:'NOT_STARTED',
  };
}

function readQueryOnly(db) {
  try {
    const row=db.prepare('PRAGMA query_only').get();
    if(!row) return false;
    const v=row.query_only??row['query_only'];
    return v===1||v===true||v==='1'||v==='on';
  } catch { return false; }
}

/** Read-only report: no ensure schema / migrations / init. Preserves caller query_only. */
export function screeningReport(store,{now=Date.now(),hours=24,readOnly=true}={}) {
  const since=now-hours*3600*1000;
  if(!store?.db) return emptyNotStartedReport({now,hours,since,reason:'No DB handle — empty/not-started report'});
  const callerQueryOnly=readQueryOnly(store.db);
  let weSetQueryOnly=false;
  if(readOnly!==false&&!callerQueryOnly) {
    try { store.db.exec('PRAGMA query_only=ON'); weSetQueryOnly=true; } catch {}
  }
  try {
    let hasTable=false;
    try {
      hasTable=!!store.db.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='screening_evals'`).get();
    } catch {
      return emptyNotStartedReport({now,hours,since,reason:'Cannot read sqlite_master — empty/not-started report'});
    }
    if(!hasTable) return emptyNotStartedReport({now,hours,since});
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
      if(r.funnel_stage==='AGE_INCOMPLETE') s.age_incomplete++;
      if(r.funnel_stage==='DATA_INCOMPLETE') s.data_or_age_block++;
    }
    for(const strat of ['A','B','C']) {
      const s=byStrat[strat];
      s.data_complete=s.observed-s.stages.DATA_INCOMPLETE;
      s.age_ok=(s.observed-s.stages.DATA_INCOMPLETE)-s.stages.AGE_INCOMPLETE;
      s.funnel={
        observed:s.observed,
        data_complete:s.data_complete,
        age_satisfied:s.age_ok,
        strategy_signal:s.strategy_signal,safety_pass:s.safety_pass,paper_fill:s.paper_fill,
        denominators:{
          observed:'unique evals with funnel_stage != NOT_OBSERVED',
          data_complete:'observed minus DATA_INCOMPLETE (window/warmup data — not graduation age)',
          age_satisfied:'data_complete minus AGE_INCOMPLETE (graduation-age gates only)',
          strategy_signal:'has_signal=1 (monotonic across re-evals)',
          safety_pass:'safety_ok=1',
          paper_fill:'paper_filled=1 (monotonic)',
        },
      };
    }
    return {
      mode:'ABC_SCREENING_REPORT_READONLY',screening_version:SCREENING_VERSION,code_version:CODE_VERSION,
      window_hours:hours,since,diagnostics_start_at:earliest,
      note:earliest==null?'No screening_evals in window — not backfilled':`Diagnostics from ${new Date(earliest).toISOString()}; older unknown`,
      units:{unique_evals:'(strategy,token,minute,code_version)',unique_tokens:tokens.size,unique_strategy_token_minutes:minutes.size},
      strategies:byStrat,no_t_detail:detailCounts,
      constraints_honored:['paper_only','no_strategy_trigger_change','unknown_neq_0_neq_PASS','observe_only_risk_metrics','no_profitability_claim','report_readonly'],
      status:'OK',
    };
  } finally {
    if(weSetQueryOnly&&!callerQueryOnly) {
      try { store.db.exec('PRAGMA query_only=OFF'); } catch {}
    }
  }
}
