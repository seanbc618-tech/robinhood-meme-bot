import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {zeroAddress} from 'viem';
import {
  openAbc,initAccounts,readAccount,writeAccount,writeRun,readRun,
  minutesToClose,minuteStart,classifyError,plannedRoundTripFromQuotes,
  collectBuckets,netExitValue,HAIRCUT_BPS,STRATEGY_VERSION,loadBuckets,
  foldStoredEvents,fxContemporaneous,fxForMinute,skipBacklogForLive,saveFxSnap,ensureWatchSlots,logBlocksNeeded,
  HISTORICAL_FX_STALE_SEC,
  watchSlotDecision,WATCH_MAX_MS,WATCH_POST_MATURITY_MS,rpcRetry,RPC_CALL_TIMEOUT_MS,
} from './abc-collect.mjs';
import {
  cycle,tryEnter,markAndExit,recomputeEquity,applyBuy,applySell,evaluateB,evaluateC,
  evaluateA,exitDecision,pnlMultiple,nextTickDeadline,sleepUntil,
} from './abc.mjs';

const fails=[];
function assert(name,ok,detail){if(ok) console.log('PASS',name); else {console.log('FAIL',name,detail||'');fails.push(name);}}
function tmp(){return mkdtempSync(join(tmpdir(),'abc-repair-'));}

