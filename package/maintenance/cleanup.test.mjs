// Actual cleanup script + real Node inspector, never the desktop app/debugger.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {CDP} from '../recorder/cdp.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function run(file,env,args=[]){
  const p=spawn(process.execPath,[file,...args],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='';p.stdout.on('data',b=>output+=b);p.stderr.on('data',b=>output+=b);
  const deadline=setTimeout(()=>p.kill(),12000);
  try{const [code]=await once(p,'exit');return {code,output};}finally{clearTimeout(deadline);}
}
test('real cleanup disposes only owned renderer state and refreshes native queries',{timeout:20000},async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'predictor-cleanup-fixture-'));
  for(const n of ['generation','recorder','maintenance'])fs.cpSync(path.join(root,n),path.join(dir,n),{recursive:true});
  // Node inspector has no app-native dynamic import/cache service. Stub only that boundary.
  fs.writeFileSync(path.join(dir,'generation/manager.mjs'),'export class GenerationManager{refreshExpression(){return "globalThis.refreshed=true"}}');
  const moduleUrl='data:text/javascript,'+encodeURIComponent('export const consume=async x=>x;export const services={queryCache:{invalidateQueryCache:()=>true}};');
  fs.writeFileSync(path.join(dir,'recorder/manifest.json'),JSON.stringify({generation:{moduleUrl,bindings:{consume:'consume',services:'services'}}}));
  const app=spawn(process.execPath,['--inspect=127.0.0.1:0','-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  let stderr='',connection,server;app.stderr.on('data',b=>stderr+=b);
  try{
    const deadline=Date.now()+5000;while(!stderr.includes('ws://')&&Date.now()<deadline)await pause(20);
    const ws=stderr.match(/ws:\/\/127\.0\.0\.1:\d+\/[\w-]+/)?.[0];assert.ok(ws,stderr);
    connection=new CDP(ws);await connection.open();
    const initialize=async owner=>connection.call('Runtime.evaluate',{expression:`globalThis.disposals=0;globalThis.__COMPOSER_ASTRA_ADAPTER={owner:${JSON.stringify(owner)},status:()=>({jobs:0}),dispose:async()=>{globalThis.disposals++;delete globalThis.__COMPOSER_ASTRA_ADAPTER;}};globalThis.__PROMPT_PREDICTOR_PRESENTATION={owner:${JSON.stringify(owner)},dispose:()=>{globalThis.disposals++;delete globalThis.__PROMPT_PREDICTOR_PRESENTATION;}};`});
    server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify([{type:'page',url:'app://-/index.html',webSocketDebuggerUrl:ws}]));});
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const env={...process.env,COMPOSER_RECORDER_ENDPOINT:`http://127.0.0.1:${server.address().port}/json/list`};
    const restoreCheck=path.join(dir,'maintenance/restore-renderer-check.mjs');
    assert.equal((await run(restoreCheck,env)).code,0);
    await initialize('prompt-predictor-prototype-v1');
    const blocked=await run(restoreCheck,env);assert.notEqual(blocked.code,0);assert.match(blocked.output,/finish removal before Restore/);
    let intact=await connection.call('Runtime.evaluate',{expression:'globalThis.disposals',returnByValue:true});assert.equal(intact.result.value,0);
    const removed=await run(path.join(dir,'maintenance/cleanup.mjs'),env);assert.equal(removed.code,0,removed.output);
    assert.equal((await run(restoreCheck,env)).code,0);
    let value=await connection.call('Runtime.evaluate',{expression:'globalThis.disposals',returnByValue:true});assert.equal(value.result.value,2);
    value=await connection.call('Runtime.evaluate',{expression:'globalThis.refreshed',returnByValue:true});assert.equal(value.result.value,true);
    await initialize('foreign-installation');
    const preserved=await run(path.join(dir,'maintenance/cleanup.mjs'),env);assert.notEqual(preserved.code,0);assert.match(preserved.output,/Unowned renderer/);
    value=await connection.call('Runtime.evaluate',{expression:'globalThis.disposals',returnByValue:true});assert.equal(value.result.value,0);
  }finally{
    if(connection)await connection.detach();if(server)await new Promise(r=>server.close(r));
    app.kill();fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('unreachable endpoint succeeds only with explicit app-closed evidence',{timeout:10000},async()=>{
  let empty=false;
  const server=http.createServer((req,res)=>{res.statusCode=empty?200:503;res.end(empty?'[]':'');});server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const env={...process.env,COMPOSER_RECORDER_ENDPOINT:`http://127.0.0.1:${server.address().port}/json/list`};
    assert.equal((await run(path.join(root,'maintenance/cleanup.mjs'),env,['--app-closed'])).code,0);
    const failed=await run(path.join(root,'maintenance/cleanup.mjs'),env);assert.notEqual(failed.code,0);assert.match(failed.output,/App still running/);
    empty=true;
    const missing=await run(path.join(root,'maintenance/cleanup.mjs'),env);assert.notEqual(missing.code,0);assert.match(missing.output,/no renderer was discoverable/);
  }finally{await new Promise(r=>server.close(r));}
});
