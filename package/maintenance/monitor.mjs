import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { evaluateHealth, advanceMonitor, classifyGaps } from '../recorder/health.mjs';
import { writeStatus } from '../recorder/status.mjs';
import { recoverRecorder } from './recovery.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const runtime=path.join(os.homedir(),'AppData/Local/GreyPredictionComposer/capture');
const file=name=>path.join(runtime,name);
const read=name=>JSON.parse(fs.readFileSync(file(name),'utf8'));
if(process.argv[2]==='status') {console.log(JSON.stringify(read('monitor.json'),null,2));}
else {
  fs.mkdirSync(runtime,{recursive:true});
  let previous=null;
  try{previous=read('monitor.json');}catch(error){if(error.code!=='ENOENT')throw error;}
  const now=Date.now(),startedAt=previous?.startedAt??new Date(now).toISOString();
  let health, diagnostics={},baselineGapIds=previous?.baselineGapIds;
  try {
    const tasks=execFileSync('tasklist.exe',['/FI','IMAGENAME eq ChatGPT.exe','/FO','CSV','/NH'],{encoding:'utf8',windowsHide:true,timeout:10000});
    const appRunning=/"ChatGPT\.exe"/i.test(tasks);
    let status=null;try{status=read('status.json');}catch(error){if(error.code!=='ENOENT')throw error;}
    let processAlive=false;try{if(status?.state!=='stopped'&&Number.isInteger(status?.pid)&&status.pid>0){process.kill(status.pid,0);processAlive=true;}}catch{}
    diagnostics.launchRecovery=await recoverRecorder({appRunning,processAlive,intentionalStop:fs.existsSync(file('stop')),previous:previous?.diagnostics?.launchRecovery,
      probe:async()=>{const r=await fetch('http://127.0.0.1:19227/json/list',{signal:AbortSignal.timeout(2000)});if(!r.ok)throw Error('Discovery failed');return r.json();},
      start:async()=>{execFileSync('powershell.exe',['-NoProfile','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',path.join(here,'Recorder.ps1'),'-Action','Start'],{windowsHide:true,timeout:20000});},
      inspect:async()=>{let current;for(let i=0;i<4;i++){await new Promise(r=>setTimeout(r,3000));try{current=read('status.json');}catch(error){if(error.code==='ENOENT')continue;throw error;}let alive=false;try{process.kill(current.pid,0);alive=true;}catch{}current={...current,processAlive:alive};if(alive&&current.state==='recording'&&current.targets?.every(t=>t.generation?.state==='active'))break;}return current;}
    });
    // Starting a helper is not recovery: health below uses a fresh receipt.
    try{status=read('status.json');}catch{}
    processAlive=false;try{if(status?.state!=='stopped'&&Number.isInteger(status?.pid)&&status.pid>0){process.kill(status.pid,0);processAlive=true;}}catch{}
    const generationConfigured=read('generation.json').enabled===true;
    let proxyAvailable=false;
    try{const response=await fetch('http://127.0.0.1:18892/health',{signal:AbortSignal.timeout(3000)});proxyAvailable=response.ok&&(await response.json()).proxy_running===true;}catch{}
    let newGaps=0,gapIds=[],conflicts=0,recentFailures=0,configurationProblem=null;
    const overrideEnabled=!fs.existsSync(path.join(runtime,'..','disabled'));
    if(overrideEnabled) {
      const prompt=fs.readFileSync(path.join(here,'..','prompt.txt'),'utf8').replace(/\r\n/g,'\n').trim();
      const hash=createHash('sha256').update(prompt).digest('hex');
      // Existing receipts only: do not create model traffic or refresh account baselines.
      const lines=fs.readFileSync(path.join(runtime,'..','evidence.jsonl'),'utf8').trimEnd().split('\n');
      for(let i=lines.length-1;i>=0;i--) {
        let row;try{row=JSON.parse(lines[i]);}catch{continue;}
        if(row.event==='config_response' && row.owned_route) {
          diagnostics.lastConfiguration={at:new Date(row.time*1000).toISOString(),status:row.status,modified:row.modified,promptMatches:row.prompt_sha256===hash};
          if(row.status!==200 || !row.modified || row.prompt_sha256!==hash) configurationProblem='Last configuration receipt did not apply the installed custom prompt; inspect account eligibility and override guards';
          break;
        }
        if(['response_error','config_error','settings_error'].includes(row.event)) {configurationProblem='Last configuration attempt recorded a transport/response error; inspect the existing receipt log';break;}
      }
    }
    const db=new DatabaseSync(file('records.sqlite3'),{readOnly:true});
    try {
      db.exec('PRAGMA busy_timeout=1000; PRAGMA query_only=ON');
      diagnostics.comparisonStates=db.prepare('SELECT status,count(*) n FROM comparison_state GROUP BY status').all();
      const gaps=db.prepare("SELECT p.id,p.first_seen,c.status FROM predictions p JOIN comparison_state c ON c.prediction_id=p.id WHERE c.status IN ('source_unavailable','missing_native_message')").all();
      const classified=classifyGaps(gaps,baselineGapIds,startedAt,now);
      baselineGapIds=classified.baselineGapIds;newGaps=classified.newGaps;
      gapIds=classified.newGapIds;
      diagnostics.knownHistoricalGaps=classified.knownHistoricalGaps;
      conflicts=db.prepare("SELECT count(*) n FROM events WHERE kind='identity_text_conflict' AND at>?").get(startedAt).n;
      recentFailures=db.prepare("SELECT payload_json FROM events WHERE kind='generation_failed' AND at>?").all(new Date(now-900000).toISOString()).filter(r=>!/(no longer current|cancel|released|stale|superseded|consumer)/i.test(JSON.parse(r.payload_json).error??'')).length;
      diagnostics.lastReceipt=db.prepare("SELECT at FROM events WHERE kind='receipt' ORDER BY id DESC LIMIT 1").get()?.at??null;
      diagnostics.predictions=db.prepare('SELECT count(*) n FROM predictions').get().n;
    }finally{db.close();}
    // Evaluate freshness after collecting evidence. The recorder may publish a
    // new heartbeat while tasklist/network/database checks are in progress.
    health=evaluateHealth(status,{appRunning,processAlive,generationConfigured,proxyAvailable:!overrideEnabled||proxyAvailable,configurationProblem,newGaps,gapIds,conflicts,recentFailures});
    if(health.state==='healthy') diagnostics.launchRecovery={state:'healthy',lastRecovery:diagnostics.launchRecovery?.attempted?diagnostics.launchRecovery:previous?.diagnostics?.launchRecovery?.lastRecovery};
    diagnostics={...diagnostics,appRunning,processAlive,generationConfigured,proxyAvailable,newGaps,conflicts,recentFailures};
  }catch(error){health={state:'attention',issues:[{code:'monitor_check_failed',detail:String(error)}]};}
  const next={...advanceMonitor(previous,health),startedAt,baselineGapIds,diagnostics};
  if(next.alert||next.recovered) {
    fs.appendFileSync(file('monitor-events.jsonl'),JSON.stringify({at:next.at,event:next.alert?'failure':'recovered',health})+'\n');
    if(next.alert) {
      try{
        execFileSync('powershell.exe',['-NoProfile','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',path.join(here,'Notify-Monitor.ps1')],{windowsHide:true,timeout:15000});
        next.notificationQueuedAt=next.at;next.notificationError=null;
      }catch(error){next.notificationError=String(error);}
    }
  }
  if(!writeStatus(file('monitor.json'),next))throw Error('Monitor status is locked; next scheduled run will retry');
  if(!process.argv.includes('--quiet'))console.log(JSON.stringify(next,null,2));
}
