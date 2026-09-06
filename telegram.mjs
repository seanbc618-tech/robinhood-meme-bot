import {readFileSync,existsSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
const root=dirname(fileURLToPath(import.meta.url));
export const enabled=()=>existsSync(resolve(root,'.env.telegram'))||Boolean(process.env.TELEGRAM_BOT_TOKEN);
function credentials() {
  const values={};
  const path=resolve(root,'.env.telegram');
  if(existsSync(path)) for(const line of readFileSync(path,'utf8').split('\n')) {
    const at=line.indexOf('=');if(at>0) values[line.slice(0,at)]=line.slice(at+1).trim();
  }
  const token=process.env.TELEGRAM_BOT_TOKEN||values.TELEGRAM_BOT_TOKEN;
  const chat=process.env.TELEGRAM_CHAT_ID||values.TELEGRAM_CHAT_ID;
  if(!token||!chat) throw new Error('Telegram credentials missing');
  if(!/^\d+:[A-Za-z0-9_-]+$/.test(token)||! /^-?\d+$/.test(chat)) throw new Error('Telegram credentials malformed');
  return {token,chat};
}
export async function send(text) {
  const {token,chat}=credentials();
  // Token travels through stdin to curl, never in process arguments or errors.
  const config=`url = "https://api.telegram.org/bot${token}/sendMessage"\nrequest = "POST"\nheader = "Content-Type: application/json"\ndata = ${JSON.stringify(JSON.stringify({chat_id:chat,text:String(text).slice(0,3900),link_preview_options:{is_disabled:true}}))}\n`;
  const raw=await new Promise((accept,reject)=>{
    const child=spawn('curl',['--silent','--show-error','--max-time','20','--config','-'],{stdio:['pipe','pipe','pipe']});
    let output='';child.stdout.on('data',b=>output+=b);child.stderr.resume();
    child.on('error',()=>reject(new Error('Telegram transport unavailable')));
    child.on('close',code=>code===0?accept(output):reject(new Error('Telegram transport failed; delivery uncertain, no automatic resend')));
    child.stdin.on('error',()=>{});child.stdin.end(config);
  });
  let response;try{response=JSON.parse(raw);}catch{throw new Error('Telegram invalid response; delivery uncertain');}
  if(!response.ok) throw new Error(`Telegram API rejected request (${response.error_code||'unknown'})`);
  return {message_id:response.result.message_id,chat_id:response.result.chat.id};
}
export async function broadcast(key,text) {
  const path=resolve(root,'data/telegram-sent.json');
  const sent=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{};
  if(sent[key]) return {duplicate:true};
  const result=await send(text);
  sent[key]={...result,at:Math.floor(Date.now()/1000)};
  mkdirSync(dirname(path),{recursive:true});writeFileSync(path+'.tmp',JSON.stringify(sent,null,2));renameSync(path+'.tmp',path);
  return result;
}
export function marketMessage(report) {
  const rows=report.candidates||[];
  const candidates=rows.filter(c=>c.status==='CANDIDATE_NOT_ORDER');
  return ['🐕 Robinhood 链上扫描播报',`区块：${report.discovery_to}`,
    `窗口内注册池：${report.discovered}；已分析：${report.processed}`,
    `候选：${candidates.length}；其余拒绝或数据不足：${rows.length-candidates.length}`,
    ...rows.slice(0,5).map(c=>`${c.symbol||c.token}\n${c.status} ${(c.reasons||[]).join(' / ')}`),
    '仅观察与模拟，未下单；候选不代表盈利保证。'].join('\n');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const command=process.argv[2];
  const task=command==='test'?broadcast('connection-test-v1','✅ Robinhood 打狗 Bot Telegram 已接通\n当前阶段：链上观察、热点筛选、V4 买卖模拟与收据记账。\n未开启实盘交易；本条为连接测试。'):
    command==='report'?(()=>{const r=JSON.parse(readFileSync(resolve(root,'data/market-latest.json')));return broadcast(`market:${r.discovery_to}`,marketMessage(r));})():Promise.reject(new Error('Usage: node telegram.mjs test | report'));
  task.then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.message);process.exitCode=1;});
}
