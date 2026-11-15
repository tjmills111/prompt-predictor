import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.mjs';
import { RecoveryGate, IncompatibleCapture, isTemporary, scheduleGeneration, generationCheckReady, recordGenerationCheck } from './recovery.mjs';

test('generation evaluation timeout retries are bounded and renew only after sustained active checks',()=>{
  let now=0;const c={},clock=()=>now;
  for(const delay of [2000,5000,15000]){
    c.generationState={state:'error',error:'Error: Debugger timeout: Runtime.evaluate'};
    recordGenerationCheck(c,clock);assert.equal(c.generationFailed,false);
    assert.equal(generationCheckReady(c),false);now+=delay;assert.equal(generationCheckReady(c),true);
  }
  c.generationState={state:'active'};recordGenerationCheck(c,clock);
  now+=29000;recordGenerationCheck(c,clock);assert.equal(c.generationCheckRecovery.state('ensure').attempts,3);
  c.generationState={state:'waiting_for_services'};recordGenerationCheck(c,clock);
  c.generationState={state:'active'};recordGenerationCheck(c,clock);
  now+=29000;recordGenerationCheck(c,clock);assert.equal(c.generationCheckRecovery.state('ensure').attempts,3);
  now+=1000;recordGenerationCheck(c,clock);assert.equal(c.generationCheckRecovery.state('ensure').attempts,0);
  for(let i=0;i<4;i++){
    c.generationState={state:'error',error:'Error: Debugger timeout: Runtime.evaluate'};
    recordGenerationCheck(c,clock);now+=15000;
  }
  assert.equal(c.generationFailed,true);assert.equal(generationCheckReady(c),false);
});

test('generation binding, expression, other debugger and unknown errors still stop for review',()=>{
  for(const error of ['Error: Renderer binding factory changed','Error: ReferenceError: missingBinding','Error: Debugger timeout: Debugger.getScriptSource','Error: unexpected']){
    const c={generationState:{state:'error',error}};recordGenerationCheck(c);
    assert.equal(c.generationFailed,true);assert.equal(generationCheckReady(c),false);
  }
});

test('temporary failures back off, exhaust three retries, and require a new lifecycle or explicit reset',()=>{
  let now=0;const g=new RecoveryGate(()=>now),key='target';
  for(const delay of [2000,5000,15000]){
    assert.equal(g.ready(key),true);const state=g.fail(key,Error('Debugger timeout: Debugger.enable'));
    assert.equal(state.blocked,false);assert.equal(g.ready(key),false);now+=delay;assert.equal(g.ready(key),true);
  }
  assert.equal(g.fail(key,Error('Debugger disconnected')).blocked,true);now+=100000;assert.equal(g.ready(key),false);
  assert.equal(g.ready('new target'),true);g.reset(key);assert.equal(g.ready(key),true);
});
test('successful attachment must remain healthy for 30 seconds before renewing its retry budget',()=>{
  let now=0;const g=new RecoveryGate(()=>now);g.fail('t',Error('Debugger disconnected'));
  now=29000;g.healthy('t',0);assert.equal(g.state('t').attempts,1);
  now=30000;g.healthy('t',0);assert.equal(g.state('t').attempts,0);
});
test('changed code and unclassified failures stop immediately, never guessed into temporary errors',()=>{
  const g=new RecoveryGate();
  assert.equal(g.fail('hash',new IncompatibleCapture('Source hash mismatch')).kind,'incompatible');
  assert.equal(g.ready('hash'),false);
  assert.equal(g.fail('unknown',Error('Unexpected breakpoint response')).kind,'needs_review');assert.equal(g.ready('unknown'),false);
  assert.equal(isTemporary(Error('No script with given id')),true);
});
test('throwing or stalled generation does not block storing unsent originals; replay remains deduplicated',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'capture-isolation-')),store=new Store(path.join(dir,'records.sqlite3'));
  const prediction={responseId:'native-result',sourceTurnId:'source',text:'Exact original, never sent.'};
  const receipt={kind:'receipt',target:{hostId:'local',threadId:'chat',latestTurnId:'source'},prediction};
  try{
    const failed={};await scheduleGeneration(failed,()=>{throw Error('Generation source changed');});
    assert.equal(failed.generationFailed,true);assert.equal(failed.error,undefined);
    const stalled={};let release;const pending=scheduleGeneration(stalled,()=>new Promise(r=>{release=r;}));
    await Promise.resolve();store.ingest(receipt);store.ingest(receipt);
    assert.equal(store.summary().predictions,1);assert.equal(store.summary().pairs,0);
    assert.equal(store.export()[0].text,prediction.text);release();await pending;
    const reopened=new Store(path.join(dir,'records.sqlite3'));try{assert.equal(reopened.export()[0].text,prediction.text);}finally{reopened.close();}
  }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
