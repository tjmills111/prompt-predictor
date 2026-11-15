import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHealth, advanceMonitor, classifyGaps } from './health.mjs';
const now=Date.parse('2026-11-04T20:00:00Z');
const status={at:new Date(now).toISOString(),state:'recording',targets:[{connected:true,hooks:['live','catch_up','submission','interaction'],capture:{state:'compatible'},generation:{state:'active'}}],history:{rolloutErrors:[]}};
const options={now,processAlive:true};

test('first healthy monitor run needs no prior state',()=>{const s=advanceMonitor(null,{state:'healthy',issues:[]},now);assert.equal(s.pendingSince,now);assert.equal(s.alert,false);});
test('quiet use and historical gaps do not produce false recording alerts',()=>{assert.equal(evaluateHealth({...status,lastReceipt:'2026-10-01T00:00:00Z',history:{missingSources:36}},options).state,'healthy');});
test('closed app is idle; dead recorder, stale status, missing hooks and inactive generation are detected',()=>{
  assert.equal(evaluateHealth(null,{appRunning:false}).state,'idle_app_closed');
  assert.equal(evaluateHealth(status,{...options,processAlive:false}).issues[0].code,'recorder_stopped_or_stale');
  assert.equal(evaluateHealth(status,{...options,now:now+31000}).state,'attention');
  assert.ok(evaluateHealth({...status,targets:[{...status.targets[0],hooks:[],generation:{state:'error'}}]},options).issues.some(i=>i.code==='generation_inactive'));
});
test('new evidence loss, proxy outage and repeated errors trigger distinct diagnoses',()=>{
  const h=evaluateHealth(status,{...options,newGaps:2,conflicts:1,proxyAvailable:false,recentFailures:3});assert.equal(h.issues.length,4);
});
test('transient faults do not alert; persistent faults alert once, changed faults alert and recovery is recorded',()=>{
  const bad={state:'attention',issues:[{code:'capture_unavailable'}]},good={state:'healthy',issues:[]};
  let state=advanceMonitor(null,bad,now);assert.equal(state.alert,false);
  state=advanceMonitor(state,bad,now+120000);assert.equal(state.alert,true);
  state=advanceMonitor(state,bad,now+240000);assert.equal(state.alert,false);
  state=advanceMonitor(state,good,now+360000);assert.equal(state.recovered,true);
  state=advanceMonitor(state,bad,now+480000);state=advanceMonitor(state,bad,now+600000);assert.equal(state.alert,true);
});
test('historical gap exceptions are fixed identities; losing an old resolved comparison is a new failure',()=>{
  const started=new Date(now-60000).toISOString(),old=new Date(now-3600000).toISOString();
  const first=classifyGaps([{id:'known-gap',first_seen:old}],undefined,started,now);
  const later=classifyGaps([{id:'known-gap',first_seen:old},{id:'newly-lost-old-evidence',first_seen:old}],first.baselineGapIds,started,now);
  assert.equal(later.knownHistoricalGaps,1);assert.equal(later.newGaps,1);
});
test('new saved-message gaps get a grace period without becoming permanent baseline exceptions',()=>{
  const started=new Date(now-60000).toISOString(),rows=[{id:'new-gap',first_seen:new Date(now-10000).toISOString()}];
  const first=classifyGaps(rows,undefined,started,now);assert.equal(first.newGaps,0);assert.deepEqual(first.baselineGapIds,[]);
  assert.equal(classifyGaps(rows,first.baselineGapIds,started,now+130000).newGaps,1);
});

test('another persistent gap alerts while an older warning remains open; recovery before grace does not',()=>{
  const health=ids=>({state:'attention',issues:[{code:'new_comparison_gap',identities:ids}]});
  let s=advanceMonitor(null,health(['old']),now);
  s=advanceMonitor(s,health(['old']),now+60000);assert.equal(s.alert,true);
  s=advanceMonitor(s,health(['old','new']),now+120000);assert.equal(s.alert,false);
  s=advanceMonitor(s,health(['old','new']),now+180000);assert.equal(s.alert,true);
  s=advanceMonitor(s,health(['old','new']),now+240000);assert.equal(s.alert,false);
  s=advanceMonitor(s,health(['old','new','transient']),now+300000);
  s=advanceMonitor(s,health(['old','new']),now+360000);assert.equal(s.alert,false);
  // Once resolved, losing the same record again is a fresh incident.
  s=advanceMonitor(s,health(['old']),now+420000);
  s=advanceMonitor(s,health(['old','new']),now+480000);
  s=advanceMonitor(s,health(['old','new']),now+540000);assert.equal(s.alert,true);
});

test('monitor migration retains disclosed gaps without rebasing the historical exceptions',()=>{
  const h={state:'attention',issues:[{code:'new_comparison_gap',identities:['disclosed']}]};
  const old={pendingKey:'new_comparison_gap',pendingSince:now-120000,alertedKey:'new_comparison_gap'};
  const next=advanceMonitor(old,h,now);assert.equal(next.alert,false);assert.deepEqual(next.alertedGapIds,['disclosed']);
});
