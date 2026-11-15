// Remove only this package's owned renderer state. Never sends, generates or closes the app.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDP } from '../recorder/cdp.mjs';
import { GenerationManager } from '../generation/manager.mjs';
const owner='prompt-predictor-prototype-v1';
const here=path.dirname(fileURLToPath(import.meta.url));
const manifest=JSON.parse(fs.readFileSync(path.join(here,'../recorder/manifest.json'),'utf8'));
let targets;
const endpoint=new URL(process.env.COMPOSER_RECORDER_ENDPOINT??'http://127.0.0.1:19227/json/list');
if(endpoint.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname))throw Error('Cleanup endpoint must be loopback');
try {
  const r=await fetch(endpoint,{signal:AbortSignal.timeout(2500)});
  if(!r.ok)throw Error('Discovery failed');
  targets=(await r.json()).filter(t=>t.type==='page'&&t.url==='app://-/index.html');
} catch(error) {
  if(process.argv.includes('--app-closed'))process.exit(0);
  throw Error('App still running but renderer cleanup unavailable. Quit it when safe, then retry removal.');
}
if(!targets.length&&!process.argv.includes('--app-closed'))throw Error('App still running but no renderer was discoverable; quit when safe and retry removal.');
for(const target of targets){
  const c=new CDP(target.webSocketDebuggerUrl);
  try{
    await c.open();
    const r=await c.call('Runtime.evaluate',{expression:`(async()=>{
      const a=globalThis.__COMPOSER_ASTRA_ADAPTER,p=globalThis.__PROMPT_PREDICTOR_PRESENTATION;
      if((a&&a.owner!==${JSON.stringify(owner)})||(p&&p.owner!==${JSON.stringify(owner)}))throw Error('Unowned renderer state; nothing removed');
      await a?.dispose();p?.dispose();
      const until=Date.now()+5000;while(a?.status().jobs&&Date.now()<until)await new Promise(r=>setTimeout(r,100));
      if(a?.status().jobs)throw Error('Prediction cleanup still pending; retry after app exits');
      return !!a;
    })()`,awaitPromise:true,returnByValue:true});
    if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);
    if(r.result.value){
      const refresh=await c.call('Runtime.evaluate',{expression:new GenerationManager('',manifest).refreshExpression(),awaitPromise:true,returnByValue:true});
      if(refresh.exceptionDetails)throw Error('Native cache refresh unverified; retry after app exits');
    }
  }finally{await c.detach();}
}
console.log('Owned adapter/coloring removed from accessible renderers.');
