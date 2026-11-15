import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RolloutIndex, TranscriptHistory, messageOrigin } from './history.mjs';
import { zstdCompressSync } from 'node:zlib';

test('incremental log parsing handles split UTF-8, partial appends and repeated reads',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'composer-history-'));
  try {
    const file=path.join(dir,'rollout.jsonl'),index=new RolloutIndex();
    const row=Buffer.from(JSON.stringify({type:'event_msg',timestamp:'2026-11-04T00:00:00Z',payload:{type:'item_completed',thread_id:'chat',turn_id:'turn',item:{type:'UserMessage',id:'msg',content:[{type:'text',text:'Nuance 🧠 preserved'}]}}})+'\n');
    const split=row.indexOf(Buffer.from('🧠'))+2;
    fs.writeFileSync(file,row.subarray(0,split));assert.equal(index.read(file,'chat').users.length,0);
    fs.appendFileSync(file,row.subarray(split));assert.equal(index.read(file,'chat').users.length,1);
    assert.equal(index.read(file,'chat').users.length,1);
    assert.match(index.read(file,'chat').users[0].item_json,/🧠/);
    fs.writeFileSync(file,'');assert.equal(index.read(file,'chat').users.length,0);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
test('malformed complete logs fail visibly and are not silently skipped on retry',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'composer-history-'));
  try {const file=path.join(dir,'rollout.jsonl'),index=new RolloutIndex();fs.writeFileSync(file,'{broken}\n');assert.throws(()=>index.read(file,'chat'),/Invalid completed/);assert.throws(()=>index.read(file,'chat'),/Invalid completed/);}
  finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('a human quoting a heartbeat is not classified as automation',()=>{
  const item={clientId:'actual-client',content:[{type:'text',text:'<heartbeat><automation_id>x</automation_id><instructions>x</instructions></heartbeat>'}]};
  assert.equal(messageOrigin(item),'user');
  assert.equal(messageOrigin({...item,clientId:null}),'automation');
});

test('compressed predecessor segments and fork cutoffs reconstruct only declared ancestry',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'composer-lineage-'));
  const parent='11111111-1111-4111-8111-111111111111',segment='22222222-2222-4222-8222-222222222222',child='33333333-3333-4333-8333-333333333333';
  const root=path.join(dir,'sessions');fs.mkdirSync(root);
  const meta=(id,base)=>({ordinal:0,type:'session_meta',payload:{id,history_base:base}});
  const item=(tid,turn,id,ordinal,text)=>({ordinal,timestamp:'2026-11-14T12:00:01Z',type:'event_msg',payload:{type:'item_completed',thread_id:tid,turn_id:turn,item:{type:text?'UserMessage':'AgentMessage',id,content:[{type:'text',text}]}}});
  const save=(name,rows,compressed=false)=>{const file=path.join(root,name),bytes=Buffer.from(rows.map(JSON.stringify).join('\n')+'\n');fs.writeFileSync(file,compressed?zstdCompressSync(bytes):bytes);return file;};
  try {
    save(`rollout-date-${parent}.jsonl.zst`,[meta(parent),item(parent,'old-source','assistant',5),item(parent,'wrong-parent-reply','wrong',30,'Must never borrow this')],true);
    save(`rollout-date-${parent}_${segment}.jsonl`,[meta(parent,{thread_id:parent,end_ordinal_exclusive:10}),item(parent,'source','assistant2',15),item(parent,'parent-next','parent-message',50,'Also outside fork cutoff')]);
    const file=save(`rollout-date-${child}.jsonl`,[meta(child,{thread_id:segment,end_ordinal_exclusive:20}),item(child,'child-next','child-message',25,'Exact child reply\n🧠')]);
    const reader=new TranscriptHistory(),log=reader.read(file,child,dir);
    assert.deepEqual([...log.turns.keys()],['old-source','source','child-next']);
    assert.equal(log.users.length,1);assert.equal(log.users[0].thread_id,child);
    assert.match(log.users[0].item_json,/Exact child reply\\n🧠/);
    assert.ok(log.turns.get('source').provenance.historyBase);
    // A replaced source still has explicit proof in its original segment.
    const historical=reader.source(parent,'old-source',dir);
    assert.equal(historical.users[0].item_id,'wrong');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('compressed corruption fails visibly; metadata mismatch and cyclic ancestry are rejected',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'composer-bad-history-'));
  try {
    const file=path.join(dir,'bad.jsonl.zst');fs.writeFileSync(file,'invalid zstd');
    assert.throws(()=>new RolloutIndex().read(file,'chat'));
    const json=path.join(dir,'wrong.jsonl');fs.writeFileSync(json,JSON.stringify({type:'session_meta',payload:{id:'other'}})+'\n');
    assert.throws(()=>new TranscriptHistory().read(json,'chat',dir),/identity mismatch/);
    const id='11111111-1111-4111-8111-111111111111';fs.mkdirSync(path.join(dir,'sessions'));
    const cycle=path.join(dir,'sessions',`rollout-date-${id}.jsonl`);
    fs.writeFileSync(cycle,JSON.stringify({type:'session_meta',payload:{id,history_base:{thread_id:id,end_ordinal_exclusive:4}}})+'\n');
    assert.throws(()=>new TranscriptHistory().read(cycle,id,dir),/Cyclic/);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
