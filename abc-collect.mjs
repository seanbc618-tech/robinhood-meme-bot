import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {formatUnits,parseUnits,getAddress,zeroAddress} from 'viem';
import {
  ROOT,A,client,erc20,factoryAbi,hookAbi,swapEvent,failure,requireValue,same,save,
  poolFor,quoteExact,quoteUsd,usdRates,blockContext,holderData,roundTrip,stringify,
} from './chain.mjs';

export const STRATEGY_VERSION='abc-phase1-v7';
export const CODE_VERSION='abc-phase1-v7';
export const STALE_SEC=120;
export const CYCLE_TARGET_MS=60000;
export const ANALYZE_LIMIT=1;
export const LIVE_WATCH_N=2;
export const WATCH_TTL_MS=24*3600*1000;
export const WATCH_POST_MATURITY_MS=2*3600*1000;
export const WATCH_MAX_MS=36*3600*1000;
export const WATCH_WINDOW_MINUTES=120;
export const LIVE_MAX_LAG=2000n;
export const LIVE_LOOKBACK=900n;
export const HAIRCUT_BPS=50n;
export const LOG_CHUNK=300n;
export const MAX_LOG_BLOCKS_PER_POOL=900n;
export const CATALOG_MAX_BLOCKS=900n;
export const COLLECT_BUDGET_MS=45000;
export const RPC_CALL_TIMEOUT_MS=12000;
export const RPC_RETRIES=3;
export const RPC_RETRY_DELAY_MS=400;
export const DEFAULT_HOURS=336;

export function abcDir(home) {
  return home||process.env.ABC_HOME||resolve(ROOT,'data/abc');
}

export function classifyError(error) {
  const msg=failure(error);
  if(/QUOTE_ASSET_NOT_IMPLEMENTED|UNSUPPORTED_QUOTE/.test(msg)) return 'UNSUPPORTED_QUOTE';
  // Capability gaps and transient RPC are not archive confirmation.
  if(/INVALID_DECLARED_GAP|archive (cut|truncat|prun)|pruned history|no (historical )?archive|historical state unavailable/i.test(msg))
    return 'INVALID_DECLARED_GAP';
  return 'SOURCE_UNAVAILABLE';
}

export function usdSourceAge(rates,now=Date.now()/1000) {
  return Math.max(...['ethereum','tether','global-dollar'].map(k=>now-rates.prices[k].last_updated_at));
}
export function assertFreshness(block,rates,now=Date.now()/1000) {
  requireValue(Math.abs(now-Number(block.timestamp))<=STALE_SEC,'SOURCE_STALE');
  requireValue(Math.abs(now-rates.observed_at)<=STALE_SEC,'USD_OBSERVED_STALE');
  for(const key of ['ethereum','tether','global-dollar']) {
    requireValue(rates.prices[key]&&Number.isFinite(rates.prices[key].usd)&&rates.prices[key].usd>0,'USD_SOURCE_MISSING');
  }
}
export function assertTradeFresh(block,rates,nowMs=Date.now()) {
  const now=nowMs/1000;
  if(Math.abs(now-Number(block.timestamp))>STALE_SEC) return 'BLOCK_STALE';
  if(Math.abs(now-rates.observed_at)>STALE_SEC) return 'USD_OBSERVED_STALE';
  if(usdSourceAge(rates,now)>STALE_SEC) return 'USD_SOURCE_STALE';
  return null;
}

export function quoteFresh(blockTs,rateTs,now,limit=STALE_SEC) {
  if(Math.abs(now-Number(blockTs))>limit) return 'BLOCK_STALE';
  if(Math.abs(now-Number(rateTs))>limit) return 'RATE_STALE';
  return null;
}

export function minuteStart(ts) {return Math.floor(Number(ts)/60)*60;}

export function haircutQty(amount,bps=HAIRCUT_BPS) {
  amount=BigInt(amount);bps=BigInt(bps);
  return amount*(10000n-bps)/10000n;
}

export function modeledGasUsd(q,gasPrice,rates) {
  const exec=Number(formatUnits((q.quoterGasEstimate+180000n)*gasPrice,18))*rates.prices.ethereum.usd;
  return Math.max(0.25,exec)+0.25;
}

export function sqrtPriceToUsd(pool,sqrtPriceX96,rates) {
  const ratio=Number(sqrtPriceX96)/(2**96);
  if(!(ratio>0)) return null;
  const raw=ratio*ratio;
  const tokenIs0=same(pool.token,pool.key.currency0);
  const quotePerToken=tokenIs0?raw*10**(pool.decimals-pool.quoteDecimals):(1/raw)*10**(pool.decimals-pool.quoteDecimals);
  if(!Number.isFinite(quotePerToken)||quotePerToken<=0) return null;
  return quotePerToken*quoteUsd(pool,rates);
}

function tableCols(db,table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name);
}
function migrateAbc(db) {
  const bcols=tableCols(db,'buckets');
  if(!bcols.includes('invalid')) db.exec('ALTER TABLE buckets ADD COLUMN invalid INTEGER NOT NULL DEFAULT 0');
  if(!bcols.includes('fx_note')) db.exec('ALTER TABLE buckets ADD COLUMN fx_note TEXT');
  if(!bcols.includes('usd_usable')) db.exec('ALTER TABLE buckets ADD COLUMN usd_usable INTEGER NOT NULL DEFAULT 0');
  if(!bcols.includes('miss_reason')) db.exec('ALTER TABLE buckets ADD COLUMN miss_reason TEXT');
  const pcols=tableCols(db,'pools');
  if(!pcols.includes('last_complete_minute')) db.exec('ALTER TABLE pools ADD COLUMN last_complete_minute INTEGER');
  if(!pcols.includes('last_event_block')) db.exec('ALTER TABLE pools ADD COLUMN last_event_block INTEGER');
  if(!pcols.includes('live_from_block')) db.exec('ALTER TABLE pools ADD COLUMN live_from_block INTEGER');
  if(!pcols.includes('live_from_ts')) db.exec('ALTER TABLE pools ADD COLUMN live_from_ts INTEGER');
  const wcols=tableCols(db,'watch_slots');
  if(wcols.length&&!wcols.includes('status')) db.exec("ALTER TABLE watch_slots ADD COLUMN status TEXT");
}

export function markV1BucketsInvalid(store) {
  store.db.prepare(`UPDATE buckets SET invalid=1, fx_note=COALESCE(fx_note,'')||';v1_cursor_contaminated' WHERE IFNULL(invalid,0)=0`).run();
  store.db.exec(`UPDATE pools SET last_complete_minute=(SELECT MAX(minute) FROM buckets WHERE buckets.token=pools.token),
    last_event_block=NULL,
    last_cursor_block=CASE WHEN first_seen_block IS NOT NULL THEN first_seen_block-1 ELSE last_cursor_block END`);
}

