import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, zeroAddress, parseUnits, formatUnits } from 'viem';
import {enabled,broadcast} from './telegram.mjs';
import { ROOT,A,client,traceClient,erc20,same,requireValue,failure,stringify,save,blockContext,
  poolFor,quoteExact,tokenDelta,usdRates } from './chain.mjs';

const dbPath=process.env.ROBINHOOD_LEDGER_DB||resolve(ROOT,'data/ledger.sqlite');
function openDb() {
  mkdirSync(resolve(ROOT,'data'),{recursive:true});
  const db=new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS accounts(wallet TEXT PRIMARY KEY,reserve_usdt TEXT NOT NULL,halted INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS fills(wallet TEXT NOT NULL,tx TEXT NOT NULL,token TEXT NOT NULL,block INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(wallet,tx));`);
  return db;
}
const micros = x => parseUnits(Number(x).toFixed(6),6);
const usdValue = (raw, decimals, unitUsd) => raw*micros(unitUsd)/(10n**BigInt(decimals));
const display = raw => formatUnits(raw,6);

export function nativeDelta(trace,wallet) {
  // Failed call trees transfer no value. DELEGATECALL/CALLCODE don't transfer value.
  if(trace.error) return 0n;
  let result=0n;
  if(['CALL','CREATE','CREATE2','SELFDESTRUCT'].includes(trace.type)) {
    const value=BigInt(trace.value||0);
    if(trace.to&&same(trace.to,wallet)) result+=value;
    if(trace.from&&same(trace.from,wallet)) result-=value;
  }
  for(const child of trace.calls||[]) result+=nativeDelta(child,wallet);
  return result;
}
function historicalRates(timestamp) {
  let names;
  try {names=readdirSync(resolve(ROOT,'data/rates'));}catch{return null;}
  const rows=names.filter(n=>n.endsWith('.json')).map(n=>JSON.parse(readFileSync(resolve(ROOT,'data/rates',n))));
  return rows.filter(row=>Object.values(row.prices).every(p=>p.last_updated_at<=timestamp&&timestamp-p.last_updated_at<=300))
    .sort((a,b)=>b.observed_at-a.observed_at)[0]||null;
}
export async function readFill(wallet,token,hash,reason='manual') {
  wallet=getAddress(wallet);token=getAddress(token);
  requireValue(['manual','entry','recover','half','risk'].includes(reason),'INVALID_REASON');
  const [receipt,transaction,head]=await Promise.all([client.getTransactionReceipt({hash}),client.getTransaction({hash}),blockContext()]);
  requireValue(receipt.blockNumber+64n<=head.number,'RECEIPT_NOT_64_BLOCKS_CONFIRMED');
  const block=await client.getBlock({blockNumber:receipt.blockNumber});
  requireValue(block.hash===receipt.blockHash,'NONCANONICAL_RECEIPT');
  requireValue(same(transaction.from,wallet)&&transaction.to&&same(transaction.to,A.router),'NOT_WALLET_ROUTER_TRANSACTION');
  const gas=receipt.gasUsed*receipt.effectiveGasPrice;
  const result={wallet,token,transaction:hash,reason,block_number:receipt.blockNumber,block_hash:receipt.blockHash,
    timestamp:block.timestamp,status:receipt.status==='success'?'RECEIPT_PENDING_ACCOUNTING':'FAILED_TRANSACTION',
    gas_paid_wei:gas,quote_delta_raw:null,token_delta_raw:tokenDelta(receipt.logs,token,wallet),
    usd_value_micros:null,gas_usd_micros:null,receipt};
  const rates=historicalRates(Number(block.timestamp));
  if(rates) result.gas_usd_micros=usdValue(gas,18,rates.prices.ethereum.usd);
  result.rates=rates;
  if(receipt.status!=='success') return result;
  const pool=await poolFor(token,receipt.blockNumber);
  result.quote_token=pool.quote;result.quote_decimals=pool.quoteDecimals;result.token_decimals=pool.decimals;
  if(pool.quote===zeroAddress) {
    try {
      requireValue(await traceClient.getChainId()===4663,'TRACE_WRONG_CHAIN');
      const traceReceipt=await traceClient.getTransactionReceipt({hash});
      requireValue(traceReceipt.blockHash===receipt.blockHash,'TRACE_RECEIPT_BLOCK_MISMATCH');
      const trace=await traceClient.request({method:'debug_traceTransaction',params:[hash,{tracer:'callTracer'}]});
      requireValue(!trace.error&&same(trace.from,wallet)&&same(trace.to,A.router),'TRACE_TRANSACTION_MISMATCH');
      result.quote_delta_raw=nativeDelta(trace,wallet);
      result.trace=trace;
    }catch(error) {
      const message=failure(error);
      result.status=/does not exist|not available|not supported|method not found/i.test(message)?'INVALID_DECLARED_GAP':'SOURCE_UNAVAILABLE';
      result.gap_field='native_quote_delta';result.gap_reason=message;
      return result;
    }
  } else result.quote_delta_raw=tokenDelta(receipt.logs,pool.quote,wallet);
  requireValue(result.token_delta_raw*result.quote_delta_raw<0n,'NOT_A_TWO_ASSET_SWAP');
  result.side=result.token_delta_raw>0n?'buy':'sell';
  requireValue(reason!=='entry'||result.side==='buy','ENTRY_REASON_ON_SELL');
  requireValue(!['recover','half','risk'].includes(reason)||result.side==='sell','EXIT_REASON_ON_BUY');
  if(rates) result.usd_value_micros=usdValue(result.quote_delta_raw,pool.quoteDecimals,
    rates.prices[pool.quote===zeroAddress?'ethereum':'global-dollar'].usd);
  result.status=rates?'CONFIRMED':'CONFIRMED_UNPRICED';
  return result;
}
export function positionsFrom(fills) {
  const positions=new Map();
  for(const fill of fills) {
    if(fill.status!=='CONFIRMED') continue;
    const key=fill.token.toLowerCase();
    const position=positions.get(key)||{token:fill.token,quantity:0n,initial_quantity:0n,cost:0n,net_proceeds:0n,half_sale_confirmed:false};
    const quantity=BigInt(fill.token_delta_raw),value=BigInt(fill.usd_value_micros),gas=BigInt(fill.gas_usd_micros);
    if(quantity>0n) {
      requireValue(position.quantity===0n,'ADD_TO_EXISTING_POSITION_NOT_SUPPORTED');
      Object.assign(position,{quantity,initial_quantity:quantity,cost:-value+gas,net_proceeds:0n,half_sale_confirmed:false});
    } else {
      requireValue(position.quantity>=-quantity,'SELL_WITHOUT_RECONCILED_ENTRY');
      if(fill.reason==='half') requireValue(-quantity===position.quantity/2n,'HALF_REASON_QUANTITY_MISMATCH');
      position.quantity+=quantity;position.net_proceeds+=value-gas;
      if(fill.reason==='half') position.half_sale_confirmed=true;
    }
    positions.set(key,position);
  }
  return [...positions.values()].filter(p=>p.quantity>0n);
}
function accountRows(db,wallet) {
  const account=db.prepare('SELECT * FROM accounts WHERE wallet=?').get(wallet.toLowerCase());
  requireValue(account,'ACCOUNT_NOT_INITIALIZED');
  const fills=db.prepare('SELECT payload FROM fills WHERE wallet=? ORDER BY block,tx').all(wallet.toLowerCase())
    .map(row=>JSON.parse(row.payload)).sort((a,b)=>Number(a.block_number)-Number(b.block_number)||a.receipt.transactionIndex-b.receipt.transactionIndex);
  return {account,fills};
}
export async function snapshot(wallet) {
  wallet=getAddress(wallet);
  const db=openDb();
  try {
    const {account,fills}=accountRows(db,wallet);
    // Reorgs invalidate the report. Never silently retain a noncanonical fill.
    for(const fill of fills) requireValue((await client.getBlock({blockNumber:BigInt(fill.block_number)})).hash===fill.block_hash,'LEDGER_REORG');
    const block=await blockContext(),rates=await usdRates(),ethPrice=rates.prices.ethereum.usd;
    const native=await client.getBalance({address:wallet,blockNumber:block.number});
    const usdg=await client.readContract({address:A.usdg,abi:erc20,functionName:'balanceOf',args:[wallet],blockNumber:block.number});
    const usdgDecimals=await client.readContract({address:A.usdg,abi:erc20,functionName:'decimals',blockNumber:block.number});
    const protectedUsd=usdValue(parseUnits(account.reserve_usdt,6),6,rates.prices.tether.usd);
    const cashUsd=usdValue(native,18,ethPrice)+usdValue(usdg,usdgDecimals,rates.prices['global-dollar'].usd);
    let equity=protectedUsd+cashUsd;
    const initial=micros(1000*rates.prices.tether.usd),lossLimit=micros(800*rates.prices.tether.usd);
    const incomplete=fills.filter(f=>!['CONFIRMED','FAILED_TRANSACTION'].includes(f.status));
    const positions=positionsFrom(fills),marks=[],problems=incomplete.map(f=>`${f.transaction}:${f.status}`);
    const gasPrice=await client.getGasPrice();
    for(const position of positions) {
      try {
        const pool=await poolFor(position.token,block.number);
        const balance=await client.readContract({address:pool.token,abi:erc20,functionName:'balanceOf',args:[wallet],blockNumber:block.number});
        requireValue(balance===position.quantity,'WALLET_LEDGER_QUANTITY_MISMATCH');
        const quote=await quoteExact(pool,pool.token,position.quantity,block.number);
        const price=rates.prices[pool.quote===zeroAddress?'ethereum':'global-dollar'].usd;
        // Conservative mark, not a promised liquidation value; L1 fee still needs a transaction estimate.
        const exitGas=usdValue((quote.quoterGasEstimate+150000n)*gasPrice,18,ethPrice);
        const value=usdValue(quote.amountOut*9700n/10000n,pool.quoteDecimals,price)-exitGas;
        const mark=value>0n?value:0n;
        equity+=mark;
        const multiple=position.cost>0n?Number(mark*position.initial_quantity*10000n/(position.cost*position.quantity))/10000:0;
        let action='HOLD';
        if(position.net_proceeds<position.cost && multiple>=2) action='REQUOTE_RECOVER_COST';
        else if(position.net_proceeds>=position.cost && multiple>=10 && !position.half_sale_confirmed) action='REQUOTE_HALF_REMAINING';
        marks.push({...position,estimated_liquidation_usd:display(mark),reference_multiple:multiple,action});
      }catch(error){problems.push(`${position.token}:${failure(error)}`);}
    }
    // With an unknown asset value, persist an incomplete result and forbid new entries.
    const complete=problems.length===0;
    const loss=complete?(initial>equity?initial-equity:0n):null;
    const halted=Boolean(account.halted)||(loss!==null&&loss>=lossLimit);
    if(halted) db.prepare('UPDATE accounts SET halted=1 WHERE wallet=?').run(wallet.toLowerCase());
    if(halted) marks.forEach(p=>p.action='REQUOTE_EXIT_ALL');
    const reserveInside=micros(200*rates.prices.tether.usd)>protectedUsd?micros(200*rates.prices.tether.usd)-protectedUsd:0n;
    const available=cashUsd>reserveInside?cashUsd-reserveInside:0n;
    const cap=micros(30*rates.prices.tether.usd);
    const budget=!complete||halted||positions.length>=5?0n:(available<cap?available:cap);
    const result={wallet,mode:'READ_ONLY_ACCOUNT',block_number:block.number,rates,accounting_complete:complete,problems,
      halted,net_loss_usd:loss===null?null:display(loss),equity_usd:complete?display(equity):null,
      cash_usd:display(cashUsd),declared_protected_usdt:account.reserve_usdt,new_buy_budget_usd:display(budget),
      send_allowed:false,positions:marks,note:'Dedicated wallet only; top-ups/withdrawals not supported. External reserve is user-declared. Marks include estimated execution cost, not guaranteed fills.'};
    save(resolve(ROOT,'data/account-latest.json'),result);
    if(enabled()&&halted) await broadcast(`halt:${wallet}`,'🛑 Robinhood 账户停止新增买入\n账户：'+wallet+'\n净亏损 USD：'+result.net_loss_usd+'\n请检查持仓退出；未自动发送卖单。');
    return result;
  } finally {db.close();}
}
async function main() {
  const [command,walletArg,tokenOrReserve,tx,reason]=process.argv.slice(2);
  requireValue(walletArg,'Usage: node ledger.mjs init WALLET RESERVE_USDT | record WALLET TOKEN TX [REASON] | account WALLET');
  const wallet=getAddress(walletArg);
  if(command==='account') {console.log(stringify(await snapshot(wallet)));return;}
  const db=openDb();
  try {
    if(command==='init') {
      requireValue(tokenOrReserve!==undefined,'EXPLICIT_EXTERNAL_RESERVE_REQUIRED');
      const reserve=parseUnits(tokenOrReserve,6);
      requireValue(reserve>=0n&&reserve<=parseUnits('200',6),'RESERVE_MUST_BE_0_TO_200_USDT');
      db.prepare('INSERT INTO accounts(wallet,reserve_usdt) VALUES (?,?)').run(wallet.toLowerCase(),formatUnits(reserve,6));
      console.log('Account initialized; no wallet transaction sent.');
    } else if(command==='record') {
      const {fills}=accountRows(db,wallet);
      const existing=fills.find(f=>f.transaction===tx);
      if(existing?.status==='CONFIRMED') {
        requireValue(same(existing.token,tokenOrReserve)&&existing.reason===(reason||'manual'),'CONFIRMED_FILL_IS_IMMUTABLE');
        console.log(stringify(existing));return;
      }
      const result=await readFill(wallet,tokenOrReserve,tx,reason);
      const previous=fills.find(f=>f.transaction===tx);
      requireValue(!previous||same(previous.token,result.token),'TX_ALREADY_ASSIGNED_TO_ANOTHER_TOKEN');
      // Validate position sequence before replacing a previously incomplete receipt.
      const proposed=[...fills.filter(f=>f.transaction!==tx),result]
        .sort((a,b)=>Number(a.block_number)-Number(b.block_number)||a.receipt.transactionIndex-b.receipt.transactionIndex);
      positionsFrom(proposed);
      db.prepare('INSERT OR REPLACE INTO fills VALUES (?,?,?,?,?)').run(wallet.toLowerCase(),tx,result.token,Number(result.block_number),stringify(result));
      if(enabled()) await broadcast(`receipt:${wallet}:${tx}:${result.status}`,
        `📒 Robinhood 收据记账\n状态：${result.status}\n方向：${result.side||'未确认'}\n代币：${result.token}\n交易：${tx}\n仅依据链上收据；未将报价记为成交。`);
      console.log(stringify(result));
    } else throw new Error('UNKNOWN_COMMAND');
  } finally {db.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(e=>{console.error(failure(e));process.exitCode=1;});
