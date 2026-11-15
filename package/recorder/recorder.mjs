import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { CDP } from './cdp.mjs';
import { Store } from './store.mjs';
import { writeStatus as saveStatus } from './status.mjs';
import { installPredictionColor } from './presentation.mjs';
import { captureLocations, captureCompatibility, requiredHooks } from './compatibility.mjs';
import { RecoveryGate, IncompatibleCapture, scheduleGeneration, generationCheckReady, recordGenerationCheck } from './recovery.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
let manifest, generation, generationLoadError;
try {
  manifest=JSON.parse(fs.readFileSync(path.join(here,'manifest.json'),'utf8'));
  const { GenerationManager }=await import('../generation/manager.mjs');
  generation=new GenerationManager(runtimePath(),manifest);
} catch(error) { generationLoadError=String(error);manifest={scripts:{},generation:{}}; }
function runtimePath(){return process.env.COMPOSER_RECORDER_HOME || path.join(os.homedir(),'AppData','Local','GreyPredictionComposer','capture');}
// Capture compatibility is independent of the unchanged generation profile.
const captureProfile=JSON.parse(fs.readFileSync(path.join(here,'capture-profile.json'),'utf8'));
const runtime=process.env.COMPOSER_RECORDER_HOME || path.join(os.homedir(),'AppData','Local','GreyPredictionComposer','capture');
fs.mkdirSync(runtime,{recursive:true});
const file=n=>path.join(runtime,n), cmd=process.argv[2]??'run';
const statusFile=file('status.json'), stopFile=file('stop'), lockFile=file('recorder.lock');
const writeStatus=s=>saveStatus(statusFile,s);
if(cmd==='stop'){fs.writeFileSync(stopFile,'requested');console.log('Stop requested; check status for breakpoint cleanup.');}
else if(cmd==='reconnect'){fs.writeFileSync(file('reconnect'),'requested');console.log('Recorder-only reconnect requested; app stays open.');}
else if(cmd==='status'){const s=fs.existsSync(statusFile)?JSON.parse(fs.readFileSync(statusFile,'utf8')):{state:'not_started'};let alive=false;try{process.kill(s.pid,0);alive=true;}catch{}const age=s.at?(Date.now()-Date.parse(s.at))/1000:null;console.log(JSON.stringify({...s,savedState:s.state,state:s.state==='recording'&&(!alive||age>20)?'not_running_or_stale':s.state,processAlive:alive,heartbeatAgeSeconds:age},null,2));}
else if(cmd==='export'){const s=new Store(file('records.sqlite3'));try{process.stdout.write(JSON.stringify(s.export(),null,2)+'\n');}finally{s.close();}}
else if(cmd==='run')await run();else throw Error('Use run, status, stop, reconnect or export');

