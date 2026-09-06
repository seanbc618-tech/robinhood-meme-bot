/** MEME_SCREENING_P0 diagnose-only metrics (dual top10 + RT paper diagnostics). */
import {HAIRCUT_BPS} from './abc-collect.mjs';
import {evidence} from './abc-screening-not.mjs';

function asJsonNumberOrString(v) {
  if(typeof v==='bigint') {
    const n=Number(v);
    return Number.isSafeInteger(n)?n:v.toString();
  }
  return v;
}

/**
 * Dual top10 concentration diagnostics (additive; does not change gate thresholds).
 * - top10_raw: total_supply-based incl. identifiable LP/infra when available
 * - top10_ex_lp: circulating_ex_infra (same basis as today's gate field)
 * Never invents values - UNKNOWN + reason when LP exclusion cannot be computed.
 */
export function dualTop10Concentration(holdersSummary=null,{holdersError=null}={}) {
  if(holdersError) {
    const unk={status:'UNKNOWN',value_bps:null,reason:String(holdersError),note:'holders fetch failed - not fabricated'};
    return {top10_raw:unk,top10_ex_lp:{...unk},lp_exclusion:{status:'UNKNOWN',reason:String(holdersError)},gate_field:'top10_circulating_bps',gate_unchanged:true};
  }
  if(!holdersSummary) {
    const unk={status:'UNKNOWN',value_bps:null,reason:'HOLDERS_NOT_FETCHED',note:'No holders summary - not fabricated'};
    return {top10_raw:unk,top10_ex_lp:{...unk},lp_exclusion:{status:'UNKNOWN',reason:'HOLDERS_NOT_FETCHED'},gate_field:'top10_circulating_bps',gate_unchanged:true};
  }
  const lpMeta=holdersSummary.lp_exclusion||null;
  const hasLpExclusion=lpMeta&&lpMeta.status==='OBSERVED';
  // Prefer explicit additive fields from holderData; fall back to legacy summary fields.
  const rawBps=holdersSummary.top10_raw_total_supply_bps??holdersSummary.top10_total_supply_bps??null;
  const exLpBps=holdersSummary.top10_ex_lp_circulating_bps??holdersSummary.top10_circulating_bps??null;
  const top10_raw=rawBps==null
    ?{status:'UNKNOWN',value_bps:null,denominator:'total_supply',reason:'TOP10_RAW_MISSING',note:'Not fabricated'}
    :{status:'OBSERVED',value_bps:rawBps,denominator:'total_supply',
      includes_lp:holdersSummary.top10_raw_total_supply_bps!=null,
      note:holdersSummary.top10_raw_total_supply_bps!=null
        ?'top10 of all positive balances (incl. identifiable LP/infra) / total_supply'
        :'Legacy fallback: ex-infra top10 / total_supply (top10_total_supply_bps) - true raw-with-LP unavailable'};
  let top10_ex_lp;
  if(exLpBps==null) {
    top10_ex_lp={status:'UNKNOWN',value_bps:null,denominator:'circulating_ex_infra',reason:'TOP10_EX_LP_MISSING',note:'Not fabricated'};
  } else if(!hasLpExclusion&&holdersSummary.top10_ex_lp_circulating_bps==null&&holdersSummary.top10_circulating_bps!=null) {
    // Legacy summary without lp_exclusion metadata: circulating field historically ex-infra, but mark honesty.
    top10_ex_lp={status:'OBSERVED',value_bps:exLpBps,denominator:'circulating_ex_infra',
      note:'Legacy top10_circulating_bps (historically ex-infra); lp_exclusion metadata absent on this payload'};
  } else if(!hasLpExclusion&&holdersSummary.top10_ex_lp_circulating_bps==null) {
    top10_ex_lp={status:'UNKNOWN',value_bps:null,denominator:'circulating_ex_infra',
      reason:'LP_EXCLUSION_UNIDENTIFIABLE',note:'Cannot confirm LP/pool exclusion - not invented'};
  } else {
    top10_ex_lp={status:'OBSERVED',value_bps:exLpBps,denominator:'circulating_ex_infra',
      note:'ex-LP/infra top10 / circulating_ex_infra (same basis as gate top10_circulating_bps)'};
  }
  const lp_exclusion=hasLpExclusion
    ?{status:'OBSERVED',...lpMeta}
    :(lpMeta&&lpMeta.status==='UNKNOWN'
      ?lpMeta
      :{status:holdersSummary.top10_circulating_bps!=null?'OBSERVED':'UNKNOWN',
        reason:holdersSummary.top10_circulating_bps!=null?null:'LP_EXCLUSION_UNIDENTIFIABLE',
        note:holdersSummary.top10_circulating_bps!=null
          ?'Inferred from historical circulating_ex_infra gate field; explicit addresses unavailable'
          :'LP/pool addresses not identifiable - UNKNOWN, not invented'});
  return {
    top10_raw,top10_ex_lp,lp_exclusion,
    gate_field:'top10_circulating_bps',
    gate_threshold_bps:6000,
    gate_unchanged:true,
    source:evidence('holderData.summary',{dual:'top10_raw+top10_ex_lp'}),
    note:'Diagnose-only dual metrics; buy gate still uses top10_circulating_bps alone',
  };
}

