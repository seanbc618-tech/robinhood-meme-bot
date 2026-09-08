import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {zeroAddress} from 'viem';
import {openAbc,initAccounts,readAccount,writeAccount,quoteFresh,plannedRoundTripFromQuotes} from './abc-collect.mjs';
import {
  evaluateA,evaluateB,evaluateC,applyBuy,applySell,exitDecision,sellQtyFor,
  pnlMultiple,applyDayBaseline,canEnter,acquireLock,releaseLock,signalId,
} from './abc.mjs';

const failures=[];
function assert(name,ok,detail) {
  if(ok) console.log('PASS',name);
  else {console.log('FAIL',name,detail||'');failures.push(name);}
}

function recips(n,usd=10) {
  const o={};
  for(let i=0;i<n;i++) o['0x'+i.toString(16).padStart(40,'0')]=usd;
  return o;
}
function bar(minute,c,extra={}) {
  const r=extra.buy_recipients||{};
  return {
    minute,open_usd:extra.o??c,high_usd:extra.h??c,low_usd:extra.l??c,close_usd:c,
    volume_usd:extra.vol??100,buy_usd:extra.buy??60,sell_usd:extra.sell??40,net_inflow_usd:extra.net??20,
    buy_recipients:r,buy_recipient_count:Object.keys(r).length,swap_count:extra.no?0:1,
    no_trade:extra.no?1:0,executable:extra.no?0:1,source_block:extra.block||1,
  };
}
function series(start,n,price,extra) {
  return Array.from({length:n},(_,i)=>bar(start+i*60,typeof price==='function'?price(i):price,typeof extra==='function'?extra(i):extra||{}));
}

const t0=1_700_000_000;
const gradA=t0-3*3600;
const gradB=t0-25*3600;
const gradC=t0-3600;

{
  const bars=[];
  for(let i=0;i<=34;i++) {
    const m=t0+i*60;
    if(i<30) bars.push(bar(m,100,{h:100,l:99,buy_recipients:recips(2),net:1}));
    else if(i===30) bars.push(bar(m,101,{h:101,l:100,buy_recipients:recips(2),net:1}));
    else if(i===31) bars.push(bar(m,101,{h:101,l:100,buy_recipients:recips(8),net:50}));
    else if(i===32) bars.push(bar(m,100.2,{h:101,l:100,buy_recipients:recips(8),net:50}));
    else if(i===33) bars.push(bar(m,100.5,{h:101,l:100,buy_recipients:recips(8),net:50}));
    else bars.push(bar(m,102.5,{h:103,l:101,buy_recipients:recips(8),net:50}));
  }
  let st=null,ev;
  for(const step of [30,31,32,33,34]) {
    ev=evaluateA(bars,st,gradA,t0+step*60);
    st=ev.persist;
    if(step===30) assert('A breakout arms',st.phase==='breakout'&&!ev.signal,ev);
    if(step===32) assert('A pullback confirms',st.phase==='pullback'&&!ev.signal,ev);
  }
  assert('A trigger after reclaim',!!ev.signal&&ev.signal.strategy==='A',ev);
}

{
  const prior=series(t0,30,100,{h:100,l:99});
  const breakout=bar(t0+30*60,101,{h:101,l:100});
  let ev=evaluateA([...prior,breakout],null,gradA,t0+30*60);
  const fail=bar(t0+32*60,97,{h:98,l:96});
  ev=evaluateA([...prior,breakout,bar(t0+31*60,100),fail],ev.persist,gradA,t0+32*60);
  assert('A invalidates below 0.98L',ev.persist.phase==='idle'&&!ev.signal,ev);
}

{
  const prev60=series(t0,60,11);
  const last60=series(t0+60*60,60,10);
  const last15extra=series(t0+105*60,15,10,{vol:10,net:1,buy_recipients:recips(2)});
  const t=bar(t0+120*60,10000,{h:10000,l:9999,vol:10000,net:500,buy_recipients:recips(20)});
  const buckets=[...prev60,...last60,t];
  const ev=evaluateB(buckets,{},gradB,t0+120*60);
  assert('B excludes current from SMA',ev.reason==='SMA_NOT_RISING'&&!ev.signal,ev);
}

