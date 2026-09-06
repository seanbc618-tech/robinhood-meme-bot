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
 * - top10_raw: true raw-with-LP / total_supply ONLY when explicitly flagged includes_lp=true
 * - top10_ex_lp: circulating_ex_infra (same basis as today's gate field)
 * - top10_ex_infra_total_supply_bps: legacy diagnostic (chain numerator after infra removal)
 * Never invents includes_lp=true from a legacy numeric field alone.
 */
export function dualTop10Concentration(holdersSummary=null,{holdersError=null}={}) {
  if(holdersError) {
    const unk={status:'UNKNOWN',value_bps:null,reason:String(holdersError),note:'holders fetch failed - not fabricated'};
    return {top10_raw:unk,top10_ex_lp:{...unk},top10_ex_infra_total_supply_bps:unk,lp_exclusion:{status:'UNKNOWN',reason:String(holdersError)},gate_field:'top10_circulating_bps',gate_unchanged:true};
  }
  if(!holdersSummary) {
    const unk={status:'UNKNOWN',value_bps:null,reason:'HOLDERS_NOT_FETCHED',note:'No holders summary - not fabricated'};
    return {top10_raw:unk,top10_ex_lp:{...unk},top10_ex_infra_total_supply_bps:unk,lp_exclusion:{status:'UNKNOWN',reason:'HOLDERS_NOT_FETCHED'},gate_field:'top10_circulating_bps',gate_unchanged:true};
  }
  const lpMeta=holdersSummary.lp_exclusion||null;
  const hasLpExclusion=lpMeta&&lpMeta.status==='OBSERVED';

  // Legacy chain field: numerator computed AFTER removing infrastructure — ex-infra / circulating-style.
  const legacyExInfraBps=holdersSummary.top10_ex_infra_total_supply_bps??holdersSummary.top10_total_supply_bps??null;
  const top10_ex_infra_total_supply_bps=legacyExInfraBps==null
    ?{status:'UNKNOWN',value_bps:null,denominator:'total_supply',reason:'TOP10_EX_INFRA_MISSING',note:'Not fabricated'}
    :{status:'OBSERVED',value_bps:legacyExInfraBps,denominator:'total_supply',
      includes_lp:false,
      note:'Legacy/diagnostic ex-infra top10 / total_supply (chain removes infra before numerator). NOT raw-including-LP.'};

  // True raw-with-LP: require explicit includes_lp===true. Never infer from field presence or legacy alone.
  const rawField=holdersSummary.top10_raw_total_supply_bps;
  const rawIncludesLp=holdersSummary.top10_raw_includes_lp;
  let top10_raw;
  if(rawField!=null&&rawIncludesLp===true) {
    top10_raw={status:'OBSERVED',value_bps:rawField,denominator:'total_supply',includes_lp:true,
      note:holdersSummary.top10_raw_note||'top10 of all positive balances (incl. identifiable LP/infra) / total_supply'};
  } else if(rawField!=null&&rawIncludesLp===false) {
    // Present but explicitly NOT including LP (e.g. safety fallback copied legacy into raw_*).
    top10_raw={status:'OBSERVED',value_bps:rawField,denominator:'total_supply',includes_lp:false,
      reason:'TOP10_RAW_EX_INFRA_STYLE',
      note:holdersSummary.top10_raw_note
        ||'top10_raw_total_supply_bps present with top10_raw_includes_lp=false — ex-infra/circulating-style, NOT raw-including-LP'};
  } else if(rawField!=null) {
    // Field present without explicit includes_lp flag — refuse to invent includes_lp=true.
    top10_raw={status:'UNKNOWN',value_bps:null,denominator:'total_supply',includes_lp:false,
      reason:'TOP10_RAW_INCLUDES_LP_UNSPECIFIED',
      observed_value_bps:rawField,
      note:'top10_raw_total_supply_bps present but top10_raw_includes_lp not explicitly true — refusing to claim raw-including-LP'};
  } else {
    // No true raw field. Keep raw UNKNOWN; legacy lives under top10_ex_infra_total_supply_bps.
    top10_raw={status:'UNKNOWN',value_bps:null,denominator:'total_supply',includes_lp:false,
      reason:'TOP10_RAW_MISSING',
      note:legacyExInfraBps!=null
        ?'True raw-with-LP unavailable; see top10_ex_infra_total_supply_bps for legacy ex-infra/total_supply diagnostic'
        :'Not fabricated'};
  }

  const exLpBps=holdersSummary.top10_ex_lp_circulating_bps??holdersSummary.top10_circulating_bps??null;
  let top10_ex_lp;
  if(exLpBps==null) {
    top10_ex_lp={status:'UNKNOWN',value_bps:null,denominator:'circulating_ex_infra',reason:'TOP10_EX_LP_MISSING',note:'Not fabricated'};
  } else if(!hasLpExclusion&&holdersSummary.top10_ex_lp_circulating_bps==null&&holdersSummary.top10_circulating_bps!=null) {
    top10_ex_lp={status:'OBSERVED',value_bps:exLpBps,denominator:'circulating_ex_infra',
      note:'Legacy top10_circulating_bps (historically ex-infra); lp_exclusion metadata absent on this payload'};
  } else if(!hasLpExclusion&&holdersSummary.top10_ex_lp_circulating_bps==null) {
    top10_ex_lp={status:'UNKNOWN',value_bps:null,denominator:'circulating_ex_infra',
      reason:'LP_EXCLUSION_UNIDENTIFIABLE',note:'Cannot confirm LP/pool exclusion - not invented'};
  } else {
    top10_ex_lp={status:'OBSERVED',value_bps:exLpBps,denominator:'circulating_ex_infra',
      note:'ex-LP/infra top10 / circulating_ex_infra (same basis as gate top10_circulating_bps)'};
  }

  // Never infer observed LP exclusion merely from a legacy numeric field.
  const lp_exclusion=hasLpExclusion
    ?{status:'OBSERVED',...lpMeta}
    :(lpMeta&&lpMeta.status==='UNKNOWN'
      ?lpMeta
      :{status:'UNKNOWN',
        reason:'LP_EXCLUSION_UNIDENTIFIABLE',
        note:'LP/pool addresses not identifiable on this payload - UNKNOWN, not invented from legacy numeric fields'});

  return {
    top10_raw,top10_ex_lp,top10_ex_infra_total_supply_bps,lp_exclusion,
    gate_field:'top10_circulating_bps',
    gate_threshold_bps:6000,
    gate_unchanged:true,
    source:evidence('holderData.summary',{dual:'top10_raw+top10_ex_lp'}),
    note:'Diagnose-only dual metrics; buy gate still uses top10_circulating_bps alone',
  };
}

function planAmountsComplete(plan) {
  if(!plan||typeof plan!=='object') return false;
  return Number.isFinite(plan.initial)
    && Number.isFinite(plan.recovered)
    && Number.isFinite(plan.buyGas)
    && Number.isFinite(plan.sellGas)
    && Number.isFinite(plan.loss)
    && Number.isFinite(plan.loss_pct);
}

/**
 * Quote loss breakdown. Quoter fee+impact are merged when inseparable.
 * Residual principal-(recovered+sellGas) already embeds buy/sell haircut effects
 * (recovered reflects haircut-reduced qty + sell haircut) — label includes_haircut honestly.
 * haircut_bps is the applied rate (do not add residual + separate haircut USD).
 * Planned RT cost for configured paper size is recorded as diagnostic evidence; gate threshold unchanged.
 */
export function quoteLossBreakdown(plan) {
  if(!plan) return {
    status:'UNKNOWN',parts:null,complete:false,
    paper_size_diagnostic:null,
    gate_threshold_pct:0.05,gate_unchanged:true,
    note:'No plan quotes available - rejection paths without plan lack fee/impact evidence',
  };
  const complete=planAmountsComplete(plan);
  const haircutRaw=plan.haircut_bps!=null?plan.haircut_bps:HAIRCUT_BPS;
  const haircutSafe=asJsonNumberOrString(haircutRaw);
  const residualComputable=Number.isFinite(plan.initial)&&Number.isFinite(plan.recovered)
    &&Number.isFinite(plan.buyGas)&&Number.isFinite(plan.sellGas);
  // recovered already reflects buy-haircut-reduced qty + sell haircut; residual is combined quoter+haircut.
  const residualIncludesHaircut=residualComputable;
  const parts={
    quoter_fee_and_impact_merged:{
      status:residualComputable?'OBSERVED':'UNKNOWN',
      value:null,
      includes_haircut:residualIncludesHaircut,
      haircut_bps_listed_separately:true,
      note:residualIncludesHaircut
        ?'COMBINED residual: principal-(recovered+sellGas). recovered already embeds buy+sell execution haircuts + quoter fee/impact (inseparable). includes_haircut=true. haircut_bps listed separately as the applied rate — do NOT double-count residual + haircut USD.'
        :'MERGED LABEL: quoter embeds fee+impact (inseparable). Residual not computable without initial/recovered/gas amounts.',
    },
    haircut_bps:{
      status:haircutSafe!=null?'OBSERVED':'UNKNOWN',
      value:haircutSafe,
      note:'Applied haircut rate (JSON-safe Number/string). Already embedded in recovered/residual — not an additive USD component on top of quoter_fee_and_impact_merged.value.',
    },
    buy_gas_usd:{status:Number.isFinite(plan.buyGas)?'OBSERVED':'UNKNOWN',value:plan.buyGas??null},
    sell_gas_usd:{status:Number.isFinite(plan.sellGas)?'OBSERVED':'UNKNOWN',value:plan.sellGas??null},
    l1_allowance:{status:'UNKNOWN',value:null,note:'L1 allowance not isolated in paper plan - PLACEHOLDER/unavailable'},
    total_round_trip_loss_usd:{status:Number.isFinite(plan.loss)?'OBSERVED':'UNKNOWN',value:plan.loss??null},
    total_round_trip_loss_pct:{status:Number.isFinite(plan.loss_pct)?'OBSERVED':'UNKNOWN',value:plan.loss_pct??null},
  };
  if(residualComputable) {
    const sellUsd=plan.recovered+plan.sellGas, principal=plan.initial-plan.buyGas;
    parts.quoter_fee_and_impact_merged.value=Number.isFinite(sellUsd)?principal-sellUsd:null;
    parts.quoter_fee_and_impact_merged.status=parts.quoter_fee_and_impact_merged.value==null?'UNKNOWN':'OBSERVED';
    parts.quoter_fee_and_impact_merged.includes_haircut=true;
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
    components:'buy_gas + sell_gas + combined quoter+haircut residual (fee+impact inseparable; haircut embedded in recovered)',
    note:'Bound to configured paper principal via plannedRoundTrip; residual includes haircut effects — haircut_bps is rate disclosure only',
  };
  return {
    status:complete?'OBSERVED':'UNKNOWN',
    parts,
    complete,
    paper_size_diagnostic,
    gate_threshold_pct:0.05,gate_unchanged:true,
    source:evidence('plannedRoundTripFromQuotes',{haircut_bps:asJsonNumberOrString(HAIRCUT_BPS)}),
    note:complete
      ?'Nominal pool.liquidity is not USD depth; observe-only. Combined residual includes quoter fee/impact + haircut effects (recovered embeds haircuts). RT reject threshold unchanged.'
      :'Plan present but incomplete/missing amounts — complete=false; residual/haircut labeling UNKNOWN where not computable. RT reject threshold unchanged.',
  };
}
