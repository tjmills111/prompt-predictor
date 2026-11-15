// Read-only guard for restoring from the still-open Codex setup chat after removal.
import {CDP} from '../recorder/cdp.mjs';
const endpoint=new URL(process.env.COMPOSER_RECORDER_ENDPOINT??'http://127.0.0.1:19227/json/list');
if(endpoint.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname))throw Error('Restore endpoint must be loopback');
const response=await fetch(endpoint,{signal:AbortSignal.timeout(2500)});
if(!response.ok)throw Error('Cannot verify removed renderer state');
const targets=(await response.json()).filter(t=>t.type==='page'&&t.url==='app://-/index.html');
if(!targets.length)throw Error('No Codex renderer to verify; occupied debug port is unsupported');
for(const target of targets){
  const client=new CDP(target.webSocketDebuggerUrl);
  try{
    await client.open();
    const result=await client.call('Runtime.evaluate',{expression:'({adapter:!!globalThis.__COMPOSER_ASTRA_ADAPTER,coloring:!!globalThis.__PROMPT_PREDICTOR_PRESENTATION})',returnByValue:true});
    if(result.exceptionDetails||!result.result?.value)throw Error('Removed renderer state could not be verified');
    if(result.result.value.adapter||result.result.value.coloring)throw Error('Renderer still has prediction integration; finish removal before Restore');
  }finally{await client.detach();}
}
console.log('Read-only check: prior adapter/coloring absent.');
