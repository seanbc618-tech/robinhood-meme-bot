import { createPublicClient, http, parseAbi, parseAbiParameters, encodeAbiParameters,
  encodeFunctionData, decodeFunctionResult, decodeEventLog, keccak256, zeroAddress, custom,
  parseUnits, formatUnits, toFunctionSelector, getAddress } from 'viem';
import { createRequire } from 'node:module';
// The SDK's ESM bundle uses extensionless directory imports; use its supported CJS export.
const { Actions, V4Planner, URVersion } = createRequire(import.meta.url)('@uniswap/v4-sdk');
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {enabled,broadcast,marketMessage} from './telegram.mjs';
import {transferHistory} from './holder-history.mjs';

export const ROOT = dirname(fileURLToPath(import.meta.url));
// Local secrets are ignored by git. Explicit environment variables take precedence.
try {
  for(const line of readFileSync(resolve(ROOT,'.env.rpc'),'utf8').split('\n')) {
    const at=line.indexOf('=');
    if(at>0 && !line.startsWith('#')) {
      const key=line.slice(0,at).trim();
      if(['ROBINHOOD_RPC_URL','ROBINHOOD_LOG_RPC_URL','ROBINHOOD_TRACE_RPC_URL','ROBINHOOD_WALLET'].includes(key)
        && process.env[key]===undefined) process.env[key]=line.slice(at+1).trim();
    }
  }
} catch(error) {if(error.code!=='ENOENT') throw error;}
export const A = {
  factory: '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e',
  hook: '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044',
  manager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
  state: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
  router: '0x8876789976decbfcbbbe364623c63652db8c0904',
  permit2: '0x000000000022d473030f116ddee9f6b43ac78ba3',
  usdg: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
};
const readTransport = http(
  process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
  { retryCount: 0, timeout: 20000, fetchOptions: { headers: { 'User-Agent': 'rh-dog-bot/0.2' } } })({});
const logTransport=http(process.env.ROBINHOOD_LOG_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',{
  retryCount:0,timeout:8000,fetchOptions:{headers:{'User-Agent':'rh-dog-bot/0.2'}}
})({});
const alchemyLogTransport=process.env.ROBINHOOD_RPC_URL
  ?http(process.env.ROBINHOOD_RPC_URL,{retryCount:0,timeout:6000,fetchOptions:{headers:{'User-Agent':'rh-dog-bot/0.2'}}})({})
  :null;
const backupLogTransport=process.env.ROBINHOOD_TRACE_RPC_URL
  ?http(process.env.ROBINHOOD_TRACE_RPC_URL,{retryCount:0,timeout:4000})({}):null;
