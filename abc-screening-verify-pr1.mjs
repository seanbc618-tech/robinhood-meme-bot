/** PR1 review regression suite for GROK_SCREENING_V1. */
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {zeroAddress} from 'viem';
import {openAbc,CODE_VERSION,minuteStart,HAIRCUT_BPS} from './abc-collect.mjs';
import {openAbcReadonly} from './abc-collect-readonly.mjs';
import {
  screeningReport,ensureScreeningSchema,
  recordEvalFromCycle,classifyFunnelStage,quoteLossBreakdown,jsonSafe,
  creatorNetSellRatio,mergeScreeningEvalRow,dualTop10Concentration,buildSafetyChecks,
} from './abc-screening.mjs';

export function runPr1Regressions(assert) {
// --- PR1 review regressions ---
{
  // BigInt JSON: haircut_bps must not throw through quoteLossBreakdown -> jsonSafe / upsert
  const plan={
    buy:{},sell:{},haircut_bps:HAIRCUT_BPS,buyGas:0.1,sellGas:0.1,
    initial:30,recovered:28,loss:2,loss_pct:0.06,
  };
  let threw=false; let breakdown=null; let encoded=null;
  try {
    breakdown=quoteLossBreakdown(plan);
    encoded=jsonSafe(breakdown);
    JSON.parse(encoded);
  } catch(e) { threw=true; console.log('bigint err',e); }
  assert('BigInt haircut_bps quoteLossBreakdown JSON-safe',!threw&&encoded&&typeof breakdown.parts.haircut_bps.value!=='bigint',breakdown);
  assert('merged fee+impact discloses haircut separate',
    breakdown.parts.quoter_fee_and_impact_merged.includes_haircut===false
    && /haircut/i.test(breakdown.parts.quoter_fee_and_impact_merged.note),
    breakdown.parts.quoter_fee_and_impact_merged);

  const dir=mkdtempSync(join(tmpdir(),'abc-screen-bigint-'));
  try {
    const store=openAbc(dir);
    ensureScreeningSchema(store);
    const token='0x00000000000000000000000000000000000000b1';
    const minute=minuteStart(1_700_100_000);
    let upsertThrew=false;
    try {
      recordEvalFromCycle(store,{
        strategy:'A',token,minute,
        ev:{signal:{strategy:'A',minute},persist:{},reason:null},
        gradTs:minute-7200,watched:true,buckets:[],
        pool:{quote:zeroAddress,deployer:'0xcreator'},
        safety:{ok:true,checks:[],plan},
        paperFilled:true,codeVersion:CODE_VERSION,
      });
    } catch(e) { upsertThrew=true; console.log('upsert bigint',e); }
    assert('planned-entry upsert screening_evals without BigInt throw',!upsertThrew);
    const row=store.db.prepare('SELECT risk_json,funnel_stage,has_signal,paper_filled FROM screening_evals WHERE token=?').get(token);
    assert('risk_json parses after BigInt-safe upsert',!!row&&!!JSON.parse(row.risk_json),row);
    store.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
}

{
  // Funnel: WARMUP data != AGE; consecutive-minute OBSERVING != AGE / != generic DATA (P0)
  const age=classifyFunnelStage({watched:true,ev:{signal:null,reason:'WARMUP_GRADUATION_LT_2H'},gradTs:1,paperFilled:false});
  const w=classifyFunnelStage({watched:true,ev:{signal:null,reason:'WARMUP'},gradTs:1_700_000_000,paperFilled:false});
  const w30=classifyFunnelStage({watched:true,ev:{signal:null,reason:'WARMUP_LT_30_CONSECUTIVE'},gradTs:1_700_000_000,paperFilled:false});
  const w120=classifyFunnelStage({watched:true,ev:{signal:null,reason:'WARMUP_LT_120M'},gradTs:1_700_000_000,paperFilled:false});
  const win=classifyFunnelStage({watched:true,ev:{signal:null,reason:'WINDOW_INCOMPLETE'},gradTs:1_700_000_000,paperFilled:false});
  assert('WARMUP_GRADUATION_* => AGE_INCOMPLETE',age==='AGE_INCOMPLETE',age);
  assert('WARMUP => DATA_INCOMPLETE not AGE',w==='DATA_INCOMPLETE',w);
  assert('WARMUP_LT_30_CONSECUTIVE => OBSERVING (P0)',w30==='OBSERVING',w30);
  assert('WARMUP_LT_120M => DATA_INCOMPLETE',w120==='DATA_INCOMPLETE',w120);
  assert('WINDOW_INCOMPLETE => OBSERVING (P0)',win==='OBSERVING',win);

  const dir=mkdtempSync(join(tmpdir(),'abc-screen-funnel-'));
  try {
    const store=openAbc(dir);
    ensureScreeningSchema(store);
    const token='0x00000000000000000000000000000000000000f2';
    const minute=minuteStart(1_700_200_000);
    recordEvalFromCycle(store,{strategy:'A',token,minute,ev:{signal:null,reason:'WARMUP_LT_120M'},gradTs:minute-48*3600,watched:true,buckets:[],pool:{quote:zeroAddress}});
    recordEvalFromCycle(store,{strategy:'B',token,minute,ev:{signal:null,reason:'WARMUP_GRADUATION_LT_24H'},gradTs:minute-3600,watched:true,buckets:[],pool:{quote:zeroAddress}});
    recordEvalFromCycle(store,{strategy:'C',token,minute,ev:{signal:null,reason:'WARMUP_LT_30_CONSECUTIVE'},gradTs:minute-3600,watched:true,buckets:[],pool:{quote:zeroAddress}});
    const rep=screeningReport(store,{readOnly:true});
    assert('funnel denominators: data warmup not in AGE_INCOMPLETE',rep.strategies.A.stages.DATA_INCOMPLETE>=1&&rep.strategies.A.stages.AGE_INCOMPLETE===0,rep.strategies.A.stages);
    assert('funnel denominators: graduation warmup in AGE_INCOMPLETE',rep.strategies.B.stages.AGE_INCOMPLETE>=1&&rep.strategies.B.stages.DATA_INCOMPLETE===0,rep.strategies.B.stages);
    assert('funnel denominators: OBSERVING stage for consecutive-minute',rep.strategies.C.stages.OBSERVING>=1&&rep.strategies.C.stages.AGE_INCOMPLETE===0,rep.strategies.C.stages);
    assert('funnel object exposes denominators',!!rep.strategies.A.funnel?.denominators,rep.strategies.A.funnel);
    assert('funnel exposes observing denominator',!!rep.strategies.C.funnel?.denominators?.observing,rep.strategies.C.funnel);
    store.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
}

{
  // screening-report read-only: empty DB table count unchanged; no schema ensure
  const dir=mkdtempSync(join(tmpdir(),'abc-screen-ro-'));
  try {
    const store=openAbc(dir);
    store.db.exec('DROP TABLE IF EXISTS screening_evals');
    const tableCount=store.db.prepare(`SELECT count(*) c FROM sqlite_master WHERE type='table'`).get().c;
    store.db.exec('PRAGMA query_only=ON');
    const rep=screeningReport(store,{readOnly:true});
    assert('missing screening_evals => not-started/empty',rep.status==='NOT_STARTED'||(rep.note&&/absent|not started|not-started/i.test(rep.note)),rep);
    const tableCount2=store.db.prepare(`SELECT count(*) c FROM sqlite_master WHERE type='table'`).get().c;
    assert('empty/missing table: table count unchanged',tableCount===tableCount2,{tableCount,tableCount2});
    const qo=store.db.prepare('PRAGMA query_only').get();
    assert('preserves caller query_only ON',qo&&(qo.query_only===1||qo.query_only===true||qo.query_only==='1'),qo);
    store.close();

    const ro=openAbcReadonly(dir);
    assert('openAbcReadonly sets readOnly flag',ro.readOnly===true,ro);
    let wrote=false;
    try { ro.db.exec('CREATE TABLE should_fail(x INTEGER)'); wrote=true; } catch {}
    assert('readonly connection rejects writes',!wrote);
    const rep2=screeningReport(ro,{readOnly:true});
    assert('readonly open report OK or not-started',rep2.mode==='ABC_SCREENING_REPORT_READONLY',rep2);
    ro.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
}

{
  // Repeat-eval upsert: signal+fill then no-signal update stays consistent
  const dir=mkdtempSync(join(tmpdir(),'abc-screen-upsert-'));
  try {
    const store=openAbc(dir);
    ensureScreeningSchema(store);
    const token='0x00000000000000000000000000000000000000f3';
    const minute=minuteStart(1_700_300_000);
    recordEvalFromCycle(store,{
      strategy:'A',token,minute,
      ev:{signal:{strategy:'A',minute},persist:{}},
      gradTs:minute-7200,watched:true,buckets:[],
      pool:{quote:zeroAddress},
      safety:{ok:true,checks:[{name:'phase2',status:'PASS'}],plan:{loss_pct:0.01,haircut_bps:50}},
      paperFilled:true,
    });
    recordEvalFromCycle(store,{
      strategy:'A',token,minute,
      ev:{signal:null,persist:{},reason:'NO_T'},
      gradTs:minute-7200,watched:true,buckets:[],
      pool:{quote:zeroAddress},
      safety:null,paperFilled:false,
    });
    const row=store.db.prepare('SELECT has_signal,paper_filled,funnel_stage,checks_json FROM screening_evals WHERE strategy=? AND token=? AND minute=?').get('A',token,minute);
    assert('repeat-eval keeps has_signal with paper_filled',row.has_signal===1&&row.paper_filled===1,row);
    assert('repeat-eval funnel stays PAPER_FILL',row.funnel_stage==='PAPER_FILL',row);
    assert('repeat-eval keeps entry checks evidence',!!row.checks_json&&row.checks_json.includes('phase2'),row.checks_json);
    const merged=mergeScreeningEvalRow(
      {has_signal:1,paper_filled:1,funnel_stage:'PAPER_FILL',checks:[{name:'phase2'}],risk:{x:1}},
      {has_signal:0,paper_filled:0,funnel_stage:'DATA_INCOMPLETE',checks:null,risk:null,aggregate_reason:'NO_T'}
    );
    assert('merge helper monotonic signal+fill',merged.has_signal&&merged.paper_filled&&merged.funnel_stage==='PAPER_FILL',merged);
    store.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
}

{
  // Creator risk honesty
  const onlyCreator=creatorNetSellRatio({creator:'0xabc'});
  assert('creator-only => UNKNOWN incomplete placeholder',onlyCreator.status==='UNKNOWN'&&onlyCreator.complete===false,onlyCreator);
}

{
  // P0: dual top10 diagnose fields (gate unchanged)
  const dualMissing=dualTop10Concentration(null);
  assert('dual top10 missing => UNKNOWN not invented',dualMissing.top10_raw.status==='UNKNOWN'&&dualMissing.top10_ex_lp.status==='UNKNOWN',dualMissing);
  assert('dual top10 gate unchanged flag',dualMissing.gate_unchanged===true&&dualMissing.gate_field==='top10_circulating_bps',dualMissing);

  const dual={
    holder_count:20,
    top10_circulating_bps:2500,
    top10_total_supply_bps:2000,
    top10_raw_total_supply_bps:4500,
    top10_ex_lp_circulating_bps:2500,
    top10_ex_lp_total_supply_bps:2000,
    lp_exclusion:{status:'OBSERVED',excluded_count:3,addresses:['0xa','0xb','0xc'],note:'test'},
  };
  const d=dualTop10Concentration(dual);
  assert('dual top10_raw OBSERVED from additive field',d.top10_raw.status==='OBSERVED'&&d.top10_raw.value_bps===4500,d.top10_raw);
  assert('dual top10_ex_lp OBSERVED',d.top10_ex_lp.status==='OBSERVED'&&d.top10_ex_lp.value_bps===2500,d.top10_ex_lp);
  assert('dual includes_lp true when raw field present',d.top10_raw.includes_lp===true,d.top10_raw);

  const checks=buildSafetyChecks({
    pool:{launch:{phase:2},liquidity:1n,sqrtPriceX96:1n,quote:zeroAddress},
    holders:dual,
  });
  const gate=checks.find(c=>c.name==='top10_circulating_bps');
  const raw=checks.find(c=>c.name==='top10_raw');
  const ex=checks.find(c=>c.name==='top10_ex_lp');
  assert('gate top10 still PASS/FAIL at 6000',gate&&gate.status==='PASS'&&gate.threshold===6000,gate);
  assert('diagnose top10_raw additive',raw&&raw.status==='OBSERVED'&&raw.value===4500&&raw.diagnose_only===true,raw);
  assert('diagnose top10_ex_lp additive',ex&&ex.status==='OBSERVED'&&ex.value===2500&&ex.diagnose_only===true,ex);
}

{
  // P0: RT paper-size diagnostic evidence; threshold unchanged
  const plan={
    buy:{},sell:{},haircut_bps:50,buyGas:0.1,sellGas:0.1,
    initial:30,recovered:28,loss:2.2,loss_pct:0.073,cash_out:30.1,qty:'1000',
  };
  const br=quoteLossBreakdown(plan);
  assert('RT paper_size_diagnostic present',br.paper_size_diagnostic&&br.paper_size_diagnostic.status==='OBSERVED',br.paper_size_diagnostic);
  assert('RT paper size records initial 30',br.paper_size_diagnostic.planned_initial_usd===30,br.paper_size_diagnostic);
  assert('RT gate threshold unchanged 5%',br.gate_threshold_pct===0.05&&br.gate_unchanged===true,br);
  assert('RT discloses merged fee+impact excl haircut',br.parts.quoter_fee_and_impact_merged.includes_haircut===false,br.parts);
}

}
