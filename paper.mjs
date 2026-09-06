import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';
import {formatUnits,parseUnits} from 'viem';
import {ROOT,blockContext,usdRates,poolFor,quoteExact,quoteUsd,client,failure} from './chain.mjs';

// Virtual USD cash; quote-derived fills with 3% execution haircut plus gas allowance.
// This is a paper execution model, not a claim that a wallet actually filled.
export function openPaper(path=resolve(ROOT,'data/paper.sqlite')) {
  const db=new DatabaseSync(path);
  db.exec('CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL)');
  const initial={cash:1000,reserve:200,halted:false,positions:[],trades:[],seen:[],realized:0,
    equity:1000,unrealized:0,model:'QUOTE_MINUS_3_PERCENT_PLUS_GAS_ALLOWANCE',created_at:Date.now()};
  db.prepare('INSERT OR IGNORE INTO state VALUES(1,?)').run(JSON.stringify(initial));
  return {db,read:()=>JSON.parse(db.prepare('SELECT payload FROM state WHERE id=1').get().payload),
    write:s=>db.prepare('UPDATE state SET payload=? WHERE id=1').run(JSON.stringify(s))};
}
export function exitReason(s,p,netValue) {
  if(s.halted)return 'risk';
  const multiple=netValue/Number(p.qty)*Number(p.initialQty)/p.cost;
  if(p.proceeds<p.cost&&multiple>=2)return 'recover';
  if(p.proceeds>=p.cost&&multiple>=10&&!p.half)return 'half';
  return null;
}
export function applyBuy(s,{token,qty,cost,block}) {
  if(s.halted||s.cash-cost<s.reserve||s.positions.length>=5||s.seen.includes(token))return false;
  if(!(cost>0&&cost<=35&&BigInt(qty)>0n))throw Error('INVALID_PAPER_BUY');
  s.cash-=cost;s.seen.push(token);
  s.positions.push({token,qty:String(qty),initialQty:String(qty),cost,remainingCost:cost,proceeds:0,half:false,opened:Date.now()});
  s.trades.push({side:'buy',token,qty:String(qty),net:cost,block:String(block),at:Date.now(),paper:true});return true;
}
export function applySell(s,p,qty,net,reason,block) {
  qty=BigInt(qty);const held=BigInt(p.qty);
  if(qty<=0n||qty>held||!Number.isFinite(net))throw Error('INVALID_PAPER_SELL');
  const allocated=p.remainingCost*Number(qty)/Number(held);
  s.cash+=net;s.realized+=net-allocated;p.remainingCost-=allocated;p.proceeds+=net;p.qty=String(held-qty);
  if(reason==='half')p.half=true;
  s.trades.push({side:'sell',token:p.token,qty:String(qty),net,reason,block:String(block),at:Date.now(),paper:true});
  s.positions=s.positions.filter(p=>BigInt(p.qty)>0n);
}
export async function paperTick(candidates=[]) {
  const store=openPaper();
  try {
    const s=store.read(),block=await blockContext(),rates=await usdRates(),gasPrice=await client.getGasPrice();
    const startTrades=s.trades.length;const marks=new Map();s.problems=[];
    const price=pool=>quoteUsd(pool,rates);
    const gas=q=>Math.max(0.25,Number(formatUnits((q.quoterGasEstimate+180000n)*gasPrice,18))*rates.prices.ethereum.usd)+0.25;
    const value=(pool,q)=>Number(formatUnits(q.amountOut,pool.quoteDecimals))*price(pool)*0.97-gas(q);
    for(const p of s.positions) {
      try{const pool=await poolFor(p.token,block.number);const q=await quoteExact(pool,p.token,BigInt(p.qty),block.number);
        marks.set(p.token,{pool,net:Math.max(0,value(pool,q))});}
      catch(e){s.problems.push({token:p.token,error:failure(e)});}
    }
    s.equity=s.problems.length?null:s.cash+[...marks.values()].reduce((a,m)=>a+m.net,0);
    if(s.equity!==null&&s.equity<=200)s.halted=true;
    store.write(s); // Persist latch before exits; unknown values freeze entries.
    for(const p of [...s.positions]) {
      const mark=marks.get(p.token);if(!mark)continue;
      const reason=exitReason(s,p,mark.net);if(!reason)continue;
      try {
        let qty=BigInt(p.qty);
        if(reason==='half')qty/=2n;
        if(reason==='recover') {
          // Binary search size-specific net quotes; no linear-price cost recovery assumption.
          let lo=1n,hi=qty;
          const target=p.cost-p.proceeds;
          for(let i=0;i<14&&lo<hi;i++) {
            const mid=(lo+hi)/2n,q=await quoteExact(mark.pool,p.token,mid,block.number);
            if(value(mark.pool,q)>=target)hi=mid;else lo=mid+1n;
          }
          qty=hi;
        }
        if(qty===0n)continue;
        const q=await quoteExact(mark.pool,p.token,qty,block.number),net=value(mark.pool,q);
        if(reason==='recover'&&net<p.cost-p.proceeds)throw Error('RECOVERY_QUOTE_BELOW_TARGET');
        applySell(s,p,qty,net,reason,block.number);store.write(s);
      }catch(e){s.problems.push({token:p.token,error:failure(e)});}
    }
    if(!s.halted&&!s.problems.length)for(const c of candidates) {
      if(c.status!=='CANDIDATE_NOT_ORDER'||s.seen.includes(c.token)||s.positions.length>=5)continue;
      // Only fresh source evidence can create a new position; no replaying old signals.
      if(Date.now()/1000-c.observed_at>180)continue;
      try {
        const pool=await poolFor(c.token,block.number);
        const amount=parseUnits((30/price(pool)).toFixed(Math.min(pool.quoteDecimals,12)),pool.quoteDecimals);
        const q=await quoteExact(pool,pool.quote,amount,block.number);
        applyBuy(s,{token:c.token,qty:q.amountOut*9700n/10000n,cost:30+gas(q),block:block.number});store.write(s);
      }catch(e){s.problems.push({token:c.token,error:failure(e)});}
    }
    // Revalue after mutations. Never retain a pre-sale mark against a reduced quantity.
    let total=s.cash,unrealized=0;
    for(const p of s.positions)try {
      const pool=await poolFor(p.token,block.number),q=await quoteExact(pool,p.token,BigInt(p.qty),block.number);
      p.mark=Math.max(0,value(pool,q));total+=p.mark;unrealized+=p.mark-p.remainingCost;
    }catch(e){p.mark=null;s.problems.push({token:p.token,error:failure(e)});}
    s.equity=s.problems.length?null:total;s.unrealized=s.problems.length?null:unrealized;
    if(s.equity!==null&&s.equity<=200)s.halted=true;
    s.updated_at=Date.now();s.block=String(block.number);store.write(s);
    return {...s,newTrades:s.trades.slice(startTrades)};
  }catch(error){
    // Preserve fills already committed, but do not display an old mark as current.
    const s=store.read();
    s.equity=null;s.unrealized=null;s.problems=[{error:failure(error)}];
    s.failed_at=Date.now();store.write(s);throw error;
  }finally{store.db.close();}
}
