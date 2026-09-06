import {spawn} from 'node:child_process';
import {openSync,closeSync,existsSync,readFileSync,unlinkSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ROOT,save,failure} from './chain.mjs';
import {
  abcDir,openAbc,openAbcReadonly,initAccounts,readAccount,readRun,DEFAULT_HOURS,stringify,catalogStats,
} from './abc-collect.mjs';
import {screeningReport} from './abc-screening.mjs';

export {
  remainingFraction,pnlMultiple,utcDay,applyDayBaseline,canEnter,applyBuy,applySell,
  exitDecision,sellQtyFor,recomputeEquity,
} from './abc-paper.mjs';
export {evaluateA,evaluateB,evaluateC,signalId,evaluators} from './abc-strategy.mjs';
export {markAndExit,tryEnter} from './abc-entry.mjs';
export {
  acquireLock,releaseLock,nextTickDeadline,sleepUntil,cycle,worker,
  printStatus,printReport,
} from './abc-runtime.mjs';

import {worker,printStatus,printReport} from './abc-runtime.mjs';

const cmd=process.argv[2];
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const dir=abcDir();
  if(cmd==='start') {
    if(existsSync(resolve(dir,'pid'))) {
      const pid=Number(readFileSync(resolve(dir,'pid'),'utf8'));
      let alive=false;try{process.kill(pid,0);alive=true;}catch(e){if(e.code!=='ESRCH') throw e;}
      if(alive) throw new Error('ABC simulation already running: '+pid);
      unlinkSync(resolve(dir,'pid'));
    }
    const hours=Number(process.argv[3]||DEFAULT_HOURS);
    if(!Number.isFinite(hours)||hours<=0||hours>DEFAULT_HOURS) throw new Error('Hours must be in (0,336]');
    mkdirSync(dir,{recursive:true});
    const log=openSync(resolve(dir,'process.log'),'a',0o600);
    const child=spawn(process.execPath,[resolve(ROOT,'abc.mjs'),'worker',String(hours)],{cwd:ROOT,detached:true,stdio:['ignore',log,log]});
    child.unref();closeSync(log);console.log('ABC paper simulation dispatched, PID '+child.pid);
  } else if(cmd==='run') {
    worker(Number(process.argv[3]||DEFAULT_HOURS),true).catch(e=>{console.error(failure(e));process.exitCode=1;});
  } else if(cmd==='worker') {
    worker(Number(process.argv[3]||DEFAULT_HOURS),false).catch(e=>{console.error(failure(e));process.exitCode=1;});
  } else if(cmd==='status') printStatus(dir);
  else if(cmd==='stop') {
    save(resolve(dir,'stop.json'),{requested_at:Date.now()});
    if(existsSync(resolve(dir,'pid'))) {
      const pid=Number(readFileSync(resolve(dir,'pid'),'utf8'));
      try {process.kill(pid,'SIGTERM');} catch(e) {if(e.code!=='ESRCH') throw e;}
    }
    console.log('ABC stop requested; worker finishes current cycle.');
  } else if(cmd==='report') printReport(dir);
  else if(cmd==='screening-report') {
    const store=openAbcReadonly(dir);
    try {
      const rep=screeningReport(store,{readOnly:true});
      console.log(stringify(rep));
    } finally {store.close();}
  }
  else throw new Error('Usage: node abc.mjs start [hours] | run [hours] | status | stop | report | screening-report');
}