export function isolateNonContemporaneousFx(store) {
  store.db.prepare(`UPDATE buckets SET usd_usable=0 WHERE IFNULL(usd_usable,1)=1 AND (
    fx_note LIKE '%NOT_HISTORICAL_FX%' OR fx_note IS NULL)`).run();
}

export function poolFromRow(row) {
  if(!row||!row.pool_id||row.decimals==null||row.quote_decimals==null||!row.quote) return null;
  const token=row.token,quote=row.quote;
  const sorted=[token.toLowerCase(),quote.toLowerCase()].sort();
  return {
    token,id:row.pool_id,quote,decimals:row.decimals,quoteDecimals:row.quote_decimals,curve:row.curve,
    key:{currency0:sorted[0],currency1:sorted[1]},launch:{phase:2},
  };
}

export function minutesToClose(lastCompleteMinute,firstWatchTs,headTs) {
  const firstFull=lastCompleteMinute!=null?lastCompleteMinute+60:minuteStart(firstWatchTs)+60;
  const lastFull=minuteStart(Number(headTs))-60;
  const out=[];
  if(lastFull>=firstFull) for(let m=firstFull;m<=lastFull;m+=60) out.push(m);
  return out;
}

export function openAbc(home) {
  const dir=abcDir(home);
  mkdirSync(dir,{recursive:true});
  const db=new DatabaseSync(resolve(dir,'abc.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS run(id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS accounts(strategy TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pools(
      token TEXT PRIMARY KEY, pool_id TEXT, quote TEXT, curve TEXT,
      registered_block INTEGER, registered_ts INTEGER,
      graduated_block INTEGER, graduated_ts INTEGER,
      first_seen_block INTEGER, first_seen_ts INTEGER,
      last_cursor_block INTEGER, last_analyzed_at INTEGER,
      quote_status TEXT, symbol TEXT, decimals INTEGER, quote_decimals INTEGER);
    CREATE TABLE IF NOT EXISTS blocks(number INTEGER PRIMARY KEY, ts INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS buckets(
      token TEXT NOT NULL, minute INTEGER NOT NULL,
      open_usd REAL, high_usd REAL, low_usd REAL, close_usd REAL,
      volume_usd REAL NOT NULL, buy_usd REAL NOT NULL, sell_usd REAL NOT NULL,
      net_inflow_usd REAL NOT NULL, buy_recipients TEXT NOT NULL,
      buy_recipient_count INTEGER NOT NULL, swap_count INTEGER NOT NULL,
      no_trade INTEGER NOT NULL, executable INTEGER NOT NULL,
      from_block INTEGER, to_block INTEGER, collected_at INTEGER NOT NULL,
      source_block INTEGER, close_sqrt TEXT,
      PRIMARY KEY(token, minute));
    CREATE TABLE IF NOT EXISTS stats(key TEXT PRIMARY KEY, value INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS swap_events(
      token TEXT NOT NULL, block INTEGER NOT NULL, log_index INTEGER NOT NULL,
      ts INTEGER NOT NULL, tx TEXT, sqrt TEXT, token_amount TEXT, quote_amount TEXT,
      quote_vol REAL NOT NULL, sender TEXT,
      PRIMARY KEY(token, block, log_index));
    CREATE TABLE IF NOT EXISTS transfer_events(
      token TEXT NOT NULL, block INTEGER NOT NULL, log_index INTEGER NOT NULL,
      ts INTEGER NOT NULL, tx TEXT, frm TEXT, dest TEXT, value TEXT,
      PRIMARY KEY(token, block, log_index));
    CREATE TABLE IF NOT EXISTS coverage_gaps(
      token TEXT NOT NULL, from_block INTEGER, to_block INTEGER, from_ts INTEGER, to_ts INTEGER,
      reason TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS watch_slots(
      slot INTEGER PRIMARY KEY, token TEXT NOT NULL, seated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, status TEXT);
    CREATE TABLE IF NOT EXISTS watch_slot_history(
      id INTEGER PRIMARY KEY AUTOINCREMENT, slot INTEGER, token TEXT, seated_at INTEGER, expires_at INTEGER,
      ended_at INTEGER, end_reason TEXT);
    CREATE TABLE IF NOT EXISTS fx_snap(
      minute INTEGER PRIMARY KEY, observed_at INTEGER NOT NULL,
      eth_usd REAL, usdg_usd REAL, tether_usd REAL,
      eth_last_updated INTEGER, usdg_last_updated INTEGER, tether_last_updated INTEGER);
    CREATE TABLE IF NOT EXISTS fx_observations(
      minute INTEGER NOT NULL, observed_at INTEGER NOT NULL,
      eth_usd REAL, usdg_usd REAL, tether_usd REAL,
      eth_last_updated INTEGER, usdg_last_updated INTEGER, tether_last_updated INTEGER,
      PRIMARY KEY(minute,observed_at));
    CREATE TABLE IF NOT EXISTS minute_status(
      token TEXT NOT NULL, minute INTEGER NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY(token, minute));`);
  migrateAbc(db);
  return {dir,db,
    bump(key,n=1){
      db.prepare('INSERT INTO stats VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=value+?').run(key,n,n);
    },
    stat(key){const r=db.prepare('SELECT value FROM stats WHERE key=?').get(key);return r?r.value:0;},
    close(){db.close();},
  };
}

export function initAccounts(store) {
  const now=Date.now();
  for(const [strategy,principal,spend] of [['A',30,35],['B',30,35],['C',15,20]]) {
    const exists=store.db.prepare('SELECT strategy FROM accounts WHERE strategy=?').get(strategy);
    if(exists) continue;
    const payload={
      strategy,cash:1000,reserve:200,principal_limit:principal,spend_limit:spend,
      halted_permanent:false,halted_day:false,day_key:null,day_baseline:null,
      equity:1000,unrealized:0,realized:0,positions:[],trades:[],seen:[],
      used_signals:[],signal_state:{},closed_rounds:[],problems:[],reject_counts:{},
      failed_sells:0,exit_incomplete:0,max_drawdown:0,max_drawdown_pct:0,peak_equity:1000,
      model:'QUOTE_MINUS_50BPS_HAIRCUT_PLUS_GAS_AND_L1',
      capital_note:'Virtual USDT budget marked in USD; not a claim of held USDT',
      version:STRATEGY_VERSION,created_at:now,
    };
    store.db.prepare('INSERT INTO accounts VALUES(?,?)').run(strategy,JSON.stringify(payload));
  }
}

export function readAccount(store,strategy) {
  return JSON.parse(store.db.prepare('SELECT payload FROM accounts WHERE strategy=?').get(strategy).payload);
}
export function writeAccount(store,account) {
  store.db.prepare('UPDATE accounts SET payload=? WHERE strategy=?').run(stringify(account),account.strategy);
}
export function readRun(store) {
  const row=store.db.prepare('SELECT payload FROM run WHERE id=1').get();
  return row?JSON.parse(row.payload):null;
}
export function writeRun(store,run) {
  const payload=stringify(run);
  if(store.db.prepare('SELECT id FROM run WHERE id=1').get())
    store.db.prepare('UPDATE run SET payload=? WHERE id=1').run(payload);
  else store.db.prepare('INSERT INTO run VALUES(1,?)').run(payload);
}

export function slimSignalResult(result) {
  if(!result) return result;
  if(result.filled) return {filled:true,qty:String(result.plan?.qty??''),cash_out:result.plan?.cash_out,loss_pct:result.plan?.loss_pct};
  return {skipped:result.skipped};
}

export function fxContemporaneous(minute,rates,quote) {
  if(!rates||rates.observed_at==null) return false;
  const end=Number(minute)+60;
  if(Math.abs(Number(rates.observed_at)-end)>STALE_SEC) return false;
  const eth=quote==null||quote===zeroAddress||String(quote).toLowerCase()===zeroAddress;
  const key=eth?'ethereum':'global-dollar';
  const src=rates.prices?.[key]?.last_updated_at;
  if(src==null||Math.abs(Number(src)-end)>STALE_SEC) return false;
  return true;
}

export function saveFxSnap(store,rates) {
  if(!rates||!rates.prices) return;
  const p=rates.prices;
  const row={
    observed_at:rates.observed_at,
    eth_usd:p.ethereum?.usd,usdg_usd:p['global-dollar']?.usd,tether_usd:p.tether?.usd,
    eth_last_updated:p.ethereum?.last_updated_at,usdg_last_updated:p['global-dollar']?.last_updated_at,
    tether_last_updated:p.tether?.last_updated_at,
  };
  const ins=store.db.prepare(`INSERT OR IGNORE INTO fx_observations(minute,observed_at,eth_usd,usdg_usd,tether_usd,eth_last_updated,usdg_last_updated,tether_last_updated)
    VALUES(?,?,?,?,?,?,?,?)`);
  const m=minuteStart(rates.observed_at);
  ins.run(m,row.observed_at,row.eth_usd,row.usdg_usd,row.tether_usd,row.eth_last_updated,row.usdg_last_updated,row.tether_last_updated);
  ins.run(m-60,row.observed_at,row.eth_usd,row.usdg_usd,row.tether_usd,row.eth_last_updated,row.usdg_last_updated,row.tether_last_updated);
}

export function fxForMinute(store,minute,quote) {
  const end=Number(minute)+60;
  const eth=quote==null||quote===zeroAddress||String(quote).toLowerCase()===zeroAddress;
  // Preserve legacy evidence; choose independently for each quote asset.
  const candidates=store.db.prepare(`SELECT * FROM fx_observations WHERE minute=?
    UNION ALL SELECT * FROM fx_snap WHERE minute=? ORDER BY observed_at DESC`).all(minute,minute);
  const snap=candidates.find(s=>Math.abs(Number(s.observed_at)-end)<=STALE_SEC
    && (eth?s.eth_last_updated:s.usdg_last_updated)!=null
    && Math.abs(Number(eth?s.eth_last_updated:s.usdg_last_updated)-end)<=STALE_SEC
    && (eth?s.eth_usd:s.usdg_usd)>0)||candidates[0];
  if(!snap) return {ok:false,reason:'NO_FX_SNAP'};
  if(Math.abs(Number(snap.observed_at)-end)>STALE_SEC) return {ok:false,reason:'OBSERVED_AT_LAG'};
  const lu=eth?snap.eth_last_updated:snap.usdg_last_updated;
  const px=eth?snap.eth_usd:snap.usdg_usd;
  if(lu==null||Math.abs(Number(lu)-end)>STALE_SEC) return {ok:false,reason:'SOURCE_LAST_UPDATED_LAG'};
  if(!(px>0)) return {ok:false,reason:'NO_FX_SNAP'};
  const rates={observed_at:snap.observed_at,prices:{
    ethereum:{usd:snap.eth_usd,last_updated_at:snap.eth_last_updated},
    'global-dollar':{usd:snap.usdg_usd,last_updated_at:snap.usdg_last_updated},
    tether:{usd:snap.tether_usd,last_updated_at:snap.tether_last_updated},
  }};
  return {ok:true,rates,px,reason:null};
}

export function estimateBlocksPerSec(store) {
  const rows=store.db.prepare('SELECT number,ts FROM blocks ORDER BY number DESC LIMIT 80').all();
  if(rows.length<2) return 10;
  const dt=rows[0].ts-rows[rows.length-1].ts;
  const dn=rows[0].number-rows[rows.length-1].number;
  if(!(dt>0&&dn>0)) return 10;
  const r=dn/dt;
  return (r>0.5&&r<50)?r:10;
}
export function logBlocksNeeded(store,intervalSec=60) {
  const n=Math.ceil(estimateBlocksPerSec(store)*intervalSec*1.5);
  return BigInt(Math.max(900,Math.min(n,2000)));
}

export function extendActiveWatchBounds(store) {
  store.db.prepare(`UPDATE watch_slots SET expires_at=seated_at+?, status=COALESCE(status,'ACTIVE')
    WHERE slot!=2 AND COALESCE(status,'ACTIVE')='ACTIVE' AND expires_at<seated_at+?`).run(WATCH_MAX_MS,WATCH_MAX_MS);
}

export function usableStreak(store,token) {
  const mins=store.db.prepare('SELECT minute FROM buckets WHERE token=? AND usd_usable=1 AND IFNULL(invalid,0)=0 ORDER BY minute').all(token);
  let best=0,streak=0,prev=null;
  for(const {minute} of mins) {
    streak=(prev!=null&&minute===prev+60)?streak+1:1;
    best=Math.max(best,streak);prev=minute;
  }
  return {count:mins.length,longest:best};
}

export function watchSlotDecision(store,slot,now=Date.now()) {
  const maxEnd=Number(slot.seated_at)+WATCH_MAX_MS;
  const streak=usableStreak(store,slot.token);
  const pool=store.db.prepare('SELECT * FROM pools WHERE token=?').get(slot.token);
  const grad=pool?graduationTs(pool):null;
  if(slot.slot===2) {
    const keep=grad!=null&&now<Number(grad)*1000+6*3600000;
    return {keep,reason:keep?null:'WATCH_C_AGE_EXPIRED',streak,maxEnd};
  }
  const gradMs=grad!=null?Number(grad)*1000:Number(slot.seated_at);
  const holdUntil=gradMs+24*3600*1000+WATCH_POST_MATURITY_MS;
  if(now>=maxEnd) return {keep:false,reason:streak.longest>=WATCH_WINDOW_MINUTES?'WATCH_EXPIRED_MAX_BOUND':'WATCH_EXPIRED_INCOMPLETE_WINDOW',streak,holdUntil,maxEnd};
  if(now>=holdUntil&&streak.longest>=WATCH_WINDOW_MINUTES) return {keep:false,reason:'WATCH_COMPLETED',streak,holdUntil,maxEnd};
  return {keep:true,reason:null,streak,holdUntil,maxEnd};
}

function archiveSlot(store,slot,now,reason) {
  store.db.prepare(`INSERT INTO watch_slot_history(slot,token,seated_at,expires_at,ended_at,end_reason) VALUES(?,?,?,?,?,?)`)
    .run(slot.slot,slot.token,slot.seated_at,slot.expires_at,now,reason);
}

export function ensureWatchSlots(store,now=Date.now(),n=LIVE_WATCH_N) {
  store.db.prepare(`UPDATE watch_slots SET status=COALESCE(status,'ACTIVE') WHERE status IS NULL`).run();
  const all=store.db.prepare('SELECT * FROM watch_slots ORDER BY slot').all();
  const keep=[];
  const ended=new Set();
  for(const slot of all) {
    if((slot.status||'ACTIVE')!=='ACTIVE') continue;
    const dec=watchSlotDecision(store,slot,now);
    if(dec.keep) {keep.push(slot);continue;}
    store.db.exec('BEGIN');
    try {
      archiveSlot(store,slot,now,dec.reason);
      store.db.prepare(`UPDATE watch_slots SET status=? WHERE slot=?`).run(dec.reason,slot.slot);
      store.db.exec('COMMIT');
    } catch(e) {store.db.exec('ROLLBACK');throw e;}
    ended.add(slot.token.toLowerCase());
  }
  const seated=new Set(keep.map(s=>s.token.toLowerCase()));
  const taken=new Set(keep.map(s=>s.slot));
  const reusable=store.db.prepare(`SELECT * FROM watch_slots WHERE status IS NOT NULL AND status!='ACTIVE' ORDER BY slot`).all();
  if(keep.length<n) {
    const newest=store.db.prepare(`SELECT * FROM pools WHERE quote_status='ok' ORDER BY COALESCE(registered_ts,first_seen_ts) DESC, token ASC`).all();
    const prefer=newest.filter(r=>!ended.has(r.token.toLowerCase()));
    const pickFrom=prefer.length?prefer:newest;
    const ins=store.db.prepare(`INSERT INTO watch_slots(slot,token,seated_at,expires_at,status) VALUES(?,?,?,?,?)`);
    const upd=store.db.prepare(`UPDATE watch_slots SET token=?,seated_at=?,expires_at=?,status='ACTIVE' WHERE slot=?`);
    let ri=0;
    for(const row of pickFrom) {
      if(keep.length>=n) break;
      if(seated.has(row.token.toLowerCase())) continue;
      const existing=new Set(store.db.prepare('SELECT slot FROM watch_slots').all().map(s=>s.slot));
      let target=ri<reusable.length?reusable[ri].slot:1;
      if(ri>=reusable.length) while(existing.has(target)) target++;
      const grad=graduationTs(row);
      // Slot 1 retains A/B history; slot 2 admits pools with time to build C's 30m window.
      if(target===2&&(grad==null||now<grad*1000||now>=grad*1000+5.5*3600000)) continue;
      const exp=target===2?grad*1000+6*3600000:now+WATCH_MAX_MS;
      if(ri<reusable.length) {
        const old=reusable[ri++];
        store.db.exec('BEGIN');
        try {upd.run(row.token,now,exp,old.slot);store.db.exec('COMMIT');}
        catch(e) {store.db.exec('ROLLBACK');throw e;}
        keep.push({slot:old.slot,token:row.token,seated_at:now,expires_at:exp,status:'ACTIVE'});
      } else {
        const existing=new Set(store.db.prepare('SELECT slot FROM watch_slots').all().map(s=>s.slot));
        let slot=1;while(existing.has(slot)) slot++;
        ins.run(slot,row.token,now,exp,'ACTIVE');
        keep.push({slot,token:row.token,seated_at:now,expires_at:exp,status:'ACTIVE'});
      }
      seated.add(row.token.toLowerCase());
      taken.add(keep[keep.length-1].slot);
    }
  }
  const rows=[];
  for(const s of keep) {
    const row=store.db.prepare('SELECT * FROM pools WHERE token=?').get(s.token);
    if(row) rows.push({...row,_slot:s.slot,_seated_at:s.seated_at,_expires_at:s.expires_at,_status:s.status});
  }
  return {
    live:rows,
    n,
    catalog_ok:store.db.prepare(`SELECT count(*) c FROM pools WHERE quote_status='ok'`).get().c,
    note:`WATCH n=${n}; slot 1 retains A/B up to ${WATCH_MAX_MS/3600000}h; slot 2 C age <6h; empty if no eligible pool; not full catalog`,
  };
}

export function countReject(account,reason) {
  account.reject_counts[reason]=(account.reject_counts[reason]||0)+1;
}

async function blockTs(store,number,io={}) {
  number=Number(number);
  if(io.deadline&&Date.now()>io.deadline) throw new Error('RPC_DEADLINE eth_getBlockByNumber');
  const epoch=io.rpcEpoch||0;
  const cached=store.db.prepare('SELECT ts FROM blocks WHERE number=?').get(number);
  if(cached) return cached.ts;
  const b=await client.getBlock({blockNumber:BigInt(number)});
  if((io.rpcEpoch||0)!==epoch) throw new Error('RPC_STALE eth_getBlockByNumber');
  const ts=Number(b.timestamp);
  store.db.prepare('INSERT OR IGNORE INTO blocks VALUES(?,?)').run(number,ts);
  return ts;
}

async function firstBlockAtOrAfter(store,timestamp,lo,hi) {
  lo=BigInt(lo);hi=BigInt(hi);
  let loTs=await blockTs(store,lo),hiTs=await blockTs(store,hi);
  if(loTs>=timestamp) return lo;
  if(hiTs<timestamp) return null;
  while(lo<hi) {
    const mid=(lo+hi)/2n;
    const ts=await blockTs(store,mid);
    if(ts<timestamp) lo=mid+1n;else hi=mid;
  }
  return lo;
}

export async function syncCatalog(store,block,io={}) {
  const run=readRun(store)||{};
  if(run.catalog_cursor==null) {
    run.catalog_cursor=String(block.number);
    writeRun(store,run);
    return {added:0,from:String(block.number),to:String(block.number),seeded:true};
  }
  const cursor=BigInt(run.catalog_cursor);
  if(cursor>=block.number) return {added:0,from:String(cursor),to:String(block.number)};
  const start=cursor+1n;
  const catalogCap=start+CATALOG_MAX_BLOCKS-1n>block.number?block.number:start+CATALOG_MAX_BLOCKS-1n;
  let added=0;
  for(let from=start;from<=catalogCap;from+=LOG_CHUNK) {
    if(io.deadline&&Date.now()>io.deadline) break;
    const to=from+LOG_CHUNK-1n>catalogCap?catalogCap:from+LOG_CHUNK-1n;
    let registered,graduated;
    try {
      registered=await rpcRetry((ms)=>rpcTimeout(client.getLogs({address:A.hook,event:hookAbi.find(a=>a.name==='PoolRegistered'),fromBlock:from,toBlock:to,strict:true}),ms,`eth_getLogs PoolRegistered ${from}-${to}`,io),io);
      graduated=await rpcRetry((ms)=>rpcTimeout(client.getLogs({address:A.factory,event:factoryAbi.find(a=>a.name==='PoolGraduated'),fromBlock:from,toBlock:to,strict:true}),ms,`eth_getLogs PoolGraduated ${from}-${to}`,io),io);
    } catch(error) {
      store.bump(classifyError(error));
      throw error;
    }
    const upsert=store.db.prepare(`INSERT INTO pools(token,pool_id,quote,registered_block,registered_ts,graduated_block,graduated_ts,first_seen_block,first_seen_ts,last_cursor_block,quote_status)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(token) DO UPDATE SET
        pool_id=COALESCE(excluded.pool_id,pool_id),
        quote=COALESCE(excluded.quote,quote),
        registered_block=COALESCE(pools.registered_block,excluded.registered_block),
        registered_ts=COALESCE(pools.registered_ts,excluded.registered_ts),
        graduated_block=COALESCE(pools.graduated_block,excluded.graduated_block),
        graduated_ts=COALESCE(pools.graduated_ts,excluded.graduated_ts)`);
    for(const log of registered) {
      const token=getAddress(log.args.memecoin);
      const quote=getAddress(log.args.quoteToken);
      const ts=await blockTs(store,log.blockNumber);
      const supported=same(quote,zeroAddress)||same(quote,A.usdg);
      if(!supported) store.bump('UNSUPPORTED_QUOTE');
      upsert.run(token,log.args.poolId,quote.toLowerCase(),Number(log.blockNumber),ts,null,null,
        Number(log.blockNumber),ts,Number(log.blockNumber)-1,supported?'ok':'UNSUPPORTED_QUOTE');
      added++;
    }
    for(const log of graduated) {
      const token=getAddress(log.args.token);
      const ts=await blockTs(store,log.blockNumber);
      const row=store.db.prepare('SELECT token FROM pools WHERE token=?').get(token);
      if(!row) {
        upsert.run(token,null,null,null,null,Number(log.blockNumber),ts,Number(log.blockNumber),ts,Number(log.blockNumber)-1,'ok');
        added++;
      } else {
        store.db.prepare('UPDATE pools SET graduated_block=COALESCE(graduated_block,?), graduated_ts=COALESCE(graduated_ts,?) WHERE token=?')
          .run(Number(log.blockNumber),ts,token);
      }
    }
    run.catalog_cursor=String(to);
    writeRun(store,run);
  }
  return {added,from:String(start),to:String(block.number)};
}

export function graduationTs(row) {
  // Prefer PoolRegistered time (pool exists). Fall back to PoolGraduated. Never guess.
  if(row.registered_ts) return row.registered_ts;
  if(row.graduated_ts) return row.graduated_ts;
  return null;
}

export function loadBuckets(store,token,fromMinute,toMinute) {
  const rows=store.db.prepare('SELECT * FROM buckets WHERE token=? AND minute>=? AND minute<? AND IFNULL(invalid,0)=0 AND IFNULL(usd_usable,0)=1 ORDER BY minute').all(token,fromMinute,toMinute);
  return rows.map(r=>({...r,buy_recipients:JSON.parse(r.buy_recipients||'{}')}));
}

export async function rpcTimeout(promise,ms,label,io) {
  let timer;
  const epoch=io&&io.rpcEpoch;
  try {
    return await Promise.race([
      promise,
      new Promise((_,reject)=>{timer=setTimeout(()=>{
        if(io&&io.rpcEpoch===epoch) io.rpcEpoch=(io.rpcEpoch||0)+1;
        reject(new Error('RPC_TIMEOUT '+label));
      },ms);}),
    ]);
  } finally {if(timer) clearTimeout(timer);}
}

export function rpcBudgetMs(io={},cap=RPC_CALL_TIMEOUT_MS,now=Date.now()) {
  const base=io.rpcTimeoutMs??cap;
  if(!(base>0)) return 0;
  if(io.deadline==null) return base;
  return Math.max(0,Math.min(base,io.deadline-now));
}

export async function rpcRetry(fn,io={}) {
  const tries=io.rpcRetries??RPC_RETRIES;
  const delay=io.rpcRetryDelayMs??RPC_RETRY_DELAY_MS;
  let last;
  for(let i=0;i<tries;i++) {
    const ms=rpcBudgetMs(io);
    if(ms<=0) throw last||new Error('RPC_DEADLINE');
    try {return await fn(ms);}
    catch(error) {
      last=error;
      if(i+1>=tries) break;
      const left=rpcBudgetMs(io);
      if(left<=0) break;
      if(delay>0) {
        const wait=Math.min(delay,left);
        if(wait<=0) break;
        await new Promise(r=>setTimeout(r,wait));
        if(rpcBudgetMs(io)<=0) break;
      }
    }
  }
  throw last||new Error('RPC_DEADLINE');
}

export function bucketMap(rows) {
  const m=new Map();
  for(const r of rows) m.set(r.minute,r);
  return m;
}

export function takeWindow(map,start,end) {
  const out=[];
  for(let m=start;m<end;m+=60) {
    const b=map.get(m);
    if(!b) return null;
    out.push(b);
  }
  return out;
}

export function uniqueRecipients(buckets) {
  const s=new Set();
  for(const b of buckets) for(const a of Object.keys(b.buy_recipients||{})) s.add(a);
  return s;
}

export function recipientShare(buckets) {
  const totals={};let buy=0;
  for(const b of buckets) {
    for(const [a,v] of Object.entries(b.buy_recipients||{})) {totals[a]=(totals[a]||0)+v;buy+=v;}
  }
  if(!(buy>0)) return {buy:0,max:null,totals};
  let max=0;
  for(const v of Object.values(totals)) if(v>max) max=v;
  return {buy,max,share:max/buy,totals};
}

async function infraSet(curve,blockNumber) {
  const locker=await client.readContract({address:A.factory,abi:factoryAbi,functionName:'locker',blockNumber});
  return new Set([zeroAddress,A.manager,A.router,A.hook,locker,curve,A.factory,A.permit2].filter(Boolean).map(a=>a.toLowerCase()));
}

export async function enrichPool(store,token,blockNumber) {
  const launch=await client.readContract({address:A.factory,abi:factoryAbi,functionName:'getLaunchedToken',args:[token],blockNumber});
  requireValue(launch.exists&&same(launch.token,token),'NOT_PONS_V2');
  requireValue(launch.phase===2,'NOT_POOL_REGISTERED');
  const quote=launch.pairToken.toLowerCase();
  const supported=quote===zeroAddress.toLowerCase()||quote===A.usdg.toLowerCase();
  if(!supported) {
    store.db.prepare('UPDATE pools SET quote_status=?,quote=?,curve=? WHERE token=?').run('UNSUPPORTED_QUOTE',quote,launch.curve,token);
    store.bump('UNSUPPORTED_QUOTE');
    throw new Error('UNSUPPORTED_QUOTE');
  }
  const pool=await poolFor(token,blockNumber);
  let symbol=null;
  try {symbol=await client.readContract({address:token,abi:erc20,functionName:'symbol',blockNumber});} catch {}
  store.db.prepare(`UPDATE pools SET pool_id=?,quote=?,curve=?,decimals=?,quote_decimals=?,symbol=?,quote_status='ok' WHERE token=?`)
    .run(pool.id,pool.quote,launch.curve,pool.decimals,pool.quoteDecimals,symbol,token);
  return {...pool,symbol,curve:launch.curve};
}

export async function collectBuckets(store,row,pool,block,rates,io={}) {
  const token=row.token;
  if(io.rpcEpoch==null) io.rpcEpoch=0;
  const getLogsRaw=io.getLogs||((args,ms)=>rpcTimeout(client.getLogs(args),ms,`eth_getLogs ${args.event?.name||'logs'} ${args.fromBlock}-${args.toBlock}`,io));
  const getLogs=(args)=>rpcRetry((ms)=>getLogsRaw(args,ms),io);
  const tsOf=io.blockTs||((n)=>rpcRetry((ms)=>rpcTimeout(blockTs(store,n,io),ms,`eth_getBlockByNumber ${n}`,io),io));
  const eventCursor=row.last_event_block!=null?row.last_event_block:row.last_cursor_block;
  const from=BigInt(eventCursor)+1n;
  if(from>block.number) {
    return foldStoredEvents(store,row,pool,block,rates,io);
  }
  const cap=io.maxLogBlocks??(block.number-from>2000n?6000n:logBlocksNeeded(store));
  const limitedTo=from+cap-1n>block.number?block.number:from+cap-1n;
  const tokenIs0=same(pool.token,pool.key.currency0);
  const insertEv=store.db.prepare(`INSERT OR IGNORE INTO swap_events(token,block,log_index,ts,tx,sqrt,token_amount,quote_amount,quote_vol,sender)
    VALUES(?,?,?,?,?,?,?,?,?,?)`);
  let lastEnd=from-1n;
  const profile=io.rpcProfile||[];
  try {
    for(let start=from;start<=limitedTo;start+=LOG_CHUNK) {
      if(io.deadline&&Date.now()>io.deadline) break;
      const end=start+LOG_CHUNK-1n>limitedTo?limitedTo:start+LOG_CHUNK-1n;
      const tLogs=Date.now();
      const swaps=await getLogs({address:A.manager,event:swapEvent,args:{id:pool.id},fromBlock:start,toBlock:end,strict:true});
      const transfers=await getLogs({address:token,event:erc20.find(a=>a.name==='Transfer'),fromBlock:start,toBlock:end,strict:true});
      profile.push({method:'eth_getLogs',from:String(start),to:String(end),ms:Date.now()-tLogs,swaps:swaps.length,transfers:transfers.length});
      const tsCache=new Map();
      async function tsFor(log) {
        const raw=Number(log.blockTimestamp||0);
        if(raw>0) return raw;
        const n=Number(log.blockNumber);
        if(tsCache.has(n)) return tsCache.get(n);
        if(io.deadline&&Date.now()>io.deadline) throw new Error('RPC_DEADLINE eth_getBlockByNumber');
        const ts=await tsOf(n);
        tsCache.set(n,ts);
        return ts;
      }
      store.db.exec('BEGIN');
      try {
        for(const log of transfers) {
          if(log.removed) throw new Error('REMOVED_TRANSFER');
          const ts=await tsFor(log);
          store.db.prepare(`INSERT OR IGNORE INTO transfer_events(token,block,log_index,ts,tx,frm,dest,value)
            VALUES(?,?,?,?,?,?,?,?)`).run(token,Number(log.blockNumber),Number(log.logIndex),ts,log.transactionHash,
            String(log.args.from),String(log.args.to),String(log.args.value));
        }
        for(const swap of swaps) {
          if(swap.removed) throw new Error('REMOVED_SWAP');
          if(same(swap.args.sender,A.hook)) continue;
          const ts=await tsFor(swap);
          const quoteAmount=tokenIs0?swap.args.amount1:swap.args.amount0;
          const tokenAmount=tokenIs0?swap.args.amount0:swap.args.amount1;
          const quoteVol=Math.abs(Number(formatUnits(quoteAmount,pool.quoteDecimals)));
          insertEv.run(token,Number(swap.blockNumber),Number(swap.logIndex),ts,swap.transactionHash,
            String(swap.args.sqrtPriceX96),String(tokenAmount),String(quoteAmount),quoteVol,swap.args.sender);
        }
        lastEnd=end;
        store.db.prepare('UPDATE pools SET last_event_block=?, last_cursor_block=? WHERE token=?').run(Number(lastEnd),Number(lastEnd),token);
        store.db.exec('COMMIT');
      } catch(e) {store.db.exec('ROLLBACK');throw e;}
    }
  } catch(error) {
    const kind=classifyError(error);
    store.bump(kind);
    store.db.prepare(`INSERT INTO coverage_gaps(token,from_block,to_block,from_ts,to_ts,reason,at) VALUES(?,?,?,?,?,?,?)`)
      .run(token,Number(from),Number(lastEnd+1n),null,null,kind,Date.now());
    throw error;
  }
  row.last_event_block=Number(lastEnd);
  row.last_cursor_block=Number(lastEnd);
  return foldStoredEvents(store,row,pool,block,rates,io);
}

function ethUpdated(rates,quote) {
  const eth=quote==null||quote===zeroAddress||String(quote).toLowerCase()===zeroAddress;
  return eth?rates.prices?.ethereum?.last_updated_at:rates.prices?.['global-dollar']?.last_updated_at;
}

export async function foldStoredEvents(store,row,pool,block,rates,io={}) {
  const token=row.token;
  const tsOf=io.blockTs||((n)=>{
    const ms=rpcBudgetMs(io);
    if(ms<=0) return Promise.reject(new Error('RPC_DEADLINE eth_getBlockByNumber'));
    return rpcTimeout(blockTs(store,n,io),ms,`eth_getBlockByNumber ${n}`,io);
  });
  const firstWatch=row.live_from_ts||row.first_seen_ts||Number(block.timestamp);
  if(row.last_event_block==null) throw new Error('SOURCE_UNAVAILABLE coverage_boundary_missing');
  let coveredTs;
  try {coveredTs=await tsOf(row.last_event_block);}
  catch(error) {throw new Error('SOURCE_UNAVAILABLE coverage_boundary');}
  const closable=minutesToClose(row.last_complete_minute,firstWatch,coveredTs);
  if(!closable.length) return {minutes:store.db.prepare('SELECT count(*) c FROM buckets WHERE token=? AND IFNULL(invalid,0)=0').get(token).c,closed:[]};
  const infra=io.infra||await infraSet(pool.curve||row.curve,block.number);
  let lastPrice=null,lastSqrt=null;
  const prev=store.db.prepare('SELECT close_usd,close_sqrt FROM buckets WHERE token=? AND close_usd IS NOT NULL AND IFNULL(invalid,0)=0 AND IFNULL(usd_usable,0)=1 ORDER BY minute DESC LIMIT 1').get(token);
  if(prev) {lastPrice=prev.close_usd;lastSqrt=prev.close_sqrt;}
  const insert=store.db.prepare(`INSERT OR IGNORE INTO buckets
    (token,minute,open_usd,high_usd,low_usd,close_usd,volume_usd,buy_usd,sell_usd,net_inflow_usd,buy_recipients,
     buy_recipient_count,swap_count,no_trade,executable,from_block,to_block,collected_at,source_block,close_sqrt,invalid,fx_note,usd_usable,miss_reason)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const noteStatus=store.db.prepare('INSERT OR REPLACE INTO minute_status(token,minute,reason,at) VALUES(?,?,?,?)');
  const collectedAt=Date.now();
  const closed=[];
  store.db.exec('BEGIN');
  try {
    for(const minute of closable) {
      const fx=fxForMinute(store,minute,pool.quote);
      const usable=fx.ok;
      const pxUse=usable?fx.px:quoteUsd(pool,rates);
      const ratesUse=usable?fx.rates:rates;
      const fxNote=usable
        ? `fx_snap observed_at=${fx.rates.observed_at} last_updated=${ethUpdated(fx.rates,pool.quote)} CONTEMPORANEOUS`
        : `fx_snap reason=${fx.reason}`;
      const existing=store.db.prepare('SELECT minute,close_usd,close_sqrt,invalid,usd_usable FROM buckets WHERE token=? AND minute=?').get(token,minute);
      if(existing) {
        if(!existing.invalid&&existing.usd_usable&&existing.close_usd>0) {lastPrice=existing.close_usd;lastSqrt=existing.close_sqrt;}
        continue;
      }
      const swaps=store.db.prepare(`SELECT * FROM swap_events WHERE token=? AND ts>=? AND ts<? ORDER BY ts,block,log_index`).all(token,minute,minute+60);
      const xfers=store.db.prepare(`SELECT * FROM transfer_events WHERE token=? AND ts>=? AND ts<?`).all(token,minute,minute+60);
      const xferByTx=new Map();
      for(const tr of xfers) {
        const list=xferByTx.get(tr.tx)||[];list.push(tr);xferByTx.set(tr.tx,list);
      }
      if(!swaps.length) {
        if(!(lastPrice>0)||!usable) {noteStatus.run(token,minute,usable?'NOT_COLLECTED':(fx.reason||'NO_FX_SNAP'),collectedAt);continue;}
        insert.run(token,minute,lastPrice,lastPrice,lastPrice,lastPrice,0,0,0,0,'{}',0,0,1,0,
          null,null,collectedAt,Number(block.number),lastSqrt,0,fxNote,1,null);
        closed.push(minute);continue;
      }
      const prices=swaps.map(e=>sqrtPriceToUsd(pool,BigInt(e.sqrt),ratesUse)).filter(v=>v>0);
      if(!prices.length) continue;
      const open=prices[0],close=prices[prices.length-1];
      const high=Math.max(...prices),low=Math.min(...prices);
      let volume=0,buy=0,sell=0,net=0;
      const recipients={};
      for(const e of swaps) {
        const usdVol=e.quote_vol*pxUse;
        volume+=usdVol;
        const tokenAmount=BigInt(e.token_amount),quoteAmount=BigInt(e.quote_amount);
        if(tokenAmount>0n&&quoteAmount<0n) {
          buy+=usdVol;net+=usdVol;
          const deltas=new Map();
          for(const tr of xferByTx.get(e.tx)||[]) {
            const value=BigInt(tr.value);
            deltas.set(tr.dest.toLowerCase(),(deltas.get(tr.dest.toLowerCase())||0n)+value);
            deltas.set(tr.frm.toLowerCase(),(deltas.get(tr.frm.toLowerCase())||0n)-value);
          }
          const positive=[...deltas].filter(([a,v])=>v>0n&&!infra.has(a));
          const total=positive.reduce((s,[,v])=>s+v,0n);
          if(total>0n) for(const [a,v] of positive) recipients[a]=(recipients[a]||0)+usdVol*Number(v)/Number(total);
        } else if(tokenAmount<0n&&quoteAmount>0n) {sell+=usdVol;net-=usdVol;}
      }
      if(usable) {lastPrice=close;lastSqrt=swaps[swaps.length-1].sqrt;}
      else noteStatus.run(token,minute,fx.reason||'NO_FX_SNAP',collectedAt);
      insert.run(token,minute,open,high,low,close,volume,buy,sell,net,JSON.stringify(recipients),
        Object.keys(recipients).length,swaps.length,0,1,swaps[0].block,swaps[swaps.length-1].block,
        collectedAt,Number(block.number),swaps[swaps.length-1].sqrt,0,fxNote,usable?1:0,usable?null:fx.reason);
      closed.push(minute);
    }
    if(closed.length) {
      const last=closed[closed.length-1];
      store.db.prepare('UPDATE pools SET last_complete_minute=? WHERE token=?').run(last,token);
      row.last_complete_minute=last;
    }
    store.db.exec('COMMIT');
  } catch(e) {store.db.exec('ROLLBACK');throw e;}
  return {minutes:store.db.prepare('SELECT count(*) c FROM buckets WHERE token=? AND IFNULL(invalid,0)=0').get(token).c,closed};
}

export function plannedRoundTripFromQuotes(buy,sell,pool,principalUsd,qty,rates,gasPrice,haircutBps=HAIRCUT_BPS) {
  const px=quoteUsd(pool,rates);
  const sellUsd=Number(formatUnits(haircutQty(sell.amountOut,haircutBps),pool.quoteDecimals))*px;
  const buyGas=modeledGasUsd(buy,gasPrice,rates);
  const sellGas=modeledGasUsd(sell,gasPrice,rates);
  const initial=principalUsd+buyGas;
  const recovered=sellUsd-sellGas;
  const loss=initial-recovered;
  return {qty,buy,sell,buyGas,sellGas,initial,recovered,loss,loss_pct:initial>0?loss/initial:null,cash_out:principalUsd+buyGas,haircut_bps:Number(haircutBps)};
}

export async function plannedRoundTrip(pool,principalUsd,block,rates,gasPrice,haircutBps=HAIRCUT_BPS) {
  const px=quoteUsd(pool,rates);
  const amountIn=parseUnits((principalUsd/px).toFixed(Math.min(pool.quoteDecimals,12)),pool.quoteDecimals);
  const buy=await quoteExact(pool,pool.quote,amountIn,block.number);
  const qty=haircutQty(buy.amountOut,haircutBps);
  const sell=await quoteExact(pool,pool.token,qty,block.number);
  return {...plannedRoundTripFromQuotes(buy,sell,pool,principalUsd,qty,rates,gasPrice,haircutBps),amountIn};
}

export async function netExitValue(pool,qty,block,rates,gasPrice,haircutBps=HAIRCUT_BPS) {
  qty=BigInt(qty);
  if(qty<=0n) return {net:0,mark:0,usd:0,gas:0,quote:null,uneconomic:false};
  const q=await quoteExact(pool,pool.token,qty,block.number);
  const px=quoteUsd(pool,rates);
  const usd=Number(formatUnits(haircutQty(q.amountOut,haircutBps),pool.quoteDecimals))*px;
  const gas=modeledGasUsd(q,gasPrice,rates);
  const net=usd-gas;
  return {usd,gas,net,mark:Math.max(0,net),quote:q,uneconomic:net<0};
}

export async function safetyScreen(store,pool,block,rates) {
  const reasons=[];
  if(pool.launch.phase!==2) reasons.push('NOT_PHASE2');
  if(!(pool.liquidity>0n&&pool.sqrtPriceX96>0n)) reasons.push('NO_LIQUIDITY');
  const quote=pool.quote.toLowerCase();
  if(!(quote===zeroAddress.toLowerCase()||quote===A.usdg.toLowerCase())) reasons.push('UNSUPPORTED_QUOTE');
  let holders;
  try {holders=await holderData(pool,block.number);}
  catch(error) {
    store.bump(classifyError(error));
    return {ok:false,reasons:[classifyError(error)],error:failure(error)};
  }
  if(holders.summary.holder_count<15) reasons.push('FEWER_THAN_15_HOLDERS');
  if(holders.summary.top10_circulating_bps>6000) reasons.push('TOP10_OVER_60_PERCENT_CIRCULATING');
  return {ok:!reasons.length,reasons,holders:holders.summary};
}

export async function requireRoundTrip(pool,amountIn,block) {
  if(pool.quote!==zeroAddress&&!process.env.ROBINHOOD_WALLET) {
    return {ok:false,reason:'USDG_SIMULATION_REQUIRES_FUNDED_ACCOUNT'};
  }
  try {
    const sim=await roundTrip(pool,amountIn,block,pool.quote===zeroAddress?undefined:process.env.ROBINHOOD_WALLET);
    return {ok:true,sim};
  } catch(error) {
    return {ok:false,reason:failure(error)};
  }
}

export function pickQueue(store,limit,held) {
  return ensureWatchSlots(store).live;
}

export function pickLiveWatch(store,held=[],n=LIVE_WATCH_N) {
  const watch=ensureWatchSlots(store,Date.now(),n);
  const heldRows=held.map(t=>store.db.prepare('SELECT * FROM pools WHERE token=?').get(t)).filter(Boolean);
  const seen=new Set(watch.live.map(r=>r.token.toLowerCase()));
  const extra=heldRows.filter(r=>!seen.has(r.token.toLowerCase()));
  return {...watch,live:[...watch.live,...extra],held};
}

export async function skipBacklogForLive(store,row,block,io={}) {
  const tsOf=io.blockTs||((n)=>{
    const ms=rpcBudgetMs(io);
    if(ms<=0) return Promise.reject(new Error('RPC_DEADLINE eth_getBlockByNumber'));
    return rpcTimeout(blockTs(store,n,io),ms,`eth_getBlockByNumber ${n}`,io);
  });
  const cur=BigInt(row.last_event_block!=null?row.last_event_block:row.last_cursor_block||0);
  const lag=block.number-cur;
  if(row.live_from_block!=null) return {jumped:false,lag:String(lag),already_live:true};
  if(lag<=LIVE_MAX_LAG) return {jumped:false,lag:String(lag)};
  const jumpTo=block.number>LIVE_LOOKBACK?block.number-LIVE_LOOKBACK:0n;
  if(jumpTo<=cur) return {jumped:false,lag:String(lag)};
  let toTs;
  try {toTs=await tsOf(jumpTo);}
  catch(error) {throw new Error('SOURCE_UNAVAILABLE coverage_boundary');}
  store.db.prepare(`INSERT INTO coverage_gaps(token,from_block,to_block,from_ts,to_ts,reason,at) VALUES(?,?,?,?,?,?,?)`)
    .run(row.token,Number(cur)+1,Number(jumpTo),null,toTs,'LIVE_SUBSCRIBE_SKIP_BACKLOG',Date.now());
  const complete=minuteStart(toTs)-60;
  store.db.prepare(`UPDATE pools SET last_event_block=?,last_cursor_block=?,live_from_block=?,live_from_ts=?,last_complete_minute=? WHERE token=?`)
    .run(Number(jumpTo),Number(jumpTo),Number(jumpTo),toTs,complete,row.token);
  row.last_event_block=Number(jumpTo);
  row.last_cursor_block=Number(jumpTo);
  row.live_from_block=Number(jumpTo);
  row.live_from_ts=toTs;
  row.last_complete_minute=complete;
  return {jumped:true,from:String(cur+1n),to:String(jumpTo),lag:String(lag)};
}

export function catalogStats(store) {
  const total=store.db.prepare('SELECT count(*) c FROM pools').get().c;
  const ok=store.db.prepare(`SELECT count(*) c FROM pools WHERE quote_status='ok'`).get().c;
  const unsupported=store.db.prepare(`SELECT count(*) c FROM pools WHERE quote_status='UNSUPPORTED_QUOTE'`).get().c;
  return {pools:total,supported:ok,unsupported,
    INVALID_DECLARED_GAP:store.stat('INVALID_DECLARED_GAP'),
    SOURCE_UNAVAILABLE:store.stat('SOURCE_UNAVAILABLE'),
    UNSUPPORTED_QUOTE:store.stat('UNSUPPORTED_QUOTE')+unsupported};
}

export {stringify,save,usdRates,blockContext,poolFor,quoteExact,quoteUsd,failure,requireValue};
