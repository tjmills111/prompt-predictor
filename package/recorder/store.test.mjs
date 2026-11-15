import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from './store.mjs';
function fixture(fn){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'composer-recorder-test-'));const store=new Store(path.join(dir,'records.sqlite3'));try{fn(store,dir);}finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}}
const prediction={text:'Original\nverbatim',predictionThreadId:'prediction-thread',predictionTurnId:'prediction-turn',sourceTurnId:'source',generationTrigger:'live'};
const receipt={kind:'receipt',target:{hostId:'local',threadId:'chat',latestTurnId:'source',generationTrigger:'catch_up'},prediction};
const at='2026-10-26T20:00:00.000Z';
function history(dir,rows=[]){const file=path.join(dir,'history.sqlite3'),h=new DatabaseSync(file);h.exec(`CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,rollout_ordinal INTEGER);CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER,item_json TEXT,item_type TEXT);INSERT INTO thread_turns VALUES('chat','source',1);`);for(const r of rows)h.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?)').run('chat',r.turn??'sent',r.id??'message',r.ordinal??3,r.time??Date.parse(at)+1000,JSON.stringify({type:'userMessage',id:r.id??'message',content:[{type:'text',text:r.text}]}),'userMessage');h.close();return file;}
test('cache replay deduplicates identity but preserves sightings and immutable original',()=>fixture(s=>{s.ingest(receipt,at);s.ingest(receipt,at);assert.equal(s.summary().predictions,1);assert.equal(s.export()[0].sightings,2);s.ingest({...receipt,prediction:{...prediction,text:'changed'}},at);assert.equal(s.export()[0].text,prediction.text);assert.equal(s.db.prepare("SELECT count(*) n FROM events WHERE kind='identity_text_conflict'").get().n,1);}));
test('identical wording with different native IDs remains separate; unsent originals remain',()=>fixture((s,d)=>{s.ingest(receipt,at);s.ingest({...receipt,prediction:{...prediction,predictionTurnId:'other'}},at);s.syncHistory(history(d));assert.equal(s.summary().predictions,2);assert.equal(s.summary().pairs,0);}));
test('ignored original gets contextual comparison without false native acceptance',()=>fixture((s,d)=>{s.ingest(receipt,at);s.syncHistory(history(d,[{text:'Different actual message\n'}]));const x=s.export()[0];assert.equal(x.comparisons[0].kind,'contextual');assert.equal(x.comparisons[0].exactMatch,false);assert.equal(x.comparisons[0].text,'Different actual message\n');}));
test('native pairing waits for persisted message and survives reopen',()=>fixture((s,d)=>{s.ingest(receipt,at);s.ingest({kind:'submission',threadId:'chat',submittedTurnId:'sent',prediction,outcome:'accepted',edited:true},at);assert.equal(s.summary().pendingNativePairs,1);const file=history(d,[{text:'Edited wording'}]);s.syncHistory(file);assert.equal(s.summary().pendingNativePairs,0);assert.equal(s.export()[0].comparisons.find(x=>x.kind==='native').text,'Edited wording');const second=new Store(path.join(d,'records.sqlite3'));assert.equal(second.summary().predictions,1);second.close();}));
test('a cached result observed after a send is not retroactively context-paired',()=>fixture((s,d)=>{s.ingest(receipt,at);s.syncHistory(history(d,[{text:'Already sent',time:Date.parse(at)-1000}]));assert.equal(s.summary().pairs,0);}));
test('source-turn order wins over timestamp proximity; repeated sync idempotent',()=>fixture((s,d)=>{s.ingest(receipt,at);const file=history(d,[{text:'first',ordinal:3,time:Date.parse(at)+5000},{text:'later',ordinal:5,time:Date.parse(at)+1000,turn:'later',id:'m2'}]);s.syncHistory(file);s.syncHistory(file);const x=s.export()[0];assert.equal(x.comparisons.length,1);assert.equal(x.comparisons[0].text,'first');assert.equal(s.summary().submissions,2);}));
test('remote originals are preserved with unsupported local history coverage explicit',()=>fixture((s,d)=>{s.ingest({...receipt,target:{...receipt.target,hostId:'remote'}},at);const result=s.syncHistory(history(d));assert.deepEqual(result.unsupportedHosts,['remote']);assert.equal(s.summary().predictions,1);assert.equal(s.summary().pairs,0);}));
// Transport replay is different from receiving the same cached native result again.
test('debugger console-buffer replay is ignored while new receipt events remain',()=>fixture(s=>{s.ingest({...receipt,transportKey:'packet-1'},at);s.ingest({...receipt,transportKey:'packet-1'},at);assert.equal(s.export()[0].sightings,1);s.ingest({...receipt,transportKey:'packet-2'},at);assert.equal(s.export()[0].sightings,2);}));

