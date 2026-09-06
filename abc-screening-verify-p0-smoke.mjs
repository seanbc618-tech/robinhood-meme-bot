/** Offline P0 smoke without node:sqlite — dual top10 + OBSERVING + RT labels. */
import {dualTop10Concentration,quoteLossBreakdown} from './abc-screening-risk.mjs';
import {classifyFunnelStage} from './abc-screening-funnel.mjs';

const failures=[];
function assert(name,ok,detail){if(ok) console.log('PASS',name); else {console.log('FAIL',name,detail||'');failures.push(name);}}

assert('missing holders => UNKNOWN',dualTop10Concentration(null).top10_raw.status==='UNKNOWN');
assert('OBSERVING for consecutive-minute',classifyFunnelStage({watched:true,ev:{signal:null,reason:'WARMUP_LT_30_CONSECUTIVE'},gradTs:1})==='OBSERVING');
assert('AGE still graduation',classifyFunnelStage({watched:true,ev:{signal:null,reason:'WARMUP_GRADUATION_LT_2H'},gradTs:1})==='AGE_INCOMPLETE');
assert('DATA still WARMUP',classifyFunnelStage({watched:true,ev:{signal:null,reason:'WARMUP'},gradTs:1})==='DATA_INCOMPLETE');

// Legacy/raw-looking numbers without an explicit includes_lp:true must stay UNKNOWN.
assert(
  'missing includes_lp flag => raw UNKNOWN',
  dualTop10Concentration({
    top10_raw_total_supply_bps:4000,
    top10_ex_lp_circulating_bps:2000,
    top10_circulating_bps:2000,
    lp_exclusion:{status:'OBSERVED',excluded_count:1,addresses:['0x1']},
  }).top10_raw.status==='UNKNOWN',
);

const dual=dualTop10Concentration({
  top10_raw_total_supply_bps:4000,
  top10_raw_includes_lp:true,
  top10_ex_lp_circulating_bps:2000,
  top10_circulating_bps:2000,
  lp_exclusion:{status:'OBSERVED',excluded_count:1,addresses:['0x1']},
});
assert(
  'dual raw+ex_lp when includes_lp true',
  dual.top10_raw.value_bps===4000&&dual.top10_ex_lp.value_bps===2000&&dual.gate_unchanged,
);

const br=quoteLossBreakdown({buy:{},sell:{},initial:30,recovered:29,buyGas:0.1,sellGas:0.1,loss:1.2,loss_pct:0.04,haircut_bps:50,cash_out:30.1});
assert('RT paper diagnostic + gate unchanged',br.paper_size_diagnostic?.planned_initial_usd===30&&br.gate_unchanged===true);

if(failures.length){console.error('FAILED',failures);process.exitCode=1;}
else console.log('ALL_P0_SMOKE_PASSED');