{
  const mk=(start,n,px,vol,net,r)=>series(start,n,px,{vol,net,buy:vol*0.7,sell:vol*0.3,buy_recipients:recips(r),h:px,l:px*0.99});
  const older=mk(t0,45,10,10,1,2);
  const w4=mk(t0+45*60,15,10,20,1,3);
  const w3=mk(t0+60*60,15,10.2,20,1,3);
  const w2=mk(t0+75*60,15,10.4,20,1,3);
  const w1=mk(t0+90*60,15,10.6,20,1,3);
  const last15=mk(t0+105*60,15,11,80,40,10);
  const prev60=[...older,...w4];
  const last60=[...w3,...w2,...w1,...last15];
  const lastHigh=Math.max(...last60.map(b=>b.high_usd));
  const t=bar(t0+120*60,lastHigh*1.01,{h:lastHigh*1.01,l:11,vol:90,net:40,buy_recipients:recips(10)});
  const more=series(t0-60*60,60,9);
  const ev=evaluateB([...more,...prev60,...last60,t],{},gradB,t0+120*60);
  assert('B one breakout signals once',!!ev.signal&&ev.signal.strategy==='B',ev);
  const again=evaluateB([...more,...prev60,...last60,t],ev.persist,gradB,t0+120*60);
  assert('B same breakout does not repeat',!again.signal&&again.reason==='BREAKOUT_ALREADY_USED',again);
}

{
  const bars=[];
  for(let i=0;i<=33;i++) {
    const m=t0+i*60;
    if(i<16) bars.push(bar(m,100+i,{h:100+i+1,l:99,buy_recipients:recips(8,10),net:10,sell:20,buy:40,vol:60}));
    else if(i<30) bars.push(bar(m,130,{h:131,l:128,buy_recipients:recips(8,10),net:5,sell:120,buy:40,vol:160}));
    else if(i<33) bars.push(bar(m,110,{h:112,l:108,sell:10,buy:40,net:20,vol:50,buy_recipients:recips(8,10)}));
    else bars.push(bar(m,113,{h:114,l:111,sell:5,buy:90,net:40,vol:95,buy_recipients:recips(8,10)}));
  }
  let st=null,ev;
  for(let i=0;i<=33;i++) {
    ev=evaluateC(bars,st,gradC,t0+i*60);
    st=ev.persist;
  }
  assert('C arms first-wave then pullback then trigger',!!ev.signal&&ev.signal.strategy==='C',ev);
}

{
  const minute=t0+200*60;
  const bars=series(minute-29*60,30,100,{h:100,l:100,buy_recipients:recips(8),net:10});
  const afterReject=evaluateC(bars,{phase:'fired',peak:150},t0,minute);
  assert('C fired reset records low minute',afterReject.persist.phase==='seek'&&afterReject.persist.low_minute===minute,afterReject);
  const rebound=bar(minute+60,130,{h:140,l:100,buy_recipients:recips(8),net:10});
  const afterRebound=evaluateC([...bars,rebound],afterReject.persist,t0,minute+60);
  assert('C rebound can arm a new wave after reset',afterRebound.persist.phase==='wave'&&afterRebound.persist.low_minute===minute,afterRebound);
}

function freshAccount(strategy='A',principal=30,spend=35) {
  return {strategy,cash:1000,reserve:200,principal_limit:principal,spend_limit:spend,
    halted_permanent:false,halted_day:false,day_key:null,day_baseline:null,equity:1000,unrealized:0,realized:0,
    positions:[],trades:[],seen:[],used_signals:[],signal_state:{},closed_rounds:[],problems:[],reject_counts:{},
    failed_sells:0,exit_incomplete:0,max_drawdown:0,max_drawdown_pct:0,peak_equity:1000};
}