function rollout(dir, rows) {
  const file=path.join(dir,'rollout.jsonl'),state=new DatabaseSync(path.join(dir,'state_5.sqlite'));
  state.exec('CREATE TABLE threads(id TEXT,rollout_path TEXT)');
  state.prepare('INSERT INTO threads VALUES(?,?)').run('chat',file);state.close();
  fs.writeFileSync(file,rows.map(row=>JSON.stringify(row)).join('\n')+'\n{"unfinished":');
}
const nativeUser=(thread='chat',turn='sent')=>({timestamp:at,type:'event_msg',payload:{type:'item_completed',thread_id:thread,turn_id:turn,item:{type:'UserMessage',id:'actual-message',content:[{type:'text',text:'Exact edited wording\n'}]}}});
test('missing native message is recovered by explicit thread/turn identity, preserving text and provenance',()=>fixture((s,d)=>{
  s.ingest(receipt,at);s.ingest({kind:'submission',threadId:'chat',submittedTurnId:'sent',prediction},at);
  rollout(d,[nativeUser('other'),nativeUser('chat','other-turn'),{type:'response_item',payload:{role:'user',content:[{type:'text',text:'Injected context'}]}},nativeUser()]);
  const file=history(d),result=s.syncHistory(file);
  assert.equal(result.recoveredFromRollout,1);assert.equal(s.summary().pendingNativePairs,0);
  const comparisons=s.export()[0].comparisons;
  assert.equal(comparisons.length,1);assert.equal(comparisons[0].kind,'native');assert.equal(comparisons[0].text,'Exact edited wording\n');assert.equal(comparisons[0].ordinal,null);
  const evidence=JSON.parse(s.db.prepare("SELECT payload_json FROM events WHERE kind='history_rollout_recovered'").get().payload_json);
  assert.equal(evidence.itemId,'actual-message');assert.equal(evidence.line,4);
  assert.equal(s.syncHistory(file).recoveredFromRollout,0);
}));
test('rollout recovery never substitutes a different turn or model-input context',()=>fixture((s,d)=>{
  s.ingest(receipt,at);s.ingest({kind:'submission',threadId:'chat',submittedTurnId:'sent',prediction},at);
  rollout(d,[nativeUser('other'),nativeUser('chat','other-turn'),{type:'response_item',payload:{role:'user',content:[{type:'text',text:'Not an actual native submission'}]}}]);
  assert.equal(s.syncHistory(history(d)).recoveredFromRollout,0);assert.equal(s.summary().pendingNativePairs,1);assert.equal(s.summary().submissions,0);
}));

const heartbeat='<heartbeat>\n<automation_id>monitor</automation_id><current_time_iso>2026-10-26T20:00:01Z</current_time_iso><instructions>Check status</instructions>\n</heartbeat>';
test('heartbeat is retained but excluded, and is never skipped to a later human prompt',()=>fixture((s,d)=>{
  s.ingest(receipt,at);
  const file=history(d,[{text:heartbeat},{text:'Human after automation',turn:'later',id:'later',ordinal:5}]);
  s.syncHistory(file);
  assert.equal(s.summary().submissions,2);
  assert.equal(s.export()[0].pairing.status,'excluded_automation');
  assert.equal(s.export()[0].comparisons.length,0);
}));
test('old contextual link to automation stays as evidence and becomes ineligible',()=>fixture((s,d)=>{
  const id=s.ingest(receipt,at);s.db.prepare('INSERT INTO pairs VALUES(?,?,?,?)').run(id,'chat','sent','contextual');
  s.syncHistory(history(d,[{text:heartbeat}]));
  assert.equal(s.export()[0].comparisons[0].eligible,false);
  assert.equal(s.export()[0].comparisons[0].origin,'automation');
}));
test('missing indexed source recovers ignored suggestion and immediate actual from original log',()=>fixture((s,d)=>{
  s.ingest(receipt,at);
  const source=nativeUser('chat','source');source.payload.item={type:'AgentMessage',id:'answer',text:'Completed answer'};
  const actual=nativeUser();actual.timestamp='2026-10-26T20:00:01.000Z';
  rollout(d,[source,actual]);
  const file=history(d);const db=new DatabaseSync(file);db.exec('DELETE FROM thread_turns');db.close();
  const r=s.syncHistory(file);
  assert.equal(r.missingSources,0);assert.equal(r.indexedSourceGaps,1);
  assert.equal(s.export()[0].pairing.status,'paired');
  assert.equal(s.export()[0].comparisons[0].text,'Exact edited wording\n');
  assert.equal(s.export()[0].pairing.kind,'contextual');
}));
test('native target with several messages remains ambiguous rather than choosing wording',()=>fixture((s,d)=>{
  s.ingest(receipt,at);s.ingest({kind:'submission',threadId:'chat',submittedTurnId:'sent',prediction},at);
  s.syncHistory(history(d,[{text:'first'},{text:'second',id:'steering',ordinal:4}]));
  assert.equal(s.export()[0].pairing.status,'ambiguous');
  assert.ok(s.export()[0].comparisons.every(x=>!x.eligible));
}));
test('question replies and voice wrappers are retained without being scored as next prompts',()=>fixture((s,d)=>{
  s.ingest(receipt,at);
  s.syncHistory(history(d,[{text:'<send_user_message_question_reply>response</send_user_message_question_reply>'}]));
  assert.equal(s.export()[0].pairing.status,'excluded_question_reply');
}));

