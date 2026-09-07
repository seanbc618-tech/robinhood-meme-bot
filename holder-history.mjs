import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

// Separate, disposable source cache. Never shares the paper account tables.
export async function transferHistory(rpc,event,token,target,{path,deadline=Date.now()+15000,maxChunks=8,birthUpper}={}) {
  target=BigInt(target);token=token.toLowerCase();
  const call=async(method,args)=>{
    const ms=Math.min(12000,deadline-Date.now());
    if(ms<=0) throw new Error('HOLDER_HISTORY_DEADLINE');
    let timer;
    try {return await Promise.race([rpc[method](args),new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(new Error('HOLDER_HISTORY_DEADLINE')),ms);
    })]);} finally {clearTimeout(timer);}
  };
  mkdirSync(dirname(path),{recursive:true});
  const db=new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS cursors(token TEXT PRIMARY KEY,lo INTEGER NOT NULL,hi INTEGER NOT NULL,cursor INTEGER,hash TEXT);
    CREATE TABLE IF NOT EXISTS transfers(token TEXT,block INTEGER,idx INTEGER,payload TEXT,PRIMARY KEY(token,block,idx));`);
  try {
    let s=db.prepare('SELECT * FROM cursors WHERE token=?').get(token);
    if(!s) {
      const upper=birthUpper!=null&&BigInt(birthUpper)<target?BigInt(birthUpper):target;
      const code=await call('getCode',{address:token,blockNumber:upper});
      if(!code||code==='0x') throw new Error('HOLDER_DEPLOYMENT_UPPER_HAS_NO_CODE');
      db.prepare('INSERT INTO cursors VALUES(?,?,?,NULL,NULL)').run(token,0,Number(upper));
      s=db.prepare('SELECT * FROM cursors WHERE token=?').get(token);
    }
    // Persist binary-search progress; registration is an upper bound, not mint.
    while(s.lo<s.hi&&Date.now()<deadline) {
      const mid=Math.floor((s.lo+s.hi)/2);
      const code=await call('getCode',{address:token,blockNumber:BigInt(mid)});
      if(code&&code!=='0x') s.hi=mid;else s.lo=mid+1;
      db.prepare('UPDATE cursors SET lo=?,hi=? WHERE token=?').run(s.lo,s.hi,token);
    }
    if(s.lo<s.hi) return {complete:false,stage:'birth_search'};
    if(s.cursor!=null) {
      const anchor=await call('getBlock',{blockNumber:BigInt(s.cursor)});
      if(anchor.hash!==s.hash) throw new Error('HOLDER_HISTORY_REORG');
    }
    let cursor=s.cursor??s.lo-1;
    let chunks=0;
    while(BigInt(cursor)<target&&chunks<maxChunks&&Date.now()<deadline) {
      const from=BigInt(cursor+1),to=from+4999n<target?from+4999n:target;
      const anchor=await call('getBlock',{blockNumber:to});
      const logs=await call('getLogs',{address:token,event,fromBlock:from,toBlock:to,strict:true});
      const confirm=await call('getBlock',{blockNumber:to});
      if(anchor.hash!==confirm.hash) throw new Error('HOLDER_HISTORY_REORG');
      db.exec('BEGIN IMMEDIATE');
      try {
        const ins=db.prepare('INSERT OR IGNORE INTO transfers VALUES(?,?,?,?)');
        for(const log of logs) {
          if(log.removed||log.blockNumber<from||log.blockNumber>to) throw new Error('HOLDER_HISTORY_INVALID_LOG');
          ins.run(token,Number(log.blockNumber),log.logIndex,JSON.stringify(log,(_,v)=>typeof v==='bigint'?v.toString():v));
        }
        db.prepare('UPDATE cursors SET cursor=?,hash=? WHERE token=?').run(Number(to),anchor.hash,token);
        db.exec('COMMIT');
      } catch(e) {db.exec('ROLLBACK');throw e;}
      cursor=Number(to);chunks++;
    }
    if(BigInt(cursor)<target) return {complete:false,stage:'transfers',cursor,target:String(target),chunks};
    const logs=db.prepare('SELECT payload FROM transfers WHERE token=? AND block<=? ORDER BY block,idx').all(token,Number(target)).map(r=>{
      const l=JSON.parse(r.payload);l.blockNumber=BigInt(l.blockNumber);l.args.value=BigInt(l.args.value);return l;
    });
    return {complete:true,logs,cursor,chunks};
  } finally {db.close();}
}