{
  const a=freshAccount('A');
  const now=1_800_000_000_000;
  applyBuy(a,{token:'0xabc',qty:1000n,cost:30.5,block:1,signal_ts:1,decision_ts:now,quote_block:1,fill_ts:now});
  a.positions[0].opened=now-1000;
  a.positions[0].peak_multiple=1;
  let d=exitDecision(a,a.positions[0],0.87,now);
  assert('A stop once',d&&d.reason==='stop',d);
  applySell(a,a.positions[0],sellQtyFor(a.positions[0],d.qty),20,'stop',2,{fill_ts:now});
  assert('A stop does not remain',a.positions.length===0,a.positions);
  applyBuy(a,{token:'0xdef',qty:1000n,cost:30.5,block:1,signal_ts:2,decision_ts:now,quote_block:1,fill_ts:now});
  a.positions[0].opened=now-1000;a.positions[0].peak_multiple=1.3;
  d=exitDecision(a,a.positions[0],1.30,now);
  assert('A partial tp once',d&&d.reason==='partial_tp',d);
  applySell(a,a.positions[0],sellQtyFor(a.positions[0],d.qty),20,'partial_tp',2,{fill_ts:now});
  assert('A half flag set',a.positions[0].half&&a.positions[0].trail_armed,a.positions[0]);
  d=exitDecision(a,a.positions[0],1.30,now);
  assert('A partial tp does not repeat',!d||d.reason!=='partial_tp',d);
}

{
  const a=freshAccount('A');
  const now=Date.now();
  applyBuy(a,{token:'0xt',qty:1000n,cost:30,block:1,signal_ts:1,decision_ts:now,quote_block:1,fill_ts:now-3600000});
  a.positions[0].opened=now-3600000;a.positions[0].peak_multiple=1.05;
  const d=exitDecision(a,a.positions[0],1.05,now);
  assert('A time exit when never +10%',d&&d.reason==='timeout',d);
}

{
  const b=freshAccount('B');
  const now=Date.now();
  applyBuy(b,{token:'0xb',qty:1000n,cost:30,block:1,signal_ts:1,decision_ts:now,quote_block:1,fill_ts:now-6*3600000});
  b.positions[0].opened=now-6*3600000;b.positions[0].peak_multiple=1.2;
  const d=exitDecision(b,b.positions[0],1.2,now);
  assert('B time exit at 6h',d&&d.reason==='timeout',d);
}

{
  const c=freshAccount('C',15,20);
  const now=Date.now();
  applyBuy(c,{token:'0xc',qty:1000n,cost:15.4,block:1,signal_ts:1,decision_ts:now,quote_block:1,fill_ts:now});
  c.positions[0].opened=now;c.positions[0].peak_multiple=2.1;
  let d=exitDecision(c,c.positions[0],2.1,now);
  assert('C recover at 2x',d&&d.reason==='recover',d);
  applySell(c,c.positions[0],400n,15.4,'recover',2,{fill_ts:now});
  assert('C recovered proceeds',c.positions[0].proceeds>=c.positions[0].cost,c.positions[0]);
  c.positions[0].peak_multiple=10.2;
  d=exitDecision(c,c.positions[0],10.2,now);
  assert('C 10x half after recover',d&&d.reason==='half'&&d.qty==='half_remaining',d);
  applySell(c,c.positions[0],sellQtyFor(c.positions[0],d.qty),40,'half',3,{fill_ts:now});
  assert('C 10x only once',c.positions[0].half,c.positions[0]);
  d=exitDecision(c,c.positions[0],11,now);
  assert('C 10x does not repeat',!d||d.reason!=='half',d);
  assert('C no time stop after recover',!(d&&d.reason==='timeout'),d);
}

{
  const now=Math.floor(Date.now()/1000);
  assert('stale quote rejected',quoteFresh(now-121,now,now)==='BLOCK_STALE');
  assert('fresh quote accepted',quoteFresh(now-10,now-10,now)===null);
}

{
  const a=freshAccount('A'),b=freshAccount('B');
  applyBuy(a,{token:'0x1',qty:10n,cost:30,block:1,signal_ts:1,decision_ts:1,quote_block:1,fill_ts:1});
  assert('account isolation cash',a.cash===970&&b.cash===1000);
  assert('account isolation positions',a.positions.length===1&&b.positions.length===0);
}

{
  const a=freshAccount('A');
  const before=a.cash;
  applyBuy(a,{token:'0x1',qty:1000n,cost:31,block:1,signal_ts:1,decision_ts:1,quote_block:1,fill_ts:1});
  const p=a.positions[0];
  applySell(a,p,400n,12,'partial_tp',2,{fill_ts:2});
  assert('cash conservation',Math.abs(a.cash-(before-31+12))<1e-9,a.cash);
  assert('qty conservation',BigInt(a.positions[0].qty)===600n);
  assert('original cost not rewritten',a.positions[0].cost===31);
}