async function run(){
  if(fs.realpathSync(runtime).toLowerCase().includes('\\packages\\'))throw Error('Run recorder from native Windows, not a redirected packaged-app runtime');
  let lock;
  try{lock=fs.openSync(lockFile,'wx');}catch(e){if(e.code!=='EEXIST')throw e;let prior;try{prior=JSON.parse(fs.readFileSync(lockFile,'utf8'));}catch{throw Error('Unreadable recorder lock; inspect before removing');}let alive=false;try{process.kill(prior.pid,0);alive=true;}catch{}if(alive){console.log('Recorder already running: '+prior.pid);return;}fs.unlinkSync(lockFile);lock=fs.openSync(lockFile,'wx');}
  fs.writeFileSync(lock,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));
  fs.rmSync(stopFile,{force:true});fs.rmSync(file('reconnect'),{force:true});
  const store=new Store(file('records.sqlite3')),clients=new Map(),marker='__COMPOSER_RECORDER_'+randomUUID();
  const recovery=new RecoveryGate();
  const targetKey=t=>t.id+':'+t.webSocketDebuggerUrl;
  const fail=(c,error)=>{c.error=error.message; c.failure=error;lastError=error.message;};
  const endpoint=process.env.COMPOSER_RECORDER_ENDPOINT??'http://127.0.0.1:19227/json/list';
  const endpointUrl=new URL(endpoint);if(endpointUrl.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(endpointUrl.hostname))throw Error('Recorder endpoint must be loopback');
  let stopping=false,fatal=null,lastError=null,history=null,historyError=null,lastState=null;
  process.on('SIGINT',()=>{stopping=true;});process.on('SIGTERM',()=>{stopping=true;});
  store.event('recorder_started',{pid:process.pid,manifestVersion:captureProfile.appVersion,coverage:'delivered results while attached'});
  const snapshot=state=>({at:new Date().toISOString(),pid:process.pid,state,runtime,database:file('records.sqlite3'),appVersion:captureProfile.appVersion,endpoint,recovery:Object.fromEntries(recovery.entries),targets:[...clients.values()].map(c=>({id:c.target.id,hooks:[...c.hooks],error:c.error,connected:c.ws.readyState===WebSocket.OPEN,capture:captureCompatibility(c.hooks,c.scriptNames,captureProfile,c.error),generation:c.generationState})),history,historyError,lastError,...store.summary()});
  const detach=async(c,reason)=>{c.disposing=true;await c.queue;const result=await c.detach();store.event('detached',{targetId:c.target.id,reason,...result});clients.delete(c.target.id);return result;};
  async function armGeneration(c,script,name,source,spec){
    if(c.disposing)return;
    if(createHash('sha256').update(source).digest('hex')!==spec.sha256)throw Error('Generation source hash mismatch: '+name);
    if(name===manifest.generation.moduleScript)c.generationCompatible=true;
    if(name===manifest.generation.catchupScript)c.generationCatchupSource={script,source};
    await generation.arm(c,script,source);
  }
  async function arm(c,script){
    if(c.disposing)return;const epoch=c.epoch;
    const name=script.url.split('/').pop();c.scriptNames.add(name);
    if(/^(app-initial-|initialize-app-host-services-).*\.js$/.test(name)&&!Object.hasOwn(captureProfile.scripts,name))throw new IncompatibleCapture('Unreviewed capture bundle: '+name);
    const captureSpec=Object.hasOwn(captureProfile.scripts,name)?captureProfile.scripts[name]:null, generationSpec=Object.hasOwn(manifest.scripts,name)?manifest.scripts[name]:null, spec=captureSpec??generationSpec;
    if(!spec||c.processed.has(script.scriptId))return;
    c.processed.add(script.scriptId);
    if(!captureSpec){
      if(generation&&!c.generationFailed)scheduleGeneration(c,async()=>{
        if(c.disposing)return;const {scriptSource}=await c.call('Debugger.getScriptSource',{scriptId:script.scriptId});
        await armGeneration(c,script,name,scriptSource,generationSpec);
      });
      return;
    }
    let source;
    try{({scriptSource:source}=await c.call('Debugger.getScriptSource',{scriptId:script.scriptId}));}
    catch(error){if(captureSpec)throw error;c.generationFailed=true;c.generationState={state:'error',error:String(error)};return;}
    if(c.disposing||epoch!==c.epoch)return;
    let locations=[];
    if(captureSpec)try{locations=captureLocations(source,captureSpec);}catch(error){throw new IncompatibleCapture(name+': '+error.message);}
    // Capture is installed first; generation uses its own queue and error state.
    for(const {hook,lineNumber,columnNumber} of locations){
      const possible=await c.call('Debugger.getPossibleBreakpoints',{start:{scriptId:script.scriptId,lineNumber,columnNumber},end:{scriptId:script.scriptId,lineNumber,columnNumber:columnNumber+60},restrictToFunction:true});
      const loc=possible.locations[0];if(!loc)throw new IncompatibleCapture('No breakpoint at '+hook.name);
      const condition=`(()=>{try{const v=${hook.expression};console.info(${JSON.stringify(marker)},JSON.stringify(v));}catch(e){console.info(${JSON.stringify(marker)},JSON.stringify({kind:'hook_error',site:${JSON.stringify(hook.name)},error:String(e)}));}return false;})()`;
      const bp=await c.call('Debugger.setBreakpoint',{location:loc,condition});c.breakpoints.push(bp.breakpointId);c.hooks.add(hook.name);
      if(epoch!==c.epoch){await c.call('Debugger.removeBreakpoint',{breakpointId:bp.breakpointId});c.hooks.delete(hook.name);return;}
      store.event('hook_armed',{targetId:c.target.id,hook:hook.name,script:name,location:bp.actualLocation,sourceHash:spec.sha256});
    }
    if(generation&&!c.generationFailed&&generationSpec)scheduleGeneration(c,async()=>{
      await armGeneration(c,script,name,source,generationSpec);
    });
  }
  async function connect(target){
    const c=new CDP(target.webSocketDebuggerUrl);c.target=target;c.hooks=new Set();c.scriptNames=new Set();c.processed=new Set();c.error=null;c.queue=Promise.resolve();clients.set(target.id,c);
    c.healthySince=null;c.disposing=false;c.generationFailed=false;c.epoch=0;
    if(generationLoadError)c.generationState={state:'error',error:generationLoadError};
    c.on('fault',e=>fail(c,e));
    c.on('disconnected',()=>store.event('connection_closed',{targetId:target.id}));
    c.on('Runtime.consoleAPICalled',m=>{
      if(m.args?.[0]?.value==='__COMPOSER_GENERATION'&&typeof m.args?.[1]?.value==='string'){
        try{const value=JSON.parse(m.args[1].value);store.event('generation_'+value.event,{...value,targetId:target.id});}catch(e){lastError=e.message;}return;
      }
      if(m.args?.[0]?.value!==marker||typeof m.args?.[1]?.value!=='string')return;
      try{const data=JSON.parse(m.args[1].value);data.targetId=target.id;data.appVersion=captureProfile.appVersion;
        data.transportKey=createHash('sha256').update(JSON.stringify([target.id,m.executionContextId,m.timestamp,m.args[1].value])).digest('hex');
        store.ingest(data,new Date(m.timestamp).toISOString());
        if(data.kind==='hook_error')fail(c,new IncompatibleCapture(data.error));
      }catch(e){fatal=e;stopping=true;}
    });
    const schedule=script=>{const epoch=c.epoch;c.queue=c.queue.then(()=>{if(!c.failure&&epoch===c.epoch)return arm(c,script);}).catch(e=>{if(epoch===c.epoch)fail(c,e);});};
    c.on('Debugger.scriptParsed',schedule);
    c.on('Runtime.executionContextsCleared',()=>{c.presentationAttempted=false;});
    c.on('Runtime.executionContextsCleared',()=>{c.epoch++;c.hooks.clear();c.scriptNames.clear();c.processed.clear();c.error=null;c.failure=null;c.healthySince=null;c.generationFailed=false;delete c.generationCheckRecovery;c.generationHealthySince=null;recovery.reset(targetKey(target));c.generationCompatible=false;c.generationRouteArmed=false;c.generationCatchupSource=null;c.generationState=null;store.event('coverage_gap',{targetId:target.id,reason:'renderer context reset'});});
    try{await c.open();await c.call('Runtime.enable');await c.call('Debugger.enable');await c.queue;if(c.failure)throw c.failure;store.event('attached',{targetId:target.id,hooks:[...c.hooks]});}catch(e){c.error=e.message;await detach(c,'attach_failed');throw e;}
  }
  try{
    while(!stopping&&!fs.existsSync(stopFile)){
      let targets=[],endpointAvailable=false;
      try{const response=await fetch(endpoint,{signal:AbortSignal.timeout(3000)});if(!response.ok)throw Error('Debugger HTTP '+response.status);targets=(await response.json()).filter(t=>t.type==='page'&&t.url==='app://-/index.html'&&t.webSocketDebuggerUrl);endpointAvailable=true;lastError=null;}catch(e){lastError='Debug endpoint unavailable: '+e.message;}
      if(fs.existsSync(file('reconnect'))){fs.unlinkSync(file('reconnect'));recovery.entries.clear();for(const c of [...clients.values()])await detach(c,'requested_recorder_reconnect');}
      for(const c of [...clients.values()]){
        if(c.failure||c.ws.readyState===WebSocket.CLOSED){const state=recovery.fail(targetKey(c.target),c.failure??Error('Debugger disconnected'));store.event('capture_recovery',{targetId:c.target.id,...state});await detach(c,'capture_recovery');}
        else if(endpointAvailable&&!targets.some(t=>t.id===c.target.id))await detach(c,'target_closed');
      }
      for(const target of targets)if(!clients.has(target.id)&&recovery.ready(targetKey(target)))try{await connect(target);}catch(e){lastError=e.message;store.event('capture_recovery',{targetId:target.id,...recovery.fail(targetKey(target),e)});}
      for(const c of clients.values())if(c.ws.readyState===WebSocket.OPEN&&!c.error){
        await c.queue;
        if(!c.presentationAttempted){
          c.presentationAttempted=true;
          try {
            const result=await c.call('Runtime.evaluate',{expression:`(${installPredictionColor.toString()})(${JSON.stringify(manifest.generation.moduleUrl)})`,awaitPromise:true,returnByValue:true});
            if(result.exceptionDetails)throw Error(result.exceptionDetails.text);
            store.event('prediction_presentation',{targetId:c.target.id,...result.result.value});
          }catch(error){store.event('prediction_presentation_error',{targetId:c.target.id,error:error.message});}
        }
        if(requiredHooks.every(h=>c.hooks.has(h))){c.healthySince??=Date.now();recovery.healthy(targetKey(c.target),c.healthySince);}
        if(generation&&generationCheckReady(c)&&!c.generationPending){c.generationPending=true;scheduleGeneration(c,async()=>{try{if(!c.disposing){await generation.ensure(c);recordGenerationCheck(c);}}finally{c.generationPending=false;}});}
      }
      try{history=store.syncHistory(path.join(os.homedir(),'.codex','thread_history_1.sqlite'));historyError=null;}catch(e){historyError=e.message;}
      const complete=[...clients.values()].filter(c=>c.ws.readyState===WebSocket.OPEN&&!c.error&&requiredHooks.every(h=>c.hooks.has(h))).length;
      const state=complete&&complete===targets.length&&!historyError?'recording':targets.length?'partial_or_unsupported':'waiting_for_app_debug_connection';
      if(state!==lastState){store.event('coverage_state',{state,previous:lastState,error:lastError,historyError,capture:[...clients.values()].map(c=>captureCompatibility(c.hooks,c.scriptNames,captureProfile,c.error))});lastState=state;}
      writeStatus(snapshot(state));
      await new Promise(r=>setTimeout(r,2000));
    }
  }catch(e){fatal=e;lastError=e.message;}
  finally{
    const cleanup=[];for(const c of [...clients.values()])cleanup.push(await detach(c,'recorder_stopped'));
    store.event('recorder_stopped',{error:fatal?.message??null,cleanup});writeStatus({...snapshot(fatal?'failed':'stopped'),cleanup});
    store.close();fs.closeSync(lock);fs.unlinkSync(lockFile);if(fatal){console.error(fatal);process.exitCode=1;}
  }
}