let backupLogsUntil=0;
let solidDisabledUntil=0;
const ALCHEMY_LOG_CHUNK=10n;
const ALCHEMY_MAX_FALLBACK_RANGE=900n;
export const logRpcHealth={public_failures:0,backup_successes:0,alchemy_successes:0,solid_quota_exhausted:0,last_failure:null,last_provider:null};
function errorText(error) { return String(error?.shortMessage||error?.message||error); }
function quotaError(error) { return /402|quota|daily.?response.?quota|too many requests/i.test(errorText(error)); }
function nextUtcReset() {
  const d=new Date(); d.setUTCHours(24,0,0,0); return d.getTime();
}
function noteLogFailure(provider,error,args) {
  const p=args.params?.[0]||{};
  logRpcHealth.last_failure={provider,method:args.method,from:p.fromBlock,to:p.toBlock,address:p.address,at:Date.now(),code:error.code??error.cause?.code??null,error:errorText(error).slice(0,180)};
}
async function alchemyLogRequest(args) {
  if(!alchemyLogTransport) throw new Error('ALCHEMY_LOG_UNAVAILABLE');
  const params=args.params||[];
  const filter=params[0]||{};
  if(filter.fromBlock==null||filter.toBlock==null) return alchemyLogTransport.request(args);
  const from=BigInt(filter.fromBlock),to=BigInt(filter.toBlock);
  if(to<from) return [];
  if(to-from+1n>ALCHEMY_MAX_FALLBACK_RANGE) throw new Error('ALCHEMY_LOG_RANGE_TOO_LARGE');
  const out=[];
  for(let lo=from;lo<=to;lo+=ALCHEMY_LOG_CHUNK) {
    const hi=lo+ALCHEMY_LOG_CHUNK-1n<to?lo+ALCHEMY_LOG_CHUNK-1n:to;
    const chunk={...filter,fromBlock:`0x${lo.toString(16)}`,toBlock:`0x${hi.toString(16)}`};
    out.push(...await alchemyLogTransport.request({...args,params:[chunk,...params.slice(1)]}));
  }
  return out;
}
async function logRequest(args) {
  const now=Date.now();
  const preferSolid=backupLogTransport&&now<backupLogsUntil&&now>=solidDisabledUntil;
  const providers=[];
  if(preferSolid) providers.push(['solid',backupLogTransport]);
  providers.push(['public',logTransport]);
  if(!preferSolid&&backupLogTransport&&now>=solidDisabledUntil) providers.push(['solid',backupLogTransport]);
  if(alchemyLogTransport) providers.push(['alchemy',{request:alchemyLogRequest}]);
  let last;
  for(const [provider,transport] of providers) {
    try {
      const result=await transport.request(args);
      if(provider==='solid') logRpcHealth.backup_successes++;
      if(provider==='alchemy') logRpcHealth.alchemy_successes++;
      logRpcHealth.last_provider=provider;
      return result;
    } catch(error) {
      last=error;noteLogFailure(provider,error,args);
      if(provider==='public') {
        logRpcHealth.public_failures++;
        backupLogsUntil=Date.now()+300000;
      }
      if(provider==='solid'&&quotaError(error)) {
        solidDisabledUntil=nextUtcReset();
        logRpcHealth.solid_quota_exhausted++;
      }
    }
  }
  throw last||new Error('RPC_LOG_UNAVAILABLE');
}
export const client=createPublicClient({transport:custom({request:args=>
  args.method==='eth_getLogs'?logRequest(args):readTransport.request(args)}, {retryCount:0})});
export const traceClient=createPublicClient({transport:http(
  process.env.ROBINHOOD_TRACE_RPC_URL || process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
  {retryCount:0,timeout:30000})});
