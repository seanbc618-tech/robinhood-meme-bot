// Reproduce ABC v1 failures against current code. Temp dir only. Do not write data/abc.
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {minuteStart,openAbc,initAccounts,readAccount,writeAccount} from './abc-collect.mjs';
import {cycle,evaluateB,applyBuy,applySell,pnlMultiple,exitDecision} from './abc.mjs';

const fails=[];
function check(name,ok,detail){if(ok) console.log('REPRO_OK',name); else {console.log('REPRO_FAIL',name,detail||'');fails.push(name);}}

{
  // P0 cursor: simulate 12:00:20, 12:01:20, 12:02:20 with v1 formula
  const t0=Date.parse('2026-01-01T12:00:20Z')/1000;
  const closed=[];
  let lastCursorTs=t0;
  for(const offset of [0,60,120]) {
    const headTs=t0+offset;
    const startTs=lastCursorTs;
    const rangeStart=minuteStart(Math.max(startTs,startTs))+60;
    const lastComplete=minuteStart(headTs)-60;
    const got=[];
    if(lastComplete>=rangeStart) for(let m=rangeStart;m<=lastComplete;m+=60) got.push(m);
    closed.push({head:new Date(headTs*1000).toISOString(),rangeStart,lastComplete,got});
    lastCursorTs=headTs; // v1 advances cursor to head
  }
  const has1201=closed.some(c=>c.got.includes(minuteStart(t0)+60));
  console.log('v1_cycles',JSON.stringify(closed));
  check('v1 drops 12:01 bucket',!has1201,closed);
}

{
  const dir=mkdtempSync(join(tmpdir(),'abc-repro-'));
  try {
    const store=openAbc(dir);
    initAccounts(store);
    const a=readAccount(store,'A');
    a.signal_state.tok={phase:'breakout',L:100,breakout_minute:1};
    a.reject_counts={WARMUP:3};
    // v1 cycle end pattern: mutate memory then readAccount overwrites
    const mem={...a,signal_state:{tok:{phase:'pullback'}},reject_counts:{WARMUP:4}};
    const disk=readAccount(store,'A');
    check('v1 signal_state not on disk',!disk.signal_state.tok);
    check('v1 memory pullback not committed',mem.signal_state.tok.phase==='pullback'&&!readAccount(store,'A').signal_state.tok);
    store.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
}

{
  const t0=1_700_000_000;
  const prev60=Array.from({length:60},(_,i)=>({minute:t0+i*60,high_usd:50,close_usd:10,volume_usd:10,net_inflow_usd:1,buy_recipients:{}}));
  const last60=Array.from({length:60},(_,i)=>({minute:t0+60*60+i*60,high_usd:20,close_usd:11,volume_usd:80,net_inflow_usd:40,buy_recipients:Object.fromEntries([...Array(10)].map((_,j)=>['0x'+j.toString(16).padStart(40,'0'),10]))}));
  const t={minute:t0+120*60,high_usd:50.3,close_usd:50.3,volume_usd:90,net_inflow_usd:40,buy_recipients:last60[0].buy_recipients};
  const more=Array.from({length:60},(_,i)=>({minute:t0-60*60+i*60,high_usd:9,close_usd:9,volume_usd:10,net_inflow_usd:1,buy_recipients:{}}));
  const ev=evaluateB([...more,...prev60,...last60,t],{},t0-25*3600,t0+120*60);
  check('v1 B fires on earlier-window high not last60',!!ev.signal,ev);
}

{
  const a={strategy:'A',cash:970,reserve:200,spend_limit:35,principal_limit:30,halted_permanent:false,halted_day:false,
    equity:1000,unrealized:0,realized:0,positions:[],trades:[],seen:[],used_signals:[],closed_rounds:[],reject_counts:{},
    failed_sells:0,exit_incomplete:0,max_drawdown:0,max_drawdown_pct:0,peak_equity:1000,problems:[]};
  applyBuy(a,{token:'0x1',qty:1000n,cost:30,block:1,signal_ts:1,decision_ts:1,quote_block:1,fill_ts:1});
  a.positions[0].mark=40; // full remaining mark
  applySell(a,a.positions[0],500n,20,'partial_tp',2,{fill_ts:2});
  const bogus=a.cash+a.positions[0].mark;
  check('v1 leftover mark double-counts equity',bogus>a.cash+20, {cash:a.cash,staleMark:a.positions[0].mark,bogus});
}

{
  const plan={qty:1n,buy:{amountOut:1n},sell:{amountOut:1n}};
  let threw=false;
  try {JSON.stringify(plan);} catch(e){threw=true;}
  check('v1 JSON.stringify BigInt throws',threw);
}

if(fails.length){console.log('REPRODUCED',fails.length,fails.join(','));process.exitCode=0;}
else {console.log('UNEXPECTED_NO_REPRO');process.exitCode=1;}