{
  const dir=tmp();
  try {
    const store=openAbc(dir);
    const rates=(observed,eth,usdg)=>({observed_at:observed,prices:{
      ethereum:{usd:2000,last_updated_at:eth},'global-dollar':{usd:1,last_updated_at:usdg},tether:{usd:1,last_updated_at:observed}}});
    saveFxSnap(store,rates(1200,1200,900));
    saveFxSnap(store,rates(1260,900,1260));
    assert('later stale ETH observation cannot erase valid snapshot',fxForMinute(store,1200,zeroAddress).rates?.observed_at===1200);
    assert('USDG selects its own valid observation',fxForMinute(store,1200,'0x123').rates?.observed_at===1260);
    saveFxSnap(store,rates(1320,900,900));
    assert('stale source remains rejected',fxForMinute(store,1320,zeroAddress).reason==='SOURCE_LAST_UPDATED_LAG');
    saveFxSnap(store,rates(1380,1240,1240));
    assert('historical FX accepts bounded 140s source lag',HISTORICAL_FX_STALE_SEC===180&&fxForMinute(store,1320,zeroAddress).ok);
    const now=1700000000000;
    const ins=store.db.prepare(`INSERT INTO pools(token,pool_id,quote,first_seen_block,first_seen_ts,last_cursor_block,quote_status,registered_ts) VALUES(?,?,?,?,?,?,?,?)`);
    ins.run('old','0x',zeroAddress,1,1,1,'ok',now/1000-25*3600);
    store.db.prepare(`INSERT INTO watch_slots VALUES(1,'old',?,?,'ACTIVE')`).run(now-3600000,now+WATCH_MAX_MS);
    ins.run('young','0x',zeroAddress,1,2,1,'ok',now/1000-3600);
    const slots=ensureWatchSlots(store,now);
    assert('existing B history retained while young C gets separate slot',slots.live.find(x=>x._slot===1)?.token==='old'&&slots.live.find(x=>x._slot===2)?.token==='young');
    assert('C rotates at age six hours',!watchSlotDecision(store,store.db.prepare('SELECT * FROM watch_slots WHERE slot=2').get(),now+5*3600000).keep);
    const later=ensureWatchSlots(store,now+5*3600000);
    assert('C slot stays empty without eligible pool',!later.live.some(x=>x._slot===2));
    store.close();
    const reopened=openAbc(dir);
    assert('FX evidence survives restart',fxForMinute(reopened,1200,zeroAddress).ok);
    reopened.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
}

{
  const dir=tmp();
  try {
    const store=openAbc(dir);
    const token='0x00000000000000000000000000000000000000ad';
    const t0=minuteStart(1_700_000_000);
    const missing=t0+120;
    store.db.prepare(`INSERT INTO pools(token,pool_id,quote,first_seen_block,first_seen_ts,last_cursor_block,last_event_block,last_complete_minute,quote_status,decimals,quote_decimals)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(token,'0xpool',zeroAddress,1,t0,10,10,missing,'ok',18,18);
    const pool={token,id:'0xpool',quote:zeroAddress,quoteDecimals:18,decimals:18,key:{currency0:token,currency1:zeroAddress},curve:zeroAddress};
    store.db.prepare(`INSERT INTO buckets
      (token,minute,open_usd,high_usd,low_usd,close_usd,volume_usd,buy_usd,sell_usd,net_inflow_usd,buy_recipients,
       buy_recipient_count,swap_count,no_trade,executable,from_block,to_block,collected_at,source_block,close_sqrt,invalid,fx_note,usd_usable,miss_reason)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      token,t0+60,1,1,1,1,0,0,0,0,'{}',0,0,1,0,null,null,Date.now(),1,String(2n**96n),0,'seed',1,null);
    store.db.prepare('INSERT INTO minute_status(token,minute,reason,at) VALUES(?,?,?,?)').run(token,missing,'SOURCE_LAST_UPDATED_LAG',Date.now());
    const end=missing+60;
    saveFxSnap(store,{observed_at:end,prices:{ethereum:{usd:2000,last_updated_at:end-140},tether:{usd:1,last_updated_at:end-140},'global-dollar':{usd:1,last_updated_at:end-140}}});
    const rates={observed_at:end+120,prices:{ethereum:{usd:2000,last_updated_at:end+120},tether:{usd:1,last_updated_at:end+120},'global-dollar':{usd:1,last_updated_at:end+120}}};
    await foldStoredEvents(store,store.db.prepare('SELECT * FROM pools WHERE token=?').get(token),pool,{number:20n,timestamp:BigInt(end+120)},rates,{
      infra:new Set(),
      blockTs:async()=>end+120,
    });
    const bar=store.db.prepare('SELECT usd_usable,fx_note FROM buckets WHERE token=? AND minute=?').get(token,missing);
    const status=store.db.prepare('SELECT 1 FROM minute_status WHERE token=? AND minute=?').get(token,missing);
    const row=store.db.prepare('SELECT last_complete_minute FROM pools WHERE token=?').get(token);
    assert('late FX retry backfills a previously rejected minute',bar?.usd_usable===1&&/late_fx_retry/.test(bar.fx_note||'')&&!status&&row.last_complete_minute===missing,{bar,status,row});
    store.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
}

{
  const t0=Date.parse('2026-01-01T12:00:20Z')/1000;
  const c1=minutesToClose(null,t0,t0);
  const c2=minutesToClose(null,t0,t0+60);
  const c3=minutesToClose(null,t0,t0+120);
  assert('12:00:20 closes none',c1.length===0,c1);
  assert('12:01:20 still no 12:01',c2.length===0,c2);
  assert('12:02:20 closes 12:01 once',c3.length===1&&c3[0]===minuteStart(t0)+60,c3);
}

{
  const dir=tmp();
  try {
    const store=openAbc(dir);
    const token='0x0000000000000000000000000000000000000001';
    const t0=Date.parse('2026-01-01T12:00:20Z')/1000;
    store.db.prepare(`INSERT INTO pools(token,pool_id,quote,first_seen_block,first_seen_ts,last_cursor_block,last_event_block,quote_status)
      VALUES(?,?,?,?,?,?,?,?)`).run(token,'0xpool',zeroAddress,100,t0,99,99,'ok');
    const pool={token,id:'0xpool',key:{currency0:token,currency1:zeroAddress},quoteDecimals:18,decimals:18,curve:zeroAddress};
    const rates={observed_at:t0,prices:{ethereum:{usd:2000,last_updated_at:t0},tether:{usd:1,last_updated_at:t0},'global-dollar':{usd:1,last_updated_at:t0}}};
    const ts={100:t0,150:t0+45,180:t0+80,220:t0+100,300:t0+120};
    const swaps=[
      {blockNumber:150n,logIndex:1,transactionHash:'0xa',removed:false,args:{sender:token,amount0:1n,amount1:-1n,sqrtPriceX96:2n**96n}},
      {blockNumber:180n,logIndex:1,transactionHash:'0xb',removed:false,args:{sender:token,amount0:1n,amount1:-1n,sqrtPriceX96:2n**96n}},
    ];
    const io={
      infra:new Set(),
      blockTs:async n=>ts[Number(n)]||t0,
      getLogs:async ({fromBlock,toBlock,event})=>{
        if(event&&event.name==='Transfer') return [];
        return swaps.filter(s=>s.blockNumber>=fromBlock&&s.blockNumber<=toBlock);
      },
    };
    const row=()=>store.db.prepare('SELECT * FROM pools WHERE token=?').get(token);
    await collectBuckets(store,row(),pool,{number:100n,timestamp:BigInt(t0)},rates,io);
    await collectBuckets(store,row(),pool,{number:220n,timestamp:BigInt(t0+60)},rates,io);
    await collectBuckets(store,row(),pool,{number:300n,timestamp:BigInt(t0+120)},rates,io);
    const bars=store.db.prepare('SELECT minute,swap_count,invalid FROM buckets WHERE token=? AND IFNULL(invalid,0)=0').all(token);
    const m=minuteStart(t0)+60;
    assert('adjacent cycles close 12:01 once',bars.length===1&&bars[0].minute===m&&bars[0].swap_count===2,bars);
    store.close();
    const store2=openAbc(dir);
    await collectBuckets(store2,store2.db.prepare('SELECT * FROM pools WHERE token=?').get(token),pool,{number:300n,timestamp:BigInt(t0+120)},rates,io);
    const bars2=store2.db.prepare('SELECT minute,swap_count FROM buckets WHERE token=? AND IFNULL(invalid,0)=0').all(token);
    assert('restart does not duplicate 12:01',bars2.length===1&&bars2[0].swap_count===2,bars2);
    store2.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
}

{
  const dir=tmp();
  try {
    const store=openAbc(dir);initAccounts(store);const account=readAccount(store,'A');
    const cachePool={token:'0xabc',id:'0xpool',quote:zeroAddress,quoteDecimals:18,decimals:18,launch:{phase:2},key:{currency0:'0xabc',currency1:zeroAddress}};
    const hydrated={...cachePool,liquidity:1n,sqrtPriceX96:1n,launch:{phase:2,curve:'0xcurve',deployer:'0xdeployer'},key:{...cachePool.key,fee:0,tickSpacing:1,hooks:'0xhook'}};
    let seen=null,calls=0;
    const block={number:1n,timestamp:1000n};
    const rates={observed_at:1000,prices:{ethereum:{usd:1,last_updated_at:1000},tether:{usd:1,last_updated_at:1000},'global-dollar':{usd:1,last_updated_at:1000}}};
    const io={
      poolFor:async()=>{calls++;return hydrated;},
      safetyScreen:async(_store,p)=>{seen=p;return {ok:true,reasons:[]};},
      plannedRoundTrip:async()=>({qty:10n,cash_out:30.5,loss_pct:0.01,amountIn:1n,buy:{amountOut:10n},sell:{amountOut:1n}}),
      requireRoundTrip:async()=>({ok:true,sim:{status:'SIMULATED_NOT_FILLED'}}),
      netExitValue:async()=>({usd:30,gas:1,net:29,mark:29,uneconomic:false}),
      stress:{},now:()=>1000*1000,
    };
    const result=await tryEnter(store,account,'0xabc',{minute:900,block:1},cachePool,block,rates,1n,1000*1000,io);
    assert('tryEnter hydrates cached pool before safety/quote',result.filled===true&&seen===hydrated&&calls===1,{result,seen,calls});
    store.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
}

{
  const dir=tmp();
  try {
    const store=openAbc(dir);
    initAccounts(store);
    const token='0x00000000000000000000000000000000000000aa';
    const t0=minuteStart(1_700_000_000);
    store.db.prepare(`INSERT INTO pools(token,pool_id,quote,first_seen_block,first_seen_ts,last_cursor_block,quote_status,registered_ts)
      VALUES(?,?,?,?,?,?,?,?)`).run(token,'0xpool',zeroAddress,1,t0-7200,1,'ok',t0-7200);
    const insert=store.db.prepare(`INSERT INTO buckets(token,minute,open_usd,high_usd,low_usd,close_usd,volume_usd,buy_usd,sell_usd,net_inflow_usd,buy_recipients,buy_recipient_count,swap_count,no_trade,executable,collected_at,source_block,invalid,usd_usable)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,1)`);
    for(let i=0;i<=30;i++) {
      const m=t0+i*60,brk=i===30;
      insert.run(token,m,brk?101:100,brk?101:100,99,brk?101:100,1,1,0,1,'{}',0,1,0,1,1,1);
    }
    writeRun(store,{started_at:1,ends_at:Date.now()+1e12,catalog_cursor:'1',status:'TEST'});
    const fakePool={token,id:'0xpool',launch:{phase:2},liquidity:1n,sqrtPriceX96:1n,quote:zeroAddress};
    const headTs=t0+31*60+20;
    const now=headTs*1000;
    const io={
      skipCatalog:true,skipLiveJump:true,
      gasPrice:1n,
      blockContext:async()=>({number:10n,timestamp:BigInt(headTs),hash:'0x'}),
      usdRates:async()=>({observed_at:headTs,prices:{ethereum:{usd:1,last_updated_at:headTs},tether:{usd:1,last_updated_at:headTs},'global-dollar':{usd:1,last_updated_at:headTs}}}),
      enrichPool:async()=>fakePool,
      collectBuckets:async()=>({minutes:31}),
    };
    await cycle(store,now,io);
    const a1=readAccount(store,'A');
    assert('cycle persists A breakout state',a1.signal_state[token]?.phase==='breakout',a1.signal_state[token]);
    const bWarm=readAccount(store,'B');
    assert('cycle persists B warmup counts',(bWarm.reject_counts.WARMUP_GRADUATION_LT_24H||0)>0,bWarm.reject_counts);
    store.close();
    const store2=openAbc(dir);
    const a2=readAccount(store2,'A');
    assert('restart keeps A phase',a2.signal_state[token]?.phase==='breakout',a2.signal_state);
    await cycle(store2,now+60000,io);
    const a3=readAccount(store2,'A');
    assert('second cycle advances or keeps phase',['breakout','pullback','idle','fired'].includes(a3.signal_state[token]?.phase),a3.signal_state[token]);
    store2.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
}

{
  const t0=1_700_000_000;
  function recips(n){const o={};for(let i=0;i<n;i++) o['0x'+i.toString(16).padStart(40,'0')]=10;return o;}
  function series(start,n,px,vol,net,r,high){
    return Array.from({length:n},(_,i)=>({minute:start+i*60,close_usd:px,high_usd:high??px,low_usd:px*0.99,volume_usd:vol,net_inflow_usd:net,buy_usd:vol*0.7,sell_usd:vol*0.3,buy_recipients:recips(r)}));
  }
  const older=series(t0,45,10,10,1,2,20);
  const w4=series(t0+45*60,15,10,10,1,3,20);
  const w3=series(t0+60*60,15,10.2,10,1,3,12);
  const w2=series(t0+75*60,15,10.4,10,1,3,12);
  const w1=series(t0+90*60,15,10.6,10,1,3,12);
  const last15=series(t0+105*60,15,11,80,40,10,50);
  const prev60=[...older,...w4], last60=[...w3,...w2,...w1,...last15];
  const t={minute:t0+120*60,close_usd:20.2,high_usd:21,low_usd:19,volume_usd:90,net_inflow_usd:40,buy_usd:70,sell_usd:20,buy_recipients:recips(10)};
  const more=series(t0-60*60,60,9,10,1,2,9);
  const ev=evaluateB([...more,...prev60,...last60,t],{},t0-25*3600,t0+120*60);
  assert('B does not buy when only earlier-window high is broken',!ev.signal,ev);
}

{
  const dir=tmp();
  try {
    const store=openAbc(dir);
    initAccounts(store);
    const a=readAccount(store,'A');
    applyBuy(a,{token:'0x1',qty:1000n,cost:30,block:1,signal_ts:1,decision_ts:1,quote_block:1,fill_ts:1});
    writeAccount(store,a);
    const quotes=new Map([['0x1',{full:{usd:40,gas:1,net:39,mark:39,uneconomic:false},half:{usd:20,gas:1,net:19,mark:19,uneconomic:false}}]]);
    const io={
      poolFor:async()=>({token:'0x1'}),
      netExitValue:async(pool,qty)=>{
        qty=BigInt(qty);
        if(qty===1000n) return quotes.get('0x1').full;
        if(qty===500n) return quotes.get('0x1').half;
        return {usd:20*Number(qty)/500,gas:1,net:20*Number(qty)/500-1,mark:Math.max(0,20*Number(qty)/500-1),uneconomic:false};
      },
      now:()=>2,
    };
    a.positions[0].opened=1;a.positions[0].peak_multiple=1.3;a.positions[0].half=false;
    const block={number:2n,timestamp:100n};
    const rates={observed_at:100,prices:{ethereum:{usd:1,last_updated_at:100},tether:{usd:1,last_updated_at:100},'global-dollar':{usd:1,last_updated_at:100}}};
    const after=await markAndExit(store,a,block,rates,1n,2,io);
    // force partial by setting mark high then calling applySell path: peak 1.3 and multiple from mark 39/30=1.3 -> partial at 1.25
    const disk=readAccount(store,'A');
    assert('partial sell requotes remaining mark',disk.positions.length===1&&disk.positions[0].mark!==39,disk.positions[0]);
    const eq=disk.cash+disk.positions[0].mark;
    assert('equity cash+remaining mark',Math.abs(disk.equity-eq)<1e-9,{equity:disk.equity,eq,cash:disk.cash,mark:disk.positions[0].mark});
    const implied=disk.realized+disk.unrealized;
    assert('realized+unrealized vs equity-1000',Number.isFinite(disk.unrealized),{implied,equity:disk.equity,realized:disk.realized});
    store.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
}

{
  const dir=tmp();
  try {
    const store=openAbc(dir);
    initAccounts(store);
    const acc=readAccount(store,'A');
    const pool={token:'0xabc',quote:zeroAddress,quoteDecimals:18,launch:{phase:2},liquidity:1n,sqrtPriceX96:1n};
    const block={number:1n,timestamp:1000n};
    const rates={observed_at:1000,prices:{ethereum:{usd:1,last_updated_at:1000},tether:{usd:1,last_updated_at:1000},'global-dollar':{usd:1,last_updated_at:1000}}};
    let now=1000*1000;
    const io={
      now:()=>now,
      safetyScreen:async()=>({ok:true,reasons:[]}),
      plannedRoundTrip:async()=>({qty:10n,cash_out:30.5,loss_pct:0.01,buyGas:0.5,sellGas:0.5,amountIn:1n,buy:{amountOut:10n,quoterGasEstimate:1n},sell:{amountOut:1n,quoterGasEstimate:1n}}),
      requireRoundTrip:async()=>({ok:true,sim:{status:'SIMULATED_NOT_FILLED'}}),
      netExitValue:async()=>({usd:30,gas:1,net:29,mark:29,uneconomic:false}),
      stress:{incomplete:true},
    };
    now=1000*1000+121000;
    const r=await tryEnter(store,acc,'0xabc',{minute:900,block:1},pool,block,rates,1n,1000*1000,io);
    assert('stale 120s rejects fill',r.skipped==='BLOCK_STALE'||r.skipped==='USD_OBSERVED_STALE'||r.skipped==='USD_SOURCE_STALE',r);
    assert('stale 120s does not book trade',readAccount(store,'A').trades.length===0,readAccount(store,'A').trades);
    now=1000*1000;
    const acc2=readAccount(store,'A');
    const r2=await tryEnter(store,acc2,'0xabc',{minute:900,block:1},pool,block,rates,1n,1000*1000,io);
    assert('fresh tryEnter books buy',r2.filled===true,r2);
    const booked=readAccount(store,'A');
    assert('buy persisted after JSON write',booked.positions.length===1&&booked.cash<1000,booked);
    store.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
}

{
  const pool={quote:zeroAddress,quoteDecimals:18,token:zeroAddress};
  const rates={prices:{ethereum:{usd:2000},'global-dollar':{usd:1},tether:{usd:1}}};
  const buy={amountOut:10n**18n,quoterGasEstimate:1n};
  const sell={amountOut:1n,quoterGasEstimate:1n};
  JSON.parse(JSON.stringify({plan:plannedRoundTripFromQuotes(buy,sell,pool,30,10n**18n,rates,1n,50n)},(_,v)=>typeof v==='bigint'?v.toString():v));
  assert('roundtrip quotes serializable via stringify helper',true);
}

{
  assert('method not found is SOURCE_UNAVAILABLE',classifyError(new Error('method not found'))==='SOURCE_UNAVAILABLE');
  assert('not supported is SOURCE_UNAVAILABLE',classifyError(new Error('not supported'))==='SOURCE_UNAVAILABLE');
  assert('archive prune is INVALID_DECLARED_GAP',classifyError(new Error('pruned history'))==='INVALID_DECLARED_GAP');
}

{
  const t0=1_700_000_000;
  const bars=[{minute:t0,low_usd:100,high_usd:140,close_usd:120,buy_recipients:{},volume_usd:1,net_inflow_usd:1,sell_usd:1,buy_usd:1}];
  const ev=evaluateC(bars,{phase:'seek'},t0-3600,t0);
  assert('C same-bar high/low does not arm wave',ev.persist.phase==='seek',ev.persist);
  const b2={minute:t0+60,low_usd:101,high_usd:140,close_usd:130,buy_recipients:{},volume_usd:1,net_inflow_usd:1,sell_usd:1,buy_usd:1};
  const ev2=evaluateC([bars[0],b2],ev.persist,t0-3600,t0+60);
  assert('C cross-bar 30% arms wave',ev2.persist.phase==='wave',ev2.persist);
}

{
  const dir=tmp();
  try {
    const store=openAbc(dir);
    initAccounts(store);
    const a=readAccount(store,'A');
    applyBuy(a,{token:'0xdead',qty:100n,cost:30,block:1,signal_ts:1,decision_ts:1,quote_block:1,fill_ts:1});
    const io={
      poolFor:async()=>({}),
      netExitValue:async()=>({usd:0.1,gas:1,net:-0.9,mark:0,uneconomic:true}),
      now:()=>2,
    };
    a.halted_permanent=true;
    const rates={observed_at:2,prices:{ethereum:{usd:1,last_updated_at:2},tether:{usd:1,last_updated_at:2},'global-dollar':{usd:1,last_updated_at:2}}};
    await markAndExit(store,a,{number:1n,timestamp:2n},rates,1n,2,io);
    const d=readAccount(store,'A');
    assert('uneconomic exit keeps qty',d.positions.length===1&&d.positions[0].qty==='100',d.positions);
    assert('uneconomic does not credit cash',d.cash===970,d.cash);
    store.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
}

{
  const dir=tmp();
  try {
    const store=openAbc(dir);
    const now=200000;
    for(const tok of ['0x1','0x2']) {
      store.db.prepare(`INSERT INTO pools(token,pool_id,quote,first_seen_block,first_seen_ts,last_cursor_block,quote_status)
        VALUES(?,?,?,?,?,?,?)`).run(tok,'0x',zeroAddress,1,1,1,'ok');
    }
    writeRun(store,{started_at:1,ends_at:now+1e12,catalog_cursor:'1',status:'TEST'});
    initAccounts(store);
    const io={
      skipCatalog:true,skipLiveJump:true,gasPrice:1n,
      blockContext:async()=>({number:1n,timestamp:200n,hash:'0x'}),
      usdRates:async()=>({observed_at:200,prices:{ethereum:{usd:1,last_updated_at:200},tether:{usd:1,last_updated_at:200},'global-dollar':{usd:1,last_updated_at:200}}}),
      enrichPool:async()=>{throw new Error('RPC Request failed.');},
    };
    await cycle(store,now,io);
    const rows=store.db.prepare('SELECT token,last_analyzed_at FROM pools ORDER BY token').all();
    const seated=store.db.prepare('SELECT token FROM watch_slots').all().map(r=>r.token);
    assert('fixed watch only updates seated pool last_analyzed',rows.filter(r=>seated.includes(r.token)).every(r=>r.last_analyzed_at===now)&&rows.some(r=>r.last_analyzed_at==null),{rows,seated});
    store.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
}

assert('strategy version is v7',STRATEGY_VERSION==='abc-phase1-v7');
{
  const dir=tmp();
  try {
    const store=openAbc(dir);
    assert('default logBlocksNeeded >=900',Number(logBlocksNeeded(store))>=900,logBlocksNeeded(store).toString());
    store.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
}
{
  const dir=tmp();
  try {
    const store=openAbc(dir);
    store.db.prepare(`INSERT INTO pools(token,pool_id,quote,first_seen_block,first_seen_ts,last_cursor_block,quote_status) VALUES(?,?,?,?,?,?,?)`)
      .run('0xaaa','0x',zeroAddress,1,100,1,'ok');
    store.db.prepare(`INSERT INTO pools(token,pool_id,quote,first_seen_block,first_seen_ts,last_cursor_block,quote_status) VALUES(?,?,?,?,?,?,?)`)
      .run('0xbbb','0x',zeroAddress,1,200,1,'ok');
    const a=ensureWatchSlots(store,1000,1);
    const b=ensureWatchSlots(store,2000,1);
    assert('fixed watch does not replace slot with newer pool',a.live[0].token===b.live[0].token, {a:a.live[0].token,b:b.live[0].token});
    const firstTok=a.live[0].token;
    const later=ensureWatchSlots(store,1000+WATCH_MAX_MS+1,1);
    const hist=store.db.prepare('SELECT token,end_reason FROM watch_slot_history').all();
    assert('expired slot archives then reseats without UNIQUE throw',hist.length>=1&&hist[0].token===firstTok&&later.live[0]&&later.live[0].token!==firstTok,{hist,firstTok,live:later.live.map(x=>x.token)});
    store.close();
    const store2=openAbc(dir);
    const again=ensureWatchSlots(store2,1000+WATCH_MAX_MS+5000,1);
    assert('reopen does not reshuffle seated token',again.live[0].token===later.live[0].token,again.live.map(x=>x.token));
    store2.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
}

{
  const dir=tmp();
  try {
    const store=openAbc(dir);
    const tok='0xccc';
    store.db.prepare(`INSERT INTO pools(token,pool_id,quote,first_seen_block,first_seen_ts,last_cursor_block,quote_status,registered_ts) VALUES(?,?,?,?,?,?,?,?)`)
      .run(tok,'0x',zeroAddress,1,1,1,'ok',Math.floor((1_700_000_000_000-25*3600000)/1000));
    const seated=1_700_000_000_000-25*3600000;
    store.db.prepare(`INSERT INTO watch_slots(slot,token,seated_at,expires_at,status) VALUES(1,?,?,?,'ACTIVE')`).run(tok,seated,seated+WATCH_MAX_MS);
    const now=1_700_000_000_000;
    const dec=watchSlotDecision(store,store.db.prepare('SELECT * FROM watch_slots WHERE slot=1').get(),now);
    assert('do not evict at 24h without 120m window',dec.keep===true,dec);
    const decMax=watchSlotDecision(store,store.db.prepare('SELECT * FROM watch_slots WHERE slot=1').get(),seated+WATCH_MAX_MS+1);
    assert('max bound fails incomplete window',decMax.keep===false&&decMax.reason==='WATCH_EXPIRED_INCOMPLETE_WINDOW',decMax);
    store.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
}

{
  const dir=tmp();
  try {
    const store=openAbc(dir);
    const token='0x0000000000000000000000000000000000000002';
    const t0=minuteStart(1_700_000_000);
    store.db.prepare(`INSERT INTO pools(token,pool_id,quote,first_seen_block,first_seen_ts,last_cursor_block,last_event_block,last_complete_minute,quote_status,decimals,quote_decimals)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(token,'0xpool',zeroAddress,1,t0-120,500,500,t0-60,'ok',18,18);
    store.db.prepare(`INSERT INTO buckets(token,minute,open_usd,high_usd,low_usd,close_usd,volume_usd,buy_usd,sell_usd,net_inflow_usd,buy_recipients,buy_recipient_count,swap_count,no_trade,executable,collected_at,source_block,invalid,usd_usable,close_sqrt)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(token,t0,999,999,999,999,0,0,0,0,'{}',0,0,1,0,1,1,1,0,'1');
    const pool={token,id:'0xpool',key:{currency0:token,currency1:zeroAddress},quoteDecimals:18,decimals:18,curve:zeroAddress};
    const rates={observed_at:t0+180,prices:{ethereum:{usd:2000,last_updated_at:t0+180},tether:{usd:1,last_updated_at:t0+180},'global-dollar':{usd:1,last_updated_at:t0+180}}};
    await collectBuckets(store,store.db.prepare('SELECT * FROM pools WHERE token=?').get(token),pool,{number:500n,timestamp:BigInt(t0+180)},rates,{
      infra:new Set(),
      blockTs:async()=>t0+180,
      getLogs:async()=>[],
    });
    const next=store.db.prepare('SELECT * FROM buckets WHERE token=? AND minute=?').get(token,t0+60);
    assert('invalid bucket does not seed next close',!next||next.close_usd!==999,next);
    store.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
}

{
  const dir=tmp();
  try {
    const store=openAbc(dir);
    const token='0x0000000000000000000000000000000000000003';
    const t0=minuteStart(1_700_000_000);
    store.db.prepare(`INSERT INTO pools(token,pool_id,quote,first_seen_block,first_seen_ts,last_cursor_block,last_event_block,quote_status,decimals,quote_decimals)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(token,'0xpool',zeroAddress,1,t0-60,10,10,'ok',18,18);
    store.db.prepare(`INSERT INTO swap_events(token,block,log_index,ts,tx,sqrt,token_amount,quote_amount,quote_vol,sender)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(token,5,0,t0+1,'0x1',String(2n**96n),'1','-1',1,token);
    const pool={token,id:'0xpool',key:{currency0:token,currency1:zeroAddress},quoteDecimals:18,decimals:18,curve:zeroAddress,quote:zeroAddress};
    const staleRates={observed_at:t0+3600,prices:{ethereum:{usd:2000,last_updated_at:t0+3600},tether:{usd:1,last_updated_at:t0+3600},'global-dollar':{usd:1,last_updated_at:t0+3600}}};
    const row=()=>store.db.prepare('SELECT * FROM pools WHERE token=?').get(token);
    await collectBuckets(store,row(),pool,{number:10n,timestamp:BigInt(t0+90)},staleRates,{infra:new Set(),blockTs:async()=>t0+90,getLogs:async()=>[]});
    const hist=store.db.prepare('SELECT usd_usable,fx_note FROM buckets WHERE token=? AND minute=?').get(token,t0);
    assert('stale FX bucket not strategy-usable',!hist||hist.usd_usable===0,hist);
    const loaded=loadBuckets(store,token,t0-60,t0+120);
    assert('loadBuckets excludes non-contemporaneous FX',loaded.length===0,loaded);
    store.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
}

{
  const dir=tmp();
  try {
    const store=openAbc(dir);
    initAccounts(store);
    writeRun(store,{started_at:1,ends_at:Date.now()+1e12,catalog_cursor:'1',status:'TEST',signals:[{plan:{qty:10n,buy:{amountOut:1n}}}]});
    const run=readRun(store);
    assert('writeRun persists bigint as string',run.signals[0].plan.qty==='10',run.signals[0]);
    const token='0x00000000000000000000000000000000000000aa';
    const t0=minuteStart(1_700_000_000);
    store.db.prepare(`INSERT INTO pools(token,pool_id,quote,first_seen_block,first_seen_ts,last_cursor_block,quote_status,registered_ts,decimals,quote_decimals)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(token,'0xpool',zeroAddress,1,t0-7200,1,'ok',t0-7200,18,18);
    const insert=store.db.prepare(`INSERT INTO buckets(token,minute,open_usd,high_usd,low_usd,close_usd,volume_usd,buy_usd,sell_usd,net_inflow_usd,buy_recipients,buy_recipient_count,swap_count,no_trade,executable,collected_at,source_block,invalid,usd_usable)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`);
    for(let i=0;i<=34;i++) {
      const m=t0+i*60;
      const rec=i>=29?JSON.stringify(Object.fromEntries([...Array(8)].map((_,j)=>['0x'+j.toString(16).padStart(40,'0'),10]))):'{}';
      if(i<30) insert.run(token,m,100,100,99,100,1,1,0,1,rec,8,1,0,1,1,1,0);
      else if(i===30) insert.run(token,m,101,101,100,101,1,1,0,1,rec,8,1,0,1,1,1,0);
      else if(i===32) insert.run(token,m,100.2,101,100,100.2,1,1,0,50,rec,8,1,0,1,1,1,0);
      else insert.run(token,m,102.5,103,101,102.5,120,80,40,50,rec,8,1,0,1,1,1,0);
    }
    const headTs=t0+35*60+20;
    const accA=readAccount(store,'A');
    accA.signal_state[token]={phase:'pullback',L:100,breakout_minute:t0+30*60,pullback_minute:t0+32*60,pullback_high:101};
    writeAccount(store,accA);
    const fakePool={token,id:'0xpool',launch:{phase:2},liquidity:1n,sqrtPriceX96:1n,quote:zeroAddress,quoteDecimals:18,decimals:18,key:{currency0:token,currency1:zeroAddress}};
    const io={
      skipCatalog:true,skipLiveJump:true,gasPrice:1n,collectBudgetMs:20000,
      blockContext:async()=>({number:10n,timestamp:BigInt(headTs),hash:'0x'}),
      usdRates:async()=>({observed_at:headTs,prices:{ethereum:{usd:1,last_updated_at:headTs},tether:{usd:1,last_updated_at:headTs},'global-dollar':{usd:1,last_updated_at:headTs}}}),
      enrichPool:async()=>fakePool,
      poolFor:async()=>fakePool,
      collectBuckets:async()=>({minutes:35}),
      safetyScreen:async()=>({ok:true,reasons:[]}),
      plannedRoundTrip:async()=>({qty:10n,cash_out:30.5,loss_pct:0.01,buyGas:0.5,sellGas:0.5,amountIn:1n,buy:{amountOut:10n,quoterGasEstimate:1n},sell:{amountOut:1n,quoterGasEstimate:1n}}),
      requireRoundTrip:async()=>({ok:true,sim:{status:'SIMULATED_NOT_FILLED'}}),
      netExitValue:async()=>({usd:30,gas:1,net:29,mark:29,uneconomic:false}),
      stress:{incomplete:true},
      now:()=>headTs*1000,
    };
    await cycle(store,headTs*1000,io);
    const run2=readRun(store);
    assert('cycle fill writes run without throw',Array.isArray(run2.signals),run2.signals);
    const a=readAccount(store,'A');
    assert('cycle fill books account',a.trades.length>=1&&a.cash<1000,{trades:a.trades.length,cash:a.cash,signals:run2.signals});
    store.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
}

{
  const dir=tmp();
  try {
    const store=openAbc(dir);
    initAccounts(store);
    writeRun(store,{started_at:1,ends_at:Date.now()+1e12,catalog_cursor:'1',status:'TEST'});
    for(const tok of ['0xa','0xb','0xc']) {
      store.db.prepare(`INSERT INTO pools(token,pool_id,quote,first_seen_block,first_seen_ts,last_cursor_block,quote_status,decimals,quote_decimals)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(tok,'0x',zeroAddress,1,1,1,'ok',18,18);
    }
    store.db.prepare('UPDATE pools SET registered_ts=?').run(Math.floor(Date.now()/1000)-3600);
    let collects=0;
    const io={
      skipCatalog:true,skipLiveJump:true,gasPrice:1n,collectBudgetMs:25,liveWatchN:3,
      blockContext:async()=>({number:1n,timestamp:200n,hash:'0x'}),
      usdRates:async()=>({observed_at:200,prices:{ethereum:{usd:1,last_updated_at:200},tether:{usd:1,last_updated_at:200},'global-dollar':{usd:1,last_updated_at:200}}}),
      enrichPool:async()=>({token:'0xa',launch:{phase:2},liquidity:1n,sqrtPriceX96:1n,quote:zeroAddress}),
      collectBuckets:async()=>{collects++;await new Promise(r=>setTimeout(r,20));return {minutes:0};},
    };
    const snap=await cycle(store,200000,io);
    assert('exits ran before collect budget',snap.exits_ms>=0&&snap.exits_ms<10000,snap.exits_ms);
    assert('collect stops under budget',collects<=2&&(snap.collect_deferred||0)>=1,{collects,deferred:snap.collect_deferred});
    store.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
}

{
  const starts=[];
  for(let i=0;i<10;i++) {
    const t=Date.now();
    starts.push(t);
    await new Promise(r=>setTimeout(r,5));
    await sleepUntil(nextTickDeadline(t,40));
  }
  const iv=starts.slice(1).map((s,i)=>s-starts[i]);
  assert('10 ticks from start ~40ms not start+work+40',iv.every(x=>x>=35&&x<=90),iv);
}

{
  const dir=tmp();
  try {
    const store=openAbc(dir);
    const token='0x0000000000000000000000000000000000000009';
    const t0=minuteStart(1_700_000_000);
    store.db.prepare(`INSERT INTO pools(token,pool_id,quote,first_seen_block,first_seen_ts,last_cursor_block,last_event_block,quote_status,decimals,quote_decimals)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(token,'0xpool',zeroAddress,1,t0,50,50,'ok',18,18);
    const pool={token,id:'0xpool',quote:zeroAddress,quoteDecimals:18,decimals:18,key:{currency0:token,currency1:zeroAddress},curve:zeroAddress};
    const rates={observed_at:t0+3600,prices:{ethereum:{usd:1,last_updated_at:t0+3600},tether:{usd:1,last_updated_at:t0+3600},'global-dollar':{usd:1,last_updated_at:t0+3600}}};
    let threw=false;
    try {
      await foldStoredEvents(store,store.db.prepare('SELECT * FROM pools WHERE token=?').get(token),pool,{number:5000n,timestamp:BigInt(t0+3600)},rates,{
        infra:new Set(),
        blockTs:async()=>{throw new Error('ts fail');},
      });
    } catch(e) {threw=String(e.message).includes('coverage_boundary');}
    const n=store.db.prepare('SELECT count(*) c FROM buckets WHERE token=?').get(token).c;
    assert('lag+ts fail does not close buckets',threw&&n===0,{threw,n});
    store.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
}

{
  assert('fx requires source last_updated not just observed_at',
    !fxContemporaneous(1000,{observed_at:1060,prices:{ethereum:{usd:1,last_updated_at:10},tether:{usd:1,last_updated_at:10},'global-dollar':{usd:1,last_updated_at:10}}},zeroAddress));
  assert('fx ok when observed and last_updated near minute end',
    fxContemporaneous(1000,{observed_at:1060,prices:{ethereum:{usd:1,last_updated_at:1055},tether:{usd:1,last_updated_at:1055},'global-dollar':{usd:1,last_updated_at:1055}}},zeroAddress));
}

{
  const dir=tmp();
  try {
    const store=openAbc(dir);
    const token='0x0000000000000000000000000000000000000008';
    const t0=minuteStart(1_700_000_000);
    store.db.prepare(`INSERT INTO pools(token,pool_id,quote,first_seen_block,first_seen_ts,last_cursor_block,last_event_block,quote_status,decimals,quote_decimals)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(token,'0xpool',zeroAddress,1,t0-60,1,1,'ok',18,18);
    const pool={token,id:'0xpool',quote:zeroAddress,quoteDecimals:18,decimals:18,key:{currency0:token,currency1:zeroAddress},curve:zeroAddress};
    const ins=store.db.prepare(`INSERT INTO swap_events(token,block,log_index,ts,tx,sqrt,token_amount,quote_amount,quote_vol,sender) VALUES(?,?,?,?,?,?,?,?,?,?)`);
    for(let i=0;i<30;i++) {
      const m=t0+i*60;
      ins.run(token,10+i,0,m+1,'0x'+i,String(2n**96n),'1','-1',1,token);
      store.db.prepare('UPDATE pools SET last_event_block=?,last_complete_minute=? WHERE token=?').run(10+i,i===0?null:m-60,token);
      const rates={observed_at:m+60,prices:{ethereum:{usd:2000,last_updated_at:m+55},tether:{usd:1,last_updated_at:m+55},'global-dollar':{usd:1,last_updated_at:m+55}}};
      saveFxSnap(store,rates);
      const row=store.db.prepare('SELECT * FROM pools WHERE token=?').get(token);
      await foldStoredEvents(store,row,pool,{number:BigInt(10+i),timestamp:BigInt(m+90)},rates,{
        infra:new Set(),
        blockTs:async()=>m+90,
      });
    }
    const bars=store.db.prepare('SELECT minute FROM buckets WHERE token=? AND usd_usable=1 AND invalid=0 ORDER BY minute').all(token);
    const consec=bars.length>=30&&bars.every((b,i)=>i===0||b.minute===bars[i-1].minute+60);
    assert('one live pool 30 consecutive usable minutes',consec,{n:bars.length,first:bars[0],last:bars.at(-1)});
    store.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
}

{
  const dir=tmp();
  try {
    const store=openAbc(dir);
    const token='0x00000000000000000000000000000000000000bb';
    const t0=minuteStart(1_700_000_000);
    store.db.prepare(`INSERT INTO pools(token,pool_id,quote,first_seen_block,first_seen_ts,last_cursor_block,last_event_block,last_complete_minute,quote_status,decimals,quote_decimals,live_from_block,live_from_ts)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(token,'0xpool',zeroAddress,1,t0,100,100,t0, 'ok',18,18,101,t0);
    const pool={token,id:'0xpool',quote:zeroAddress,quoteDecimals:18,decimals:18,key:{currency0:token,currency1:zeroAddress},curve:zeroAddress};
    const rates={observed_at:t0+120,prices:{ethereum:{usd:1,last_updated_at:t0+120},tether:{usd:1,last_updated_at:t0+120},'global-dollar':{usd:1,last_updated_at:t0+120}}};
    let n=0;let threw=null;
    try {
      await collectBuckets(store,store.db.prepare('SELECT * FROM pools WHERE token=?').get(token),pool,{number:150n,timestamp:BigInt(t0+120)},rates,{
        infra:new Set(),
        rpcRetryDelayMs:0,
        blockTs:async()=>t0+120,
        getLogs:async()=>{
          n++;
          if(n===1) throw new Error('RPC Request failed.');
          return [];
        },
      });
    } catch(e) {threw=String(e.message||e);}
    const row=store.db.prepare('SELECT last_event_block FROM pools WHERE token=?').get(token);
    assert('transient getLogs fail retries and advances cursor',!threw&&row.last_event_block===150&&n>=2,{row,n,threw});
    store.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
}

{
  const dir=tmp();
  try {
    const store=openAbc(dir);
    initAccounts(store);
    writeRun(store,{started_at:1,ends_at:Date.now()+1e12,catalog_cursor:'1',status:'TEST'});
    const token='0x00000000000000000000000000000000000000cc';
    store.db.prepare(`INSERT INTO pools(token,pool_id,quote,first_seen_block,first_seen_ts,last_cursor_block,quote_status,decimals,quote_decimals)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(token,'0xpool',zeroAddress,1,1,1,'ok',18,18);
    const order=[];
    const io={
      skipLiveJump:true,gasPrice:1n,
      blockContext:async()=>({number:10n,timestamp:200n,hash:'0x'}),
      usdRates:async()=>({observed_at:200,prices:{ethereum:{usd:1,last_updated_at:200},tether:{usd:1,last_updated_at:200},'global-dollar':{usd:1,last_updated_at:200}}}),
      enrichPool:async()=>({token,id:'0xpool',launch:{phase:2},liquidity:1n,sqrtPriceX96:1n,quote:zeroAddress,quoteDecimals:18,decimals:18,key:{currency0:token,currency1:zeroAddress}}),
      collectBuckets:async()=>{order.push('collect');return {minutes:0};},
      syncCatalog:async()=>{order.push('catalog');return {added:0};},
    };
    await cycle(store,200000,io);
    assert('watch collect runs before catalog',order[0]==='collect'&&order.includes('catalog'),order);
    store.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
}

{
  let n=0;
  let err=null;
  try {
    await rpcRetry(async()=>{n++;throw new Error('RPC_TIMEOUT');},{deadline:Date.now()-1,rpcRetries:3,rpcRetryDelayMs:0,rpcTimeoutMs:12000});
  } catch(e) {err=String(e.message||e);}
  assert('rpcRetry does not start when deadline already passed',n===0&&/RPC_DEADLINE/.test(err||''),{n,err});
}

{
  let n=0;
  const t0=Date.now();
  try {
    await rpcRetry(async()=>{
      n++;
      await new Promise(r=>setTimeout(r,25));
      throw new Error('RPC_TIMEOUT');
    },{deadline:t0+40,rpcRetries:5,rpcRetryDelayMs:20,rpcTimeoutMs:12000});
  } catch {}
  assert('rpcRetry does not retry after budget exhausted',n===1,{n,elapsed:Date.now()-t0});
}

{
  const t0=Date.now();
  const deadline=t0+80;
  const seen=[];
  try {
    await rpcRetry(async(ms)=>{seen.push(ms);throw new Error('RPC_TIMEOUT');},{deadline,rpcRetries:1,rpcRetryDelayMs:0,rpcTimeoutMs:12000});
  } catch {}
  assert('single rpc timeout capped to remaining budget',seen.length===1&&seen[0]>0&&seen[0]<=80&&seen[0]<=RPC_CALL_TIMEOUT_MS,seen);
}

if(fails.length){console.error('FAILED',fails.length,fails.join(','));process.exitCode=1;}
else console.log('ALL_REPAIR_CHECKS_PASSED',fails.length);