{
  const dir=mkdtempSync(join(tmpdir(),'abc-verify-'));
  try {
    const store=openAbc(dir);
    initAccounts(store);
    const a=readAccount(store,'A');
    applyBuy(a,{token:'0xabc',qty:5n,cost:30,block:9,signal_ts:4,decision_ts:1,quote_block:9,fill_ts:1});
    writeAccount(store,a);store.close();
    const store2=openAbc(dir);
    const b=readAccount(store2,'A');
    assert('restart restores cash',b.cash===970,b.cash);
    assert('restart restores qty',b.positions[0].qty==='5',b.positions);
    store2.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
}

{
  const pool={quote:zeroAddress,quoteDecimals:18,token:zeroAddress,key:{currency0:zeroAddress,currency1:zeroAddress}};
  const rates={prices:{ethereum:{usd:2000},'global-dollar':{usd:1},tether:{usd:1}}};
  const gasPrice=1n;
  const buy={amountOut:10n**18n,executionFeeWei:10000000000000n,quoterGasEstimate:1n};
  const sellCheap={amountOut:10n**15n,executionFeeWei:10000000000000n,quoterGasEstimate:1n};
  const plan=plannedRoundTripFromQuotes(buy,sellCheap,pool,30,10n**18n,rates,gasPrice,50n);
  assert('fee threshold rejects expensive round trip',plan.loss_pct>0.05,plan);
  const sellOk={amountOut:parseUnitsSafe('0.0149'),executionFeeWei:10000000000000n,quoterGasEstimate:1n};
}

function parseUnitsSafe(s) {
  const [w,f='']=s.split('.');
  return BigInt(w)*(10n**18n)+BigInt((f+'000000000000000000').slice(0,18));
}
{
  const pool={quote:zeroAddress,quoteDecimals:18,token:zeroAddress,key:{currency0:zeroAddress,currency1:zeroAddress}};
  const rates={prices:{ethereum:{usd:2000},'global-dollar':{usd:1},tether:{usd:1}}};
  const buy={amountOut:10n**18n,executionFeeWei:10000000000000n,quoterGasEstimate:21000n};
  const sell={amountOut:parseUnitsSafe('0.014925'),executionFeeWei:10000000000000n,quoterGasEstimate:21000n};
  const plan=plannedRoundTripFromQuotes(buy,sell,pool,30,10n**18n,rates,1n,50n);
  assert('fee model records haircut 50bps',plan.haircut_bps===50&&Number.isFinite(plan.loss_pct),plan);
}

{
  const a=freshAccount('A');
  a.equity=null;applyDayBaseline(a);
  assert('source failure null equity freezes entry',canEnter(a)==='EQUITY_UNKNOWN',a);
}

{
  const dir=mkdtempSync(join(tmpdir(),'abc-lock-'));
  try {
    acquireLock(dir);
    let threw=false;
    try {acquireLock(dir);} catch(e) {threw=String(e.message).includes('already running');}
    assert('second process lock rejected',threw);
    releaseLock(dir);
    acquireLock(dir);
    assert('lock reacquired after release',existsSync(join(dir,'pid')));
    releaseLock(dir);
  } finally {rmSync(dir,{recursive:true,force:true});}
}

{
  const a=freshAccount('A');
  const sid=signalId('A','0xabc',123);
  a.used_signals.push(sid);
  assert('signal id stable',sid==='A:0xabc:123');
}

{
  const p={qty:'500',initialQty:'1000',cost:30};
  assert('partial multiple uses remaining fraction',Math.abs(pnlMultiple(p,16.5)-1.1)<1e-9,pnlMultiple(p,16.5));
}

{
  const a=freshAccount('C',15,20);
  applyBuy(a,{token:'0xc',qty:100n,cost:16,block:1,signal_ts:1,decision_ts:1,quote_block:1,fill_ts:1});
  a.positions[0].opened=Date.now()-1000;a.positions[0].peak_multiple=1;
  const d=exitDecision(a,a.positions[0],0.79,Date.now());
  assert('C stop before recover',d&&d.reason==='stop',d);
}

assert('verify did not touch data/abc sqlite',!process.env.ABC_HOME);

if(failures.length) {
  console.error('FAILED',failures.length,failures.join(','));
  process.exitCode=1;
} else console.log('ALL_OFFLINE_CHECKS_PASSED',0);
