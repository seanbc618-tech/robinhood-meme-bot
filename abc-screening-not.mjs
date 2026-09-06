/** GROK_SCREENING_V1 NO_T detail diagnosis (diagnose-only). */
import {fxForMinute} from './abc-collect.mjs';

export const NO_T_DETAIL = Object.freeze({
  MINUTE_NOT_COLLECTED:'MINUTE_NOT_COLLECTED',
  COVERAGE_NOT_CLOSED:'COVERAGE_NOT_CLOSED',
  BUCKET_INVALID:'BUCKET_INVALID',
  FX_MISSING:'FX_MISSING',
  FX_OBSERVED_STALE:'FX_OBSERVED_STALE',
  FX_SOURCE_STALE:'FX_SOURCE_STALE',
  NO_VALID_PRICE:'NO_VALID_PRICE',
  NOT_IN_WATCH:'NOT_IN_WATCH',
});

const FX_REASON_MAP={
  NO_FX_SNAP:NO_T_DETAIL.FX_MISSING,
  OBSERVED_AT_LAG:NO_T_DETAIL.FX_OBSERVED_STALE,
  SOURCE_LAST_UPDATED_LAG:NO_T_DETAIL.FX_SOURCE_STALE,
};

export function mapFxReason(reason) {
  if(reason==null) return null;
  return FX_REASON_MAP[reason]||NO_T_DETAIL.FX_MISSING;
}

function evidence(source,extra={}) {return {source,...extra};}

/** Reads buckets/minute_status/coverage_gaps/fx_snap — never fabricates. */
export function diagnoseTargetMinute(store,token,minute,{quote=null,watched=true}={}) {
  const observed_at=Date.now();
  const pool=store.db.prepare('SELECT * FROM pools WHERE token=?').get(token);
  const q=quote??pool?.quote??null;
  const bucket=store.db.prepare('SELECT * FROM buckets WHERE token=? AND minute=?').get(token,minute);
  const status=store.db.prepare('SELECT * FROM minute_status WHERE token=? AND minute=?').get(token,minute);
  const gap=store.db.prepare(
    'SELECT * FROM coverage_gaps WHERE token=? AND (from_ts IS NULL OR from_ts<=?) AND (to_ts IS NULL OR to_ts>=?) ORDER BY at DESC LIMIT 1'
  ).get(token,minute+60,minute);
  const fx=fxForMinute(store,minute,q);
  const base={
    observed_at,token,minute,
    source:evidence('buckets|minute_status|coverage_gaps|fx_snap',{
      has_bucket:!!bucket,bucket_invalid:bucket?!!bucket.invalid:null,
      bucket_usd_usable:bucket?bucket.usd_usable:null,bucket_close_usd:bucket?.close_usd??null,
      bucket_no_trade:bucket?.no_trade??null,minute_status:status?.reason??null,
      coverage_gap_reason:gap?.reason??null,last_complete_minute:pool?.last_complete_minute??null,
      fx_ok:fx.ok,fx_reason:fx.reason??null,watched:!!watched,
    }),
  };
  if(!watched) return {...base,detail_code:NO_T_DETAIL.NOT_IN_WATCH,filter_reject:false,note:'Not seated/held — not a screening reject'};
  if(bucket) {
    if(bucket.invalid) return {...base,detail_code:NO_T_DETAIL.BUCKET_INVALID,filter_reject:true,metrics:{invalid:1},missing:false};
    if(bucket.close_usd>0&&bucket.usd_usable) return {...base,detail_code:null,filter_reject:false,bucket_ok:true,metrics:{close_usd:bucket.close_usd},missing:false};
    if(!fx.ok) return {...base,detail_code:mapFxReason(fx.reason),filter_reject:true,metrics:{fx_ok:false},missing:fx.reason==='NO_FX_SNAP'};
    if(status&&FX_REASON_MAP[status.reason]) return {...base,detail_code:mapFxReason(status.reason),filter_reject:true,missing:false};
    return {...base,detail_code:NO_T_DETAIL.NO_VALID_PRICE,filter_reject:true,metrics:{close_usd:bucket.close_usd,no_trade:bucket.no_trade,usd_usable:bucket.usd_usable}};
  }
  if(status&&FX_REASON_MAP[status.reason]) return {...base,detail_code:mapFxReason(status.reason),filter_reject:true,missing:status.reason==='NO_FX_SNAP'};
  if(status&&status.reason==='NOT_COLLECTED') return {...base,detail_code:NO_T_DETAIL.MINUTE_NOT_COLLECTED,filter_reject:true,missing:true};
  if(gap||(pool&&(pool.last_complete_minute==null||pool.last_complete_minute<minute))) {
    if(gap||(pool&&pool.last_event_block==null)) return {...base,detail_code:NO_T_DETAIL.COVERAGE_NOT_CLOSED,filter_reject:true,missing:true};
    return {...base,detail_code:NO_T_DETAIL.MINUTE_NOT_COLLECTED,filter_reject:true,missing:true};
  }
  if(!fx.ok) return {...base,detail_code:mapFxReason(fx.reason),filter_reject:true,missing:fx.reason==='NO_FX_SNAP'};
  return {...base,detail_code:NO_T_DETAIL.MINUTE_NOT_COLLECTED,filter_reject:true,missing:true};
}

export function fxStatusFromDiag(diag) {
  if(!diag) return 'UNKNOWN';
  if(diag.detail_code===NO_T_DETAIL.FX_MISSING||diag.detail_code===NO_T_DETAIL.FX_OBSERVED_STALE||diag.detail_code===NO_T_DETAIL.FX_SOURCE_STALE) return 'FAIL';
  if(diag.bucket_ok) return 'PASS';
  if(diag.missing) return 'UNKNOWN';
  return diag.filter_reject?'FAIL':'UNKNOWN';
}

export {evidence};