test('late source tool events never hop over an intervening question reply',()=>fixture((s,d)=>{
  s.ingest(receipt,at);
  const source={type:'event_msg',timestamp:at,payload:{type:'item_completed',thread_id:'chat',turn_id:'source',item:{type:'AgentMessage',id:'assistant'}}};
  const question=nativeUser('chat','question');question.timestamp='2026-10-26T20:00:01Z';question.payload.item.content[0].text='<send_user_message_question_reply>Yes</send_user_message_question_reply>';
  const later=nativeUser();later.timestamp='2026-10-26T20:00:03Z';
  rollout(d,[source,question,{...source,payload:{...source.payload,item:{type:'ToolCall',id:'late-tool'}}},later]);
  s.syncHistory(history(d));assert.equal(s.export()[0].pairing.status,'excluded_question_reply');
  assert.equal(s.export()[0].pairing.item_id,question.payload.item.id);
}));

test('contextual evidence survives deletion and restart without borrowing a later message',()=>fixture((s,d)=>{
  s.ingest(receipt,at);const file=history(d,[{text:'Exact first reply\n🧠'}]);s.syncHistory(file);
  const h=new DatabaseSync(file);h.exec('DELETE FROM thread_turns; DELETE FROM thread_items');h.close();
  const reopened=new Store(path.join(d,'records.sqlite3'));
  try {reopened.syncHistory(file);reopened.syncHistory(file);const p=reopened.export()[0];assert.equal(p.pairing.status,'paired');assert.equal(p.comparisons.find(c=>c.eligible).text,'Exact first reply\n🧠');}finally{reopened.close();}
}));

test('a history edit preserves the observed immediate send and stores its replacement separately',()=>fixture((s,d)=>{
  s.ingest(receipt,at);const file=history(d,[{text:'Actually sent first'}]);s.syncHistory(file);
  const h=new DatabaseSync(file);h.exec('DELETE FROM thread_items');h.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?)').run('chat','edited','replacement',3,Date.parse(at)+2000,JSON.stringify({type:'userMessage',id:'replacement',content:[{type:'text',text:'Edited later'}]}),'userMessage');h.close();
  s.syncHistory(file);s.syncHistory(file);const p=s.export()[0];
  assert.equal(p.pairing.item_id,'message');assert.equal(p.comparisons.find(c=>c.eligible).text,'Actually sent first');assert.equal(p.laterObservations.length,1);assert.equal(JSON.parse(p.laterObservations[0].target.item_json).content[0].text,'Edited later');
  assert.ok(p.pairing.provenance_json.length<1000);
}));

test('recovering the same exact text from a different native serialization preserves original raw evidence',()=>fixture((s,d)=>{
  s.ingest(receipt,at);const file=history(d,[{text:'Exact edited wording\n'}]);s.syncHistory(file);
  const original=s.db.prepare('SELECT raw_json FROM submissions').get().raw_json;
  const user=nativeUser();user.timestamp='2026-10-26T20:00:01Z';user.payload.item.id='message';user.payload.item.client_id='native-client';
  rollout(d,[user]);s.syncHistory(file);
  assert.equal(s.db.prepare('SELECT raw_json FROM submissions WHERE item_id=?').get('message').raw_json,original);
}));