export const erc20 = parseAbi([
  'function decimals() view returns (uint8)', 'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)', 'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
export const factoryAbi = parseAbi([
  'function getLaunchedToken(address) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))',
  'function memeHook() view returns (address)', 'function poolManager() view returns (address)',
  'function locker() view returns (address)',
  'event PoolGraduated(address indexed token, uint256 positionId, uint256 tokenAmount, uint256 pairTokenAmount)',
]);
const poolKeyType = '(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';
const quoterAbi = parseAbi([`function quoteExactInputSingle((${poolKeyType} poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)`]);
const stateAbi = parseAbi(['function getSlot0(bytes32) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)', 'function getLiquidity(bytes32) view returns (uint128)']);
export const hookAbi = parseAbi(['function factory() view returns (address)',
  'function launches(bytes32) view returns (bool registered,bool memecoinIsCurrency0,address memecoin,address quoteToken,address creator,address buybackCreatorRecipient,address protocolFeeRecipient,uint16 creatorTaxBps,uint16 protocolFeeShareBps,uint16 buybackBurnBps,uint16 hookFeeBps,uint16 maxInternalPriceImpactBps,bool buybackEnabled)',
  'event PoolRegistered(bytes32 indexed poolId,address memecoin,address quoteToken,address creator)']);
export const swapEvent = parseAbi(['event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)'])[0];
const routerAbi = parseAbi(['function execute(bytes commands,bytes[] inputs,uint256 deadline) payable']);
const permitAbi = parseAbi(['function approve(address token,address spender,uint160 amount,uint48 expiration)']);
export const stringify = data => JSON.stringify(data, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
export function save(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path + '.tmp', stringify(data) + '\n'); renameSync(path + '.tmp', path);
}
export function failure(error) {
  return String(error.shortMessage || error.message).replace(/https?:\/\/[^\s]+/g,'[RPC URL redacted]')
    .replace(/(?:ak_|alch_)[a-zA-Z0-9_-]+/g,'[key redacted]').slice(0,400);
}
export function requireValue(ok, message) { if (!ok) throw new Error(message); }
export const same = (a, b) => a.toLowerCase() === b.toLowerCase();

export async function blockContext() {
  requireValue(await client.getChainId() === 4663, 'WRONG_CHAIN');
  const block = await client.getBlock();
  requireValue(Math.abs(Date.now()/1000 - Number(block.timestamp)) <= 120, 'SOURCE_STALE');
  return block;
}
export async function checkDeployment(blockNumber) {
  const hashes = {};
  for (const name of ['factory','hook','manager','quoter','state','router','permit2']) {
    const code = await client.getCode({address: A[name], blockNumber});
    requireValue(code && code !== '0x', `NO_CODE:${name}`);
    hashes[name] = keccak256(code);
    if (name === 'router') requireValue(code.includes(toFunctionSelector('V4TooLittleReceivedPerHopSingle(uint256,uint256)').slice(2)), 'ROUTER_ABI_VERSION_UNVERIFIED');
  }
  for (const [fn, target] of [['memeHook',A.hook],['poolManager',A.manager]]) {
    requireValue(same(await client.readContract({address:A.factory,abi:factoryAbi,functionName:fn,blockNumber}),target), `FACTORY_WIRING:${fn}`);
  }
  requireValue(same(await client.readContract({address:A.hook,abi:hookAbi,functionName:'factory',blockNumber}),A.factory), 'HOOK_FACTORY_MISMATCH');
  return {block_number:blockNumber, code_hashes:hashes, status:'WIRING_AND_ABI_CHECKED_NOT_BYTECODE_SOURCE_MATCHED'};
}

export async function poolFor(token, blockNumber) {
  token = getAddress(token);
  const launch = await client.readContract({address:A.factory,abi:factoryAbi,functionName:'getLaunchedToken',args:[token],blockNumber});
  requireValue(launch.exists && same(launch.token,token),'NOT_PONS_V2');
  requireValue(launch.phase === 2,'NOT_POOL_REGISTERED');
  const quote = launch.pairToken.toLowerCase();
  // Other quote assets remain observed, but no unimplemented route is invented.
  requireValue(quote === zeroAddress || quote === A.usdg,'QUOTE_ASSET_NOT_IMPLEMENTED');
  const sorted = [token.toLowerCase(),quote].sort();
  const key = {currency0:sorted[0],currency1:sorted[1],fee:launch.poolFee,tickSpacing:launch.tickSpacing,hooks:A.hook};
  const id = keccak256(encodeAbiParameters(parseAbiParameters(poolKeyType),[key]));
  const hook = await client.readContract({address:A.hook,abi:hookAbi,functionName:'launches',args:[id],blockNumber});
  requireValue(hook[0] && same(hook[2],token) && same(hook[3],quote),'HOOK_POOL_MISMATCH');
  const slot = await client.readContract({address:A.state,abi:stateAbi,functionName:'getSlot0',args:[id],blockNumber});
  const liquidity = await client.readContract({address:A.state,abi:stateAbi,functionName:'getLiquidity',args:[id],blockNumber});
  requireValue(slot[0] > 0n && liquidity > 0n,'EMPTY_POOL');
  const decimals = await client.readContract({address:token,abi:erc20,functionName:'decimals',blockNumber});
  const quoteDecimals = quote === zeroAddress ? 18 : await client.readContract({address:quote,abi:erc20,functionName:'decimals',blockNumber});
  return {token,launch,key,id,quote,decimals,quoteDecimals,liquidity,sqrtPriceX96:slot[0],hookFeeBps:hook[10],creatorTaxBps:hook[7]};
}

export async function quoteExact(pool, tokenIn, amount, blockNumber) {
  requireValue(amount > 0n && amount < 2n ** 128n,'INVALID_AMOUNT');
  requireValue(same(tokenIn,pool.key.currency0) || same(tokenIn,pool.key.currency1),'TOKEN_OUTSIDE_POOL');
  const {result} = await client.simulateContract({address:A.quoter,abi:quoterAbi,functionName:'quoteExactInputSingle',
    args:[{poolKey:pool.key,zeroForOne:same(tokenIn,pool.key.currency0),exactAmount:amount,hookData:'0x'}],blockNumber});
  requireValue(result[0] > 0n,'ZERO_QUOTE');
  return {amountIn:amount,amountOut:result[0],quoterGasEstimate:result[1],blockNumber};
}

export function swapCall(pool, tokenIn, amountIn, minOut, account, deadline) {
  requireValue(amountIn > 0n && minOut > 0n,'NONPOSITIVE_SWAP_BOUND');
  const tokenOut = same(tokenIn,pool.token) ? pool.quote : pool.token;
  const planner = new V4Planner();
  planner.addAction(Actions.SWAP_EXACT_IN_SINGLE, [{poolKey:pool.key,
    zeroForOne:same(tokenIn,pool.key.currency0),amountIn:amountIn.toString(),
    amountOutMinimum:minOut.toString(),minHopPriceX36:'0',hookData:'0x'}],URVersion.V2_1_1);
  planner.addAction(Actions.SETTLE_ALL,[tokenIn,amountIn.toString()]);
  planner.addAction(Actions.TAKE_ALL,[tokenOut,minOut.toString()]);
  return {account,to:A.router,value:same(tokenIn,zeroAddress) ? amountIn : 0n,
    data:encodeFunctionData({abi:routerAbi,functionName:'execute',args:['0x10',[planner.finalize()],deadline]})};
}
function approvals(token, amount, account, deadline) {
  if (same(token,zeroAddress)) return [];
  return [
    {account,to:token,data:encodeFunctionData({abi:erc20,functionName:'approve',args:[A.permit2,amount]})},
    {account,to:A.permit2,data:encodeFunctionData({abi:permitAbi,functionName:'approve',args:[token,A.router,amount,Number(deadline)]})},
  ];
}
export function tokenDelta(logs, token, wallet) {
  let delta = 0n;
  for (const log of logs || []) {
    if (!same(log.address,token)) continue;
    let event;
    try { event = decodeEventLog({abi:erc20,data:log.data,topics:log.topics}); } catch { continue; }
    if (event.eventName !== 'Transfer') continue;
    if (same(event.args.to,wallet)) delta += event.args.value;
    if (same(event.args.from,wallet)) delta -= event.args.value;
  }
  return delta;
}

export async function roundTrip(pool, amountIn, block, suppliedAccount) {
  const account = getAddress(suppliedAccount || '0x00000000000000000000000000000000000a11ce');
  const synthetic = !suppliedAccount;
  requireValue(!synthetic || pool.quote === zeroAddress, 'ERC20_SIMULATION_REQUIRES_FUNDED_ACCOUNT');
  const buy = await quoteExact(pool,pool.quote,amountIn,block.number);
  const minBuy = buy.amountOut * 9700n / 10000n;
  const deadline = block.timestamp + 300n;
  const firstCalls = [...approvals(pool.quote,amountIn,account,deadline),swapCall(pool,pool.quote,amountIn,minBuy,account,deadline)];
  const stateOverrides = synthetic ? [{address:account,balance:parseUnits('1',18)}] : undefined;
  // Calls share state within a simulation. Never use three unrelated eth_call requests.
  const first = await client.simulateCalls({account,calls:firstCalls,blockNumber:block.number,stateOverrides});
  requireValue(first.results.every(r=>r.status==='success'),'BUY_SIMULATION_REVERT');
  const received = tokenDelta(first.results.at(-1).logs,pool.token,account);
  requireValue(received >= minBuy,'BUY_TRANSFER_AMOUNT_MISMATCH');
  const sell = await quoteExact(pool,pool.token,received,block.number);
  const minSell = sell.amountOut * 9700n / 10000n;
  const calls = [...firstCalls,...approvals(pool.token,received,account,deadline),swapCall(pool,pool.token,received,minSell,account,deadline)];
  const simulation = await client.simulateCalls({account,calls,blockNumber:block.number,stateOverrides,traceAssetChanges:true});
  requireValue(simulation.results.every(r=>r.status==='success'),'ROUND_TRIP_SIMULATION_REVERT');
  requireValue(tokenDelta(simulation.results[firstCalls.length-1].logs,pool.token,account)===received,'SIMULATED_BUY_CHANGED');
  const sold = -tokenDelta(simulation.results.at(-1).logs,pool.token,account);
  requireValue(sold===received,'SIMULATED_SELL_QUANTITY_MISMATCH');
  const quoteChange = simulation.assetChanges.find(a=>same(a.token.address,pool.quote)
    || (pool.quote===zeroAddress && same(a.token.address,'0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')));
  requireValue(quoteChange,'SIMULATED_QUOTE_BALANCE_MISSING');
  const returned = amountIn + quoteChange.value.diff;
  const gasUsed = simulation.results.reduce((a,r)=>a+r.gasUsed,0n);
  const gasPrice = await client.getGasPrice();
  return {status:'SIMULATED_NOT_FILLED',account,synthetic_funding:synthetic,block_number:block.number,
    amount_in:amountIn,token_received:received,token_sold:sold,quote_returned:returned,
    round_trip_loss_bps:Number((amountIn-returned)*10000n/amountIn),gas_used:gasUsed,
    estimated_execution_gas_wei:gasUsed*gasPrice,gas_note:'execution estimate; future L1 data fee and market movement excluded',
    buy_quote:buy,sell_quote:sell,calls,results:simulation.results.map(r=>({status:r.status,gasUsed:r.gasUsed,logs:r.logs})),
    asset_changes:simulation.assetChanges};
}

export async function usdRates() {
  const url='https://api.coingecko.com/api/v3/simple/price?ids=ethereum,tether,global-dollar&vs_currencies=usd&include_last_updated_at=true';
  // Use installed curl for macOS proxy/CA support; no TLS bypass or silent retry.
  const {stdout}=await promisify(execFile)('curl',['--fail','--silent','--show-error','--max-time','20',url]);
  const raw=JSON.parse(stdout);
  for (const key of ['ethereum','tether','global-dollar']) {
    requireValue(raw[key] && Number.isFinite(raw[key].usd) && raw[key].usd>0,'USD_SOURCE_MISSING');
    requireValue(Math.abs(Date.now()/1000-raw[key].last_updated_at)<=300,'USD_SOURCE_STALE');
  }
  const result={source:url,observed_at:Math.floor(Date.now()/1000),prices:raw};
  save(resolve(ROOT,'data/rates',`${result.observed_at}.json`),result);
  return result;
}
export function quoteUsd(pool,rates) {
  return rates.prices[pool.quote===zeroAddress?'ethereum':'global-dollar'].usd;
}
export async function blockAtTime(timestamp, head) {
  let low=head.number>20000n?head.number-20000n:0n, high=head.number;
  const first=await client.getBlock({blockNumber:low});
  requireValue(first.timestamp<=timestamp,'WINDOW_NOT_COVERED');
  while (low<high) {
    const mid=(low+high)/2n;
    if ((await client.getBlock({blockNumber:mid})).timestamp<timestamp) low=mid+1n;
    else high=mid;
  }
  return low;
}
export async function warmHolderHistory(token,blockNumber,options={}) {
  return transferHistory(client,erc20.find(a=>a.name==='Transfer'),token,blockNumber,{
    path:resolve(ROOT,'data/holder-history.sqlite'),...options,
  });
}
export async function holderData(pool, blockNumber) {
  const history=await warmHolderHistory(pool.token,blockNumber);
  requireValue(history.complete,'HOLDER_HISTORY_WARMUP');
  const logs=history.logs;
  requireValue(logs.length>0,'TRANSFER_HISTORY_EMPTY');
  const balances=new Map(); let minted=false;
  for (const log of logs) {
    requireValue(!log.removed,'REMOVED_TRANSFER');
    const {from,to,value}=log.args;
    if (same(from,zeroAddress)) minted=true;
    else balances.set(from.toLowerCase(),(balances.get(from.toLowerCase())||0n)-value);
    if (!same(to,zeroAddress)) balances.set(to.toLowerCase(),(balances.get(to.toLowerCase())||0n)+value);
  }
  requireValue(minted && [...balances.values()].every(v=>v>=0n),'TRANSFER_HISTORY_INCOMPLETE');
  const supply=await client.readContract({address:pool.token,abi:erc20,functionName:'totalSupply',blockNumber});
  requireValue([...balances.values()].reduce((a,b)=>a+b,0n)===supply,'TRANSFER_SUPPLY_MISMATCH');
  const locker=await client.readContract({address:A.factory,abi:factoryAbi,functionName:'locker',blockNumber});
  const infrastructure=new Set([zeroAddress,A.manager,A.router,A.hook,locker.toLowerCase(),pool.launch.curve.toLowerCase(),A.factory,A.permit2]);
  const holders=[...balances].filter(([a,v])=>v>0n&&!infrastructure.has(a)).sort((a,b)=>a[1]>b[1]?-1:a[1]<b[1]?1:0);
  const circulating=holders.reduce((sum,[,qty])=>sum+qty,0n);
  requireValue(circulating>0n,'NO_CIRCULATING_HOLDERS');
  // Cross-check leaders against live balances at the same block, not another timestamp.
  for (const [address,quantity] of holders.slice(0,10)) {
    requireValue(await client.readContract({address:pool.token,abi:erc20,functionName:'balanceOf',args:[address],blockNumber})===quantity,'HOLDER_BALANCE_MISMATCH');
  }
  const top10=holders.slice(0,10).reduce((a,[,v])=>a+v,0n);
  return {logs,infrastructure,summary:{holder_count:holders.length,top10_circulating_bps:Number(top10*10000n/circulating),
    top10_total_supply_bps:Number(top10*10000n/supply),circulating_raw:circulating,total_supply_raw:supply,
    deployer_balance_raw:balances.get(pool.launch.deployer.toLowerCase())||0n,
    birth_block:logs[0].blockNumber,transfer_count:logs.length,method:'genesis-to-block transfers, supply and top balances cross-checked',
    top10:holders.slice(0,10).map(([address,quantity])=>({address,quantity}))}};
}
async function marketData(pool,block,window,rates,holders) {
  const swaps=await client.getLogs({address:A.manager,event:swapEvent,args:{id:pool.id},fromBlock:window.older,toBlock:block.number,strict:true});
  let buys=0,sells=0,currentQuote=0,priorQuote=0,netQuote=0;
  const buyerRecipients=new Set();
  for (const swap of swaps) {
    if (same(swap.args.sender,A.hook)) continue; // Internal fee conversion is not external demand.
    const token0=same(pool.token,pool.key.currency0);
    const tokenAmount=token0?swap.args.amount0:swap.args.amount1;
    const quoteAmount=token0?swap.args.amount1:swap.args.amount0;
    const volume=Math.abs(Number(formatUnits(quoteAmount,pool.quoteDecimals)));
    if (swap.blockNumber<window.recent) {priorQuote+=volume;continue;}
    currentQuote+=volume;
    // V4 deltas are from the caller's perspective: positive token = bought token.
    if (tokenAmount>0n && quoteAmount<0n) {
      buys++;netQuote+=volume;
      // Recipient identities, not router addresses or an asserted number of people.
      const deltas=new Map();
      for (const transfer of holders.logs.filter(l=>l.transactionHash===swap.transactionHash)) {
        for(const [a,sign] of [[transfer.args.to,1n],[transfer.args.from,-1n]])
          deltas.set(a.toLowerCase(),(deltas.get(a.toLowerCase())||0n)+sign*transfer.args.value);
      }
      for(const [a,v] of deltas) if(v>0n&&!holders.infrastructure.has(a)) buyerRecipients.add(a);
    } else if(tokenAmount<0n&&quoteAmount>0n) {sells++;netQuote-=volume;}
  }
  const price=quoteUsd(pool,rates);
  return {buys_5m:buys,sells_5m:sells,unique_buy_recipients_5m:buyerRecipients.size,
    volume_usd_5m:currentQuote*price,previous_volume_usd_5m:priorQuote*price,net_buy_usd_5m:netQuote*price,
    volume_acceleration:priorQuote>0?currentQuote/priorQuote:null,
    swap_count:swaps.length,window_from:window.older,window_recent_from:window.recent,
    method:'pool Swap quote leg; USD mark excludes hook tax and gas; recipients can be contracts or sybils'};
}
export async function analyze(token,block,rates,window) {
  const result={token,status:'INCOMPLETE',buy_allowed:false,block_number:block.number,block_hash:block.hash,
    observed_at:Math.floor(Date.now()/1000),reasons:[]};
  try {
    const pool=await poolFor(token,block.number);
    result.pool=pool;
    const holders=await holderData(pool,block.number);
    result.holders=holders.summary;
    result.market=await marketData(pool,block,window,rates,holders);
    const symbol=await client.readContract({address:pool.token,abi:erc20,functionName:'symbol',blockNumber:block.number});
    result.symbol=symbol;
    const amount=parseUnits((30/quoteUsd(pool,rates)).toFixed(Math.min(pool.quoteDecimals,12)),pool.quoteDecimals);
    const quote=await quoteExact(pool,pool.quote,amount,block.number);
    const small=await quoteExact(pool,pool.quote,amount/10n,block.number);
    result.quote=quote;
    result.size_impact_bps=Number((small.amountOut*10n-quote.amountOut)*10000n/(small.amountOut*10n));
    const m=result.market,h=result.holders;
    if (/official|airdrop|teneo/i.test(symbol)) result.reasons.push('NAME_VETO');
    if (h.holder_count<15) result.reasons.push('FEWER_THAN_15_HOLDERS');
    if (h.top10_circulating_bps>6000) result.reasons.push('TOP10_OVER_60_PERCENT_CIRCULATING');
    if (m.buys_5m<10||m.sells_5m<2||m.unique_buy_recipients_5m<8) result.reasons.push('INSUFFICIENT_TWO_WAY_ACTIVITY');
    if (m.volume_usd_5m<1000||m.net_buy_usd_5m<=0) result.reasons.push('WEAK_VOLUME_OR_NET_FLOW');
    if (m.volume_acceleration===null||m.volume_acceleration<1.3) result.reasons.push('NO_CONFIRMED_VOLUME_ACCELERATION');
    if (result.size_impact_bps>300) result.reasons.push('ORDER_SIZE_IMPACT_OVER_3_PERCENT');
    result.score=Math.log1p(m.volume_usd_5m)*m.unique_buy_recipients_5m*Math.max(0,m.net_buy_usd_5m/Math.max(1,m.volume_usd_5m));
    if (!result.reasons.length) {
      result.simulation=await roundTrip(pool,amount,block);
      const executionGasUsd=Number(formatUnits(result.simulation.estimated_execution_gas_wei,18))*rates.prices.ethereum.usd;
      result.estimated_round_trip_cost_usd=30*result.simulation.round_trip_loss_bps/10000+executionGasUsd;
      if (result.estimated_round_trip_cost_usd>4.5) result.reasons.push('ESTIMATED_ROUND_TRIP_COST_OVER_15_PERCENT');
    }
    result.status=result.reasons.length?'REJECTED':'CANDIDATE_NOT_ORDER';
  } catch(error) {
    result.status='DATA_OR_ROUTE_UNAVAILABLE';result.reasons.push(failure(error));
  }
  return result;
}
export async function discover(limit=5,notify=true) {
  requireValue(Number.isInteger(limit)&&limit>=1&&limit<=20,'LIMIT_MUST_BE_1_TO_20');
  const block=await blockContext();
  const deployment=await checkDeployment(block.number);
  const rates=await usdRates();
  const window={older:await blockAtTime(block.timestamp-600n,block),recent:await blockAtTime(block.timestamp-300n,block)};
  const from=block.number>10000n?block.number-10000n:0n;
  const registrations=await client.getLogs({address:A.hook,event:hookAbi.find(a=>a.name==='PoolRegistered'),fromBlock:from,toBlock:block.number,strict:true});
  // Preserve discovery evidence even when a later source or candidate fails.
  save(resolve(ROOT,'data/registrations-latest.json'),{from_block:from,to_block:block.number,registrations});
  const tokens=[...new Set(registrations.reverse().map(l=>l.args.memecoin))];
  const candidates=[];
  for (const token of tokens.slice(0,limit)) {
    candidates.push(await analyze(token,block,rates,window));
    save(resolve(ROOT,'data/market-latest.json'),{mode:'READ_ONLY',deployment,rates,window,
      discovery_from:from,discovery_to:block.number,discovered:tokens.length,processed:candidates.length,candidates});
  }
  candidates.sort((a,b)=>(b.score||0)-(a.score||0));
  const result={mode:'READ_ONLY',deployment,rates,window,discovery_from:from,discovery_to:block.number,
    discovered:tokens.length,processed:candidates.length,candidates};
  save(resolve(ROOT,'data/market-latest.json'),result);
  if(notify && enabled()) await broadcast(`market:${block.number}`,marketMessage(result));
  return result;
}

async function main() {
  const [command,token,amount='0.005',account] = process.argv.slice(2);
  if (command==='discover') {console.log(stringify(await discover(token===undefined?5:Number(token))));return;}
  const block = await blockContext();
  if (command==='check') { console.log(stringify(await checkDeployment(block.number))); return; }
  if (command==='analyze') {
    await checkDeployment(block.number);
    const rates=await usdRates();
    const window={older:await blockAtTime(block.timestamp-600n,block),recent:await blockAtTime(block.timestamp-300n,block)};
    const result=await analyze(token,block,rates,window);
    save(resolve(ROOT,'data/analyze-latest.json'),{rates,...result});console.log(stringify(result));return;
  }
  requireValue(['quote','simulate'].includes(command),'Usage: node chain.mjs check | discover [LIMIT] | quote TOKEN AMOUNT | simulate TOKEN AMOUNT [ACCOUNT]');
  await checkDeployment(block.number);
  const pool = await poolFor(token,block.number);
  const raw = parseUnits(amount,pool.quoteDecimals);
  const result = command==='simulate' ? await roundTrip(pool,raw,block,account) : {
    status:'QUOTED_NOT_SIMULATED',pool,buy:await quoteExact(pool,pool.quote,raw,block.number)};
  save(resolve(ROOT,'data',`${command}-latest.json`),result); console.log(stringify(result));
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main().catch(e=>{console.error(failure(e));process.exitCode=1;});
}