/**
 * Quote loss breakdown. Quoter fee+impact are merged when inseparable.
 * Haircut is tracked separately (JSON-safe Number/string) - merged label discloses this.
 * Planned RT cost for configured paper size is recorded as diagnostic evidence; gate threshold unchanged.
 */
export function quoteLossBreakdown(plan) {
  if(!plan) return {
    status:'UNKNOWN',parts:null,complete:false,
    paper_size_diagnostic:null,
    gate_threshold_pct:0.05,gate_unchanged:true,
    note:'No plan quotes available - rejection paths without plan lack fee/impact evidence',
  };
  const haircutRaw=plan.haircut_bps!=null?plan.haircut_bps:HAIRCUT_BPS;
  const haircutSafe=asJsonNumberOrString(haircutRaw);
  const parts={
    quoter_fee_and_impact_merged:{
      status:plan.buy&&plan.sell?'OBSERVED':'UNKNOWN',value:null,
      includes_haircut:false,
      haircut_tracked_separately:true,
      note:'MERGED LABEL: quoter embeds fee+impact (inseparable). Does NOT include execution haircut_bps (listed separately). Total round-trip loss includes haircut+gas.',
    },
    haircut_bps:{
      status:haircutSafe!=null?'OBSERVED':'UNKNOWN',
      value:haircutSafe,
      note:'JSON-safe Number/string (never raw BigInt)',
    },
    buy_gas_usd:{status:Number.isFinite(plan.buyGas)?'OBSERVED':'UNKNOWN',value:plan.buyGas??null},
    sell_gas_usd:{status:Number.isFinite(plan.sellGas)?'OBSERVED':'UNKNOWN',value:plan.sellGas??null},
    l1_allowance:{status:'UNKNOWN',value:null,note:'L1 allowance not isolated in paper plan - PLACEHOLDER/unavailable'},
    total_round_trip_loss_usd:{status:Number.isFinite(plan.loss)?'OBSERVED':'UNKNOWN',value:plan.loss??null},
    total_round_trip_loss_pct:{status:Number.isFinite(plan.loss_pct)?'OBSERVED':'UNKNOWN',value:plan.loss_pct??null},
  };
  if(Number.isFinite(plan.initial)&&Number.isFinite(plan.recovered)&&Number.isFinite(plan.buyGas)&&Number.isFinite(plan.sellGas)) {
    const sellUsd=plan.recovered+plan.sellGas, principal=plan.initial-plan.buyGas;
    parts.quoter_fee_and_impact_merged.value=Number.isFinite(sellUsd)?principal-sellUsd:null;
    parts.quoter_fee_and_impact_merged.status=parts.quoter_fee_and_impact_merged.value==null?'UNKNOWN':'OBSERVED';
  }
  const paper_size_diagnostic={
    status:Number.isFinite(plan.initial)||Number.isFinite(plan.cash_out)?'OBSERVED':'UNKNOWN',
    planned_initial_usd:Number.isFinite(plan.initial)?plan.initial:null,
    planned_cash_out_usd:Number.isFinite(plan.cash_out)?plan.cash_out:null,
    planned_qty:plan.qty!=null?asJsonNumberOrString(plan.qty):null,
    loss_usd:Number.isFinite(plan.loss)?plan.loss:null,
    loss_pct:Number.isFinite(plan.loss_pct)?plan.loss_pct:null,
    gate_threshold_pct:0.05,
    gate_behavior:'UNCHANGED - still reject when loss_pct>0.05; this block is diagnose evidence only',
    components:'buy_gas + sell_gas + haircut_bps + quoter_fee_and_impact_merged (fee+impact inseparable)',
    note:'Bound to configured paper principal via plannedRoundTrip; disclose haircuts and merged fee+impact',
  };
  return {
    status:'OBSERVED',parts,complete:true,paper_size_diagnostic,
    gate_threshold_pct:0.05,gate_unchanged:true,
    source:evidence('plannedRoundTripFromQuotes',{haircut_bps:asJsonNumberOrString(HAIRCUT_BPS)}),
    note:'Nominal pool.liquidity is not USD depth; observe-only. Merged fee+impact excludes haircut (disclosed). RT reject threshold unchanged.',
  };
}
