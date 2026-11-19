import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installBrowserAdapter} from './browser-adapter.mjs';
import {installPredictionColor} from '../recorder/presentation.mjs';

test('actual adapter tags its full-prompt fetch and preserves remote native fallback',async()=>{
  const previous=globalThis.window;globalThis.window=new EventTarget();
  const moduleUrl='data:text/javascript,'+encodeURIComponent(`
    export let lastRequest;export let fallbackCalls=0;let tagged=true;
    export const dropReceipt=()=>{tagged=false};
    export class Callback{constructor(fn){this.fn=fn}}
    export const bridge={subscribe:()=>()=>{},dispatchMessage:()=>{}};
    export const consume=async x=>await x;
    export const services={
      cumberbatch:{isEnabledByRemoteConfig:async()=>true,requestUserMessagePrediction:async()=>{fallbackCalls++;return 'native';}},
      httpFetch:{fetch:async(id,request)=>{lastRequest=request;return {response:{ok:true,json:async()=>({prompt:'full-fixture',is_enabled:true,_prompt_predictor_route:tagged?'fork-v1':undefined})}}}},
      settings:{subscribe:async(key,cb)=>{cb.fn({effective:true});return {unsubscribe:async()=>{}}}},
      statsigEvaluations:{subscribe:async cb=>{cb.fn({payload:'{}'});return {unsubscribe:async()=>{}}}}
    };
  `);
  const module=await import(moduleUrl);
  const profile={revision:'route-test',moduleUrl,bindings:{services:'services',callback:'Callback',bridge:'bridge',consume:'consume'}};
  try{
    await installBrowserAdapter(profile,deps=>({request:async()=>deps.getConfig(),notify(){},abortAll(){},dispose(){},status:()=>({jobs:0})}));
    const result=await module.services.cumberbatch.requestUserMessagePrediction({hostId:'local'});
    assert.equal(result.prompt,'full-fixture');
    assert.deepEqual(module.lastRequest.headers,{'x-prompt-predictor-route':'fork-v1','x-predictor-local-cache':'1'});
    assert.equal(await module.services.cumberbatch.requestUserMessagePrediction({hostId:'ssh'}),'native');
    assert.equal(module.fallbackCalls,1);
    module.dropReceipt();
    await assert.rejects(module.services.cumberbatch.requestUserMessagePrediction({hostId:'local'}),/Custom prompt receipt missing/);
    assert.equal(globalThis.__COMPOSER_ASTRA_ADAPTER.owner,'prompt-predictor-prototype-v1');
  }finally{await globalThis.__COMPOSER_ASTRA_ADAPTER?.dispose();globalThis.window=previous;}
});

test('actual presentation disposal removes listeners, observer, style and highlight',async()=>{
  const keys=['document','CSS','Highlight','MutationObserver'];
  const prior=Object.fromEntries(keys.map(k=>[k,globalThis[k]]));
  const document=new EventTarget();let removed=false,disconnected=false,signals=[];
  const add=document.addEventListener.bind(document);
  document.addEventListener=(name,fn,options)=>{signals.push(options.signal);add(name,fn,options);};
  document.getElementById=()=>null;document.createElement=()=>({remove(){removed=true}});
  document.head={append(){}};document.body={};
  globalThis.document=document;globalThis.CSS={highlights:new Map()};globalThis.Highlight=class{};
  globalThis.MutationObserver=class{observe(){}disconnect(){disconnected=true}};
  try{
    await installPredictionColor();
    CSS.highlights.set('prompt-predictor-origin',{});
    globalThis.__PROMPT_PREDICTOR_PRESENTATION.dispose();
    assert.ok(signals.length===2&&signals.every(s=>s.aborted));
    assert.ok(removed&&disconnected);assert.equal(CSS.highlights.size,0);
    assert.equal(globalThis.__PROMPT_PREDICTOR_PRESENTATION,undefined);
  }finally{for(const key of keys){if(prior[key]===undefined)delete globalThis[key];else globalThis[key]=prior[key];}}
});
