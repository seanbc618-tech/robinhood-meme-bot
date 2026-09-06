// Bounded real-market observation and atomic round-trip simulation, never signed trades.
import {spawn} from 'node:child_process';
import {openSync,closeSync,existsSync,readFileSync,unlinkSync,mkdirSync,appendFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {ROOT,discover,save,failure} from './chain.mjs';
import {broadcast} from './telegram.mjs';
import {paperTick,openPaper} from './paper.mjs';
const dir=resolve(ROOT,'data/sim-run'),lock=resolve(dir,'pid');
mkdirSync(dir,{recursive:true});
const cmd=process.argv[2];
if(cmd==='start') {
  if(existsSync(lock)) {
    const pid=Number(readFileSync(lock,'utf8'));
    let alive=false;try{process.kill(pid,0);alive=true;}catch(e){if(e.code!=='ESRCH')throw e;}
    if(alive)throw Error('Simulation already running: '+pid);
    unlinkSync(lock);
  }
  const hours=Number(process.argv[3]||24);
  if(!Number.isFinite(hours)||hours<=0||hours>168)throw Error('Hours must be in (0,168]');
  const log=openSync(resolve(dir,'process.log'),'a',0o600);
  const child=spawn(process.execPath,[resolve(ROOT,'sim-run.mjs'),'worker',String(hours)],{cwd:ROOT,detached:true,stdio:['ignore',log,log]});
  child.unref();closeSync(log);console.log('Simulation dispatched, PID '+child.pid);
} else if(cmd==='status') {
  console.log(existsSync(resolve(dir,'status.json'))?readFileSync(resolve(dir,'status.json'),'utf8'):'Not started');
} else if(cmd==='stop') {
  // Stop marker is checked between calls; no PID reuse risk.
  save(resolve(dir,'stop.json'),{requested_at:Date.now()});console.log('Stop requested; worker stops after current scan.');
} else if(cmd==='worker') {
  const fd=openSync(lock,'wx',0o600);
  const {writeSync}=await import('node:fs');writeSync(fd,String(process.pid));closeSync(fd);
  const stop=resolve(dir,'stop.json');if(existsSync(stop))unlinkSync(stop);
  const started=Date.now(),end=started+Number(process.argv[3])*3600000;
  const id=new Date(started).toISOString().replace(/[:.]/g,'-');
  const state={id,pid:process.pid,mode:'PERSISTENT_PAPER_PORTFOLIO',started_at:started,ends_at:end,
    status:'STARTING',rounds:0,failed_rounds:0,candidates:0,simulations_passed:0,
    realized_pnl:null,pnl_note:'Virtual USD portfolio, quote-based modeled fills, not real transactions',last_completed_at:null};
  const persist=()=>save(resolve(dir,'status.json'),state);
  const notify=async(key,text)=>{try{await broadcast(key.startsWith('trade:')?'paper:'+key:id+':'+key,text);}catch(e){state.telegram_error=failure(e);persist();}};
  const notifyTrades=async trades=>{
    for(const trade of trades) await notify('trade:'+trade.at+':'+trade.token,`🧾 模拟成交（非实盘）\n${trade.side} ${trade.token}\n数量：${trade.qty} 原始单位\n净收支 USD：${trade.net.toFixed(4)}\n原因：${trade.reason||'entry'}`);
  };
  persist();
  await notify('start',`▶️ Robinhood 模拟观察已启动\n时长：${process.argv[3]} 小时；每轮结束后间隔 5 分钟。\n真实链上筛选＋符合条件时连续买卖模拟，不签名、不下单。\n已启用持续虚拟持仓、回本/半仓退出与累计亏损熔断。`);
  let previousProblem='';
  try {
    while(Date.now()<end&&!existsSync(stop)) {
      state.status='SCANNING';state.last_started_at=Date.now();persist();
      try {
        const before=await paperTick();
        state.paper=before;state.realized_pnl=before.realized;persist();
        await notifyTrades(before.trades);
        const report=await discover(5,false);
        const paper=await paperTick(report.candidates);
        state.paper=paper;state.realized_pnl=paper.realized;persist();
        await notifyTrades(paper.trades);
        if(paper.halted) await notify('paper-halt','🛑 虚拟账户累计损失触发停止新增买入，继续检查可卖出的持仓。');
        save(resolve(dir,`${id}-round-${state.rounds+1}.json`),report);
        state.rounds++;state.last_completed_at=Date.now();state.last_block=report.discovery_to;
        const good=report.candidates.filter(c=>c.status==='CANDIDATE_NOT_ORDER');
        state.candidates+=good.length;
        state.simulations_passed+=report.candidates.filter(c=>c.simulation?.status==='SIMULATED_NOT_FILLED').length;
        state.last_results=report.candidates.map(c=>({token:c.token,status:c.status,reasons:c.reasons}));
        state.status='WAITING';persist();
        for(const c of good) await notify('candidate:'+c.token,`🧪 模拟候选（未交易）\n${c.symbol||''}\n${c.token}\n往返损耗：${c.simulation?.round_trip_loss_bps/100}%（未含完整 Gas）\n区块：${report.discovery_to}`);
        if(state.rounds===1||Date.now()-(state.last_summary_at||started)>=3600000) {
          await notify('summary:'+state.rounds,`📊 模拟运行汇总\n完成轮数：${state.rounds}；失败轮数：${state.failed_rounds}\n累计候选观察：${state.candidates}；往返模拟通过：${state.simulations_passed}\n最新区块：${report.discovery_to}\n虚拟净值：${state.paper?.equity ?? "不可用"} USD；虚拟已实现盈亏：${state.realized_pnl ?? "不可用"} USD。未执行实盘。`);
          state.last_summary_at=Date.now();persist();
        }
        previousProblem='';
      } catch(e) {
        const account=openPaper();state.paper=account.read();account.db.close();
        state.realized_pnl=state.paper.realized;
        state.failed_rounds++;state.status='WAITING_AFTER_SOURCE_ERROR';state.last_error=failure(e);persist();
        if(previousProblem!==state.last_error)await notify('error:'+state.failed_rounds,'⚠️ 模拟扫描本轮失败\n'+state.last_error+'\n本轮不产生信号，下一周期再检查。');
        previousProblem=state.last_error;
      }
      appendFileSync(resolve(dir,'rounds.jsonl'),JSON.stringify(state,(_,v)=>typeof v==='bigint'?v.toString():v)+'\n');
      const next=Math.min(Date.now()+300000,end);
      while(Date.now()<next&&!existsSync(stop))await new Promise(r=>setTimeout(r,1000));
    }
    state.status=existsSync(stop)?'STOPPED':'COMPLETED';persist();
    await notify('end',`⏹ 模拟观察结束：${state.status}\n完成 ${state.rounds} 轮，失败 ${state.failed_rounds} 轮，往返模拟通过 ${state.simulations_passed} 次。\n结果保存在本地，未执行交易。`);
  }finally{unlinkSync(lock);}
} else throw Error('Usage: node sim-run.mjs start [HOURS] | status | stop');
