import {mkdtempSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {zeroAddress} from 'viem';
import {openAbc,CODE_VERSION,minuteStart,HAIRCUT_BPS} from './abc-collect.mjs';
import {openAbcReadonly} from './abc-collect-readonly.mjs';
import {evaluateA} from './abc.mjs';
import {
  diagnoseTargetMinute,screeningReport,ensureScreeningSchema,
  attributedBuyRecipients,fxStatusFromDiag,buildSafetyChecks,NO_T_DETAIL,
  recordEvalFromCycle,classifyFunnelStage,quoteLossBreakdown,jsonSafe,
  upsertScreeningEval,creatorNetSellRatio,mergeScreeningEvalRow,
} from './abc-screening.mjs';
import {runPr1Regressions} from './abc-screening-verify-pr1.mjs';

const failures=[];
function assert(name,ok,detail){if(ok) console.log('PASS',name); else {console.log('FAIL',name,detail||'');failures.push(name);}}
function recips(n,usd=10){const o={};for(let i=0;i<n;i++) o['0x'+i.toString(16).padStart(40,'0')]=usd;return o;}
function bar(minute,c,extra={}){const r=extra.buy_recipients||{};return{minute,open_usd:extra.o??c,high_usd:extra.h??c,low_usd:extra.l??c,close_usd:c,volume_usd:extra.vol??100,buy_usd:extra.buy??60,sell_usd:extra.sell??40,net_inflow_usd:extra.net??20,buy_recipients:r,buy_recipient_count:Object.keys(r).length,swap_count:extra.no?0:1,no_trade:extra.no?1:0,executable:extra.no?0:1,source_block:extra.block||1};}

{
  const dir=mkdtempSync(join(tmpdir(),'abc-screen-'));
  try {
    const store=openAbc(dir);
    ensureScreeningSchema(store);
    const token='0x00000000000000000000000000000000000000f1';
    const minute=minuteStart(1_700_000_000);
    store.db.prepare(`INSERT INTO pools(token,pool_id,quote,first_seen_block,first_seen_ts,last_cursor_block,quote_status) VALUES(?,?,?,?,?,?,?)`).run(token,'0xpool',zeroAddress,1,minute-3600,1,'ok');
    const d1=diagnoseTargetMinute(store,token,minute,{quote:zeroAddress,watched:true});
    assert('FX unknown/missing is not PASS',fxStatusFromDiag(d1)!=='PASS',d1);
    store.db.prepare(`INSERT INTO minute_status(token,minute,reason,at) VALUES(?,?,?,?)`).run(token,minute,'SOURCE_LAST_UPDATED_LAG',Date.now());
    const dFx=diagnoseTargetMinute(store,token,minute,{quote:zeroAddress,watched:true});
    assert('NO_T detail FX_SOURCE_STALE',dFx.detail_code===NO_T_DETAIL.FX_SOURCE_STALE,dFx);
    const minute2=minute+60;
    store.db.prepare(`INSERT INTO buckets(token,minute,open_usd,high_usd,low_usd,close_usd,volume_usd,buy_usd,sell_usd,net_inflow_usd,buy_recipients,buy_recipient_count,swap_count,no_trade,executable,collected_at,source_block,invalid,usd_usable) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(token,minute2,1,1,1,1,0,0,0,0,'{}',0,0,1,0,1,1,1,0);
    const dInv=diagnoseTargetMinute(store,token,minute2,{quote:zeroAddress,watched:true});
    assert('NO_T detail BUCKET_INVALID',dInv.detail_code===NO_T_DETAIL.BUCKET_INVALID,dInv);
    const minute3=minute+120;
    store.db.prepare(`INSERT INTO coverage_gaps(token,from_block,to_block,from_ts,to_ts,reason,at) VALUES(?,?,?,?,?,?,?)`).run(token,1,10,minute3,minute3+60,'LIVE_SUBSCRIBE_SKIP_BACKLOG',Date.now());
    const dGap=diagnoseTargetMinute(store,token,minute3,{quote:zeroAddress,watched:true});
    assert('NO_T detail coverage/missing',dGap.detail_code===NO_T_DETAIL.COVERAGE_NOT_CLOSED||dGap.detail_code===NO_T_DETAIL.MINUTE_NOT_COLLECTED,dGap);
    assert('NO_T reasons distinct',[dFx.detail_code,dInv.detail_code,dGap.detail_code].filter((v,i,a)=>a.indexOf(v)===i).length>=2,{dFx,dInv,dGap});
    const ev={signal:null,persist:{},reason:'NO_T'};
    recordEvalFromCycle(store,{strategy:'A',token,minute,ev,gradTs:minute-7200,watched:true,buckets:[],pool:{quote:zeroAddress}});
    recordEvalFromCycle(store,{strategy:'A',token,minute,ev,gradTs:minute-7200,watched:true,buckets:[],pool:{quote:zeroAddress}});
    const n=store.db.prepare('SELECT count(*) c FROM screening_evals WHERE strategy=? AND token=? AND minute=? AND code_version=?').get('A',token,minute,CODE_VERSION).c;
    assert('duplicate minute not double-counted',n===1,n);
    const infra=new Set(['0xrouter','0xhook','0x0000000000000000000000000000000000000000']);
    const swaps=[{tx:'0xabc',token_amount:'10',quote_amount:'-1',quote_vol_usd:100}];
    const xferByTx=new Map([['0xabc',[
      {dest:'0xrouter',frm:'0x0000000000000000000000000000000000000000',value:'10'},
      {dest:'0xalice',frm:'0xrouter',value:'10'},
      {dest:'0xalice',frm:'0xrouter',value:'0'},
    ]]]);
    const rec=attributedBuyRecipients(swaps,xferByTx,infra);
    assert('infra excluded and same-tx not double-counted',Object.keys(rec).length===1&&Math.abs(rec['0xalice']-100)<1e-9,rec);
    const checks=buildSafetyChecks({pool:{launch:{phase:2},liquidity:1n,sqrtPriceX96:1n,quote:zeroAddress},holders:null});
    const hc=checks.find(c=>c.name==='holder_count');
    assert('holder unknown is UNKNOWN not 0 PASS',hc&&hc.status==='UNKNOWN'&&hc.value==null,hc);
    assert('C over-age rejection is AGE_INCOMPLETE',classifyFunnelStage({watched:true,ev:{signal:null,reason:'GRADUATION_OVER_6H'},gradTs:minute-60,minute})==='AGE_INCOMPLETE');
    const beforeBuckets=store.db.prepare('SELECT count(*) c FROM buckets').get().c;
    const beforeTables=store.db.prepare(`SELECT count(*) c FROM sqlite_master WHERE type='table'`).get().c;
    const rep=screeningReport(store,{readOnly:true});
    assert('screening-report does not modify buckets',beforeBuckets===store.db.prepare('SELECT count(*) c FROM buckets').get().c);
    assert('screening-report does not create tables',beforeTables===store.db.prepare(`SELECT count(*) c FROM sqlite_master WHERE type='table'`).get().c,beforeTables);
    assert('report has A/B/C funnel',rep.strategies.A&&rep.strategies.B&&rep.strategies.C,rep.strategies);
    store.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
}

{
  const bars=[]; const t0=1_700_000_000; const gradA=t0-3*3600;
  for(let i=0;i<=34;i++){
    const m=t0+i*60;
    if(i<30) bars.push(bar(m,100,{h:100,l:99,buy_recipients:recips(2),net:1}));
    else if(i===30) bars.push(bar(m,101,{h:101,l:100,buy_recipients:recips(2),net:1}));
    else if(i===31) bars.push(bar(m,101,{h:101,l:100,buy_recipients:recips(8),net:50}));
    else if(i===32) bars.push(bar(m,100.2,{h:101,l:100,buy_recipients:recips(8),net:50}));
    else if(i===33) bars.push(bar(m,100.5,{h:101,l:100,buy_recipients:recips(8),net:50}));
    else bars.push(bar(m,102.5,{h:103,l:101,buy_recipients:recips(8),net:50}));
  }
  let st=null,ev;
  for(const step of [30,31,32,33,34]){ev=evaluateA(bars,st,gradA,t0+step*60);st=ev.persist;}
  assert('screening v1 did not change A trigger',!!ev.signal&&ev.signal.strategy==='A',ev);
  assert('NO_T aggregate reason preserved',evaluateA([],null,gradA,t0).reason==='NO_T');
}

runPr1Regressions(assert);

assert('verify did not touch data/abc sqlite',!process.env.ABC_HOME);
if(failures.length){console.error('FAILED',failures.length,failures.join(','));process.exitCode=1;}
else console.log('ALL_SCREENING_CHECKS_PASSED',0);
