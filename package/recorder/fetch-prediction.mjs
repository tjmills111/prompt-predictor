// Explicit native fetch; does not clear native caches, insert text, or submit messages.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { CDP } from './cdp.mjs';

const args = process.argv.slice(2);
const threadId = args.find(a => !a.startsWith('--'))?.match(/(?:codex:\/\/threads\/)?([0-9a-f-]{36})$/i)?.[1];
const savedOnly = args.includes('--saved');
const runtime = path.join(process.env.LOCALAPPDATA, 'GreyPredictionComposer', 'capture');
let connection;
try {
  if (!threadId || args.some(a => a.startsWith('--') && a !== '--saved')) {
    throw Error('Usage: Fetch-Prediction.cmd <thread ID or codex://threads/ID> [--saved]');
  }
  if (savedOnly) {
    const db = new DatabaseSync(path.join(runtime, 'records.sqlite3'), { readOnly: true });
    try {
      const row = db.prepare('SELECT source_turn_id, raw_json, first_seen FROM predictions WHERE thread_id=? ORDER BY last_seen DESC LIMIT 1').get(threadId);
      if (!row) throw Error('No saved native result for this chat. This does not prove no request occurred.');
      console.log(JSON.stringify({ mode: 'saved-only', threadId, ...row, raw_json: JSON.parse(row.raw_json) }, null, 2));
    } finally { db.close(); }
  } else {
    const history = new DatabaseSync(path.join(process.env.USERPROFILE, '.codex', 'thread_history_1.sqlite'), { readOnly: true });
    let turn;
    try {
      turn = history.prepare('SELECT turn_id, status FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1').get(threadId);
    } finally { history.close(); }
    if (!turn) throw Error('No local turn history for this chat. Cloud/remote chats are unsupported by this helper.');
    if (turn.status !== 'completed') throw Error(`Latest turn is ${turn.status}. Wait for the reply to finish, then fetch. No request sent.`);
    const targets = await (await fetch('http://127.0.0.1:19227/json/list', { signal: AbortSignal.timeout(5000) })).json();
    const pages = targets.filter(t => t.type === 'page' && t.url === 'app://-/index.html');
    if (pages.length !== 1) throw Error(`Expected one app renderer; found ${pages.length}. No request sent.`);
    connection = new CDP(pages[0].webSocketDebuggerUrl);
    connection.on('fault', e => console.error(e.message));
    await connection.open();
    const evaluate = async expression => {
      const result = await connection.call('Runtime.evaluate', { expression, returnByValue: true });
      if (result.exceptionDetails) throw Error(result.exceptionDetails.text || 'Native evaluation failed');
      return result.result.value;
    };
    const key = '__composerManualFetch_' + crypto.randomUUID().replaceAll('-', '');
    const target = { hostId: 'local', threadId, latestTurnId: turn.turn_id, generationTrigger: 'catch_up' };
    // Share the reviewed profile; obsolete module names must not drift independently.
    const profile = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'manifest.json'), 'utf8')).generation;
    await evaluate(`(()=>{globalThis[${JSON.stringify(key)}]={done:false};(async()=>{try{const m=await import(${JSON.stringify(profile.moduleUrl)});const pick=b=>typeof b==='string'?m[b]:m.__webpack_require__(b.moduleId)[b.export];const services=pick(${JSON.stringify(profile.bindings.services)}),consume=pick(${JSON.stringify(profile.bindings.consume)});if(typeof services?.cumberbatch?.requestUserMessagePrediction!=='function'||typeof consume!=='function')throw Error('Unsupported app build');const result=await consume(services.cumberbatch.requestUserMessagePrediction(${JSON.stringify(target)}));globalThis[${JSON.stringify(key)}]={done:true,result};}catch(e){globalThis[${JSON.stringify(key)}]={done:true,error:String(e)};}})();return true;})()`);
    console.log('Native fetch requested. A cached result may be reused; this does not force regeneration.');
    let result;
    // Allow configuration, fork preparation and cleanup outside the engine's generation timer.
    const maxWaitSeconds = Math.ceil(profile.timeoutMs / 1000) + 30;
    for (let i = 0; i < maxWaitSeconds; i++) {
      const state = await evaluate(`globalThis[${JSON.stringify(key)}]`);
      if (state?.done) { result = state; break; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!result) {
      // Clean up after the ongoing native request settles, without cancelling it.
      await evaluate(`(()=>{const timer=setInterval(()=>{if(globalThis[${JSON.stringify(key)}]?.done){delete globalThis[${JSON.stringify(key)}];clearInterval(timer);}},1000);return true;})()`);
      throw Error(`No result within ${maxWaitSeconds} seconds. The native request was not cancelled; this is not evidence of an empty result.`);
    }
    await evaluate(`delete globalThis[${JSON.stringify(key)}]`);
    if (result.error) throw Error(result.error);
    const record = { mode: 'manual-native-fetch', at: new Date().toISOString(), ...target, result: result.result };
    fs.mkdirSync(runtime, { recursive: true });
    fs.appendFileSync(path.join(runtime, 'manual-fetches.jsonl'), JSON.stringify(record) + '\n');
    console.log(JSON.stringify(record, null, 2));
    console.log(result.result?.text ? '\n' + result.result.text : 'Native service returned no suggestion text.');
    console.log('Result saved in runtime capture/manual-fetches.jsonl. This helper does not insert grey text or send a message.');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (connection) console.log(JSON.stringify({ diagnosticConnection: await connection.detach() }));
}
