import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { TranscriptHistory, messageOrigin } from './history.mjs';
import { syncHistory } from './history-sync.mjs';

export function nativeKey(p) {
  return p?.responseId ? `response:${p.responseId}` : p?.predictionThreadId && p?.predictionTurnId ? `turn:${p.predictionThreadId}:${p.predictionTurnId}` : null;
}

export class Store {
  constructor(file) {
    this.rollouts = new TranscriptHistory();
    fs.mkdirSync(path.dirname(file), {recursive:true});
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS transport_receipts(key TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS predictions(id TEXT PRIMARY KEY,native_key TEXT,host TEXT,thread_id TEXT,source_turn_id TEXT,text TEXT,raw_json TEXT NOT NULL,first_seen TEXT NOT NULL,last_seen TEXT NOT NULL,sightings INTEGER NOT NULL DEFAULT 1);
      CREATE UNIQUE INDEX IF NOT EXISTS prediction_identity ON predictions(host,thread_id,source_turn_id,native_key) WHERE native_key IS NOT NULL;
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,at TEXT NOT NULL,kind TEXT NOT NULL,prediction_id TEXT,payload_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS submissions(thread_id TEXT,turn_id TEXT,item_id TEXT,text TEXT NOT NULL,raw_json TEXT NOT NULL,created_at_ms INTEGER,ordinal INTEGER,PRIMARY KEY(thread_id,turn_id,item_id));
      CREATE TABLE IF NOT EXISTS pairs(prediction_id TEXT,thread_id TEXT,turn_id TEXT,kind TEXT,PRIMARY KEY(prediction_id,thread_id,turn_id,kind));
      CREATE TABLE IF NOT EXISTS comparison_state(prediction_id TEXT PRIMARY KEY,status TEXT NOT NULL,reason TEXT,thread_id TEXT,turn_id TEXT,item_id TEXT,kind TEXT,origin TEXT,provenance_json TEXT,checked_at TEXT NOT NULL);`);
    this.db.exec('CREATE TABLE IF NOT EXISTS continuation_evidence(prediction_id TEXT PRIMARY KEY,source_json TEXT NOT NULL,target_json TEXT NOT NULL,observed_at TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS continuation_observations(prediction_id TEXT NOT NULL,item_id TEXT NOT NULL,target_json TEXT NOT NULL,observed_at TEXT NOT NULL,PRIMARY KEY(prediction_id,item_id))');
    this.db.prepare('INSERT OR IGNORE INTO meta VALUES (?,?)').run('created_at',new Date().toISOString());
  }
  event(kind,data={},predictionId=null,at=new Date().toISOString()) {
    this.db.prepare('INSERT INTO events(at,kind,prediction_id,payload_json) VALUES(?,?,?,?)').run(at,kind,predictionId,JSON.stringify(data));
  }
  ingest(data,at=new Date().toISOString()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if(data.transportKey) {
        const inserted=this.db.prepare('INSERT OR IGNORE INTO transport_receipts VALUES(?)').run(data.transportKey);
        if(!inserted.changes){this.db.exec('COMMIT');return null;}
      }
      const p=data.prediction, nk=nativeKey(p); let row;
      if (data.kind==='receipt' && p) {
        const host=p.hostKind==='cloud'?'cloud':data.target?.hostId??p.hostKind??'unknown';
        const thread=data.target?.threadId??p.sourceThreadId??null;
        const source=p.sourceTurnId??data.target?.latestTurnId??null;
        row=nk?this.db.prepare('SELECT * FROM predictions WHERE native_key=? AND host=? AND thread_id IS ? AND source_turn_id IS ?').get(nk,host,thread,source):null;
        if(row) {
          this.db.prepare('UPDATE predictions SET last_seen=?,sightings=sightings+1 WHERE id=?').run(at,row.id);
          if(row.text !== (p.text??null)) this.event('identity_text_conflict',data,row.id,at);
        } else {
          row={id:randomUUID()};
          this.db.prepare('INSERT INTO predictions(id,native_key,host,thread_id,source_turn_id,text,raw_json,first_seen,last_seen) VALUES(?,?,?,?,?,?,?,?,?)').run(row.id,nk,host,thread,source,p.text??null,JSON.stringify(p),at,at);
        }
      } else if(nk) {
        const candidates=this.db.prepare('SELECT * FROM predictions WHERE native_key=?').all(nk).filter(x=>!data.threadId || x.thread_id===data.threadId);
        if(candidates.length===1) row=candidates[0];
      }
      this.event(data.kind,data,row?.id??null,at);
      if(data.kind==='submission' && row && data.threadId && data.submittedTurnId) {
        this.db.prepare('INSERT OR IGNORE INTO pairs VALUES(?,?,?,?)').run(row.id,data.threadId,data.submittedTurnId,'native');
      }
      this.db.exec('COMMIT'); return row?.id;
    } catch(e) {this.db.exec('ROLLBACK');throw e;}
  }
  syncHistory(file) { return syncHistory(this, file); }
  unsupportedHosts(){return this.db.prepare("SELECT DISTINCT host FROM predictions WHERE host<>'local'").all().map(r=>r.host);}
  summary() {
    const count=t=>this.db.prepare(`SELECT count(*) n FROM ${t}`).get().n;
    return {predictions:count('predictions'),events:count('events'),submissions:count('submissions'),pairs:count('pairs'),comparisonStates:Object.fromEntries(this.db.prepare('SELECT status,count(*) n FROM comparison_state GROUP BY status').all().map(r=>[r.status,r.n])),lastReceipt:this.db.prepare("SELECT at FROM events WHERE kind='receipt' ORDER BY id DESC LIMIT 1").get()?.at??null,pendingNativePairs:this.db.prepare("SELECT count(*) n FROM pairs p WHERE kind='native' AND NOT EXISTS(SELECT 1 FROM submissions s WHERE s.thread_id=p.thread_id AND s.turn_id=p.turn_id)").get().n};
  }
  export() {
    return this.db.prepare('SELECT * FROM predictions ORDER BY first_seen').all().map(p=>{
      const pairing=this.db.prepare('SELECT * FROM comparison_state WHERE prediction_id=?').get(p.id) ?? {status:'not_checked'};
      const hasSuggestion=typeof p.text==='string'&&p.text.trim().length>0&&p.text.trim()!=='No useful next message suggested.';
      const comparisons=this.db.prepare('SELECT p.kind,s.* FROM pairs p LEFT JOIN submissions s ON s.thread_id=p.thread_id AND s.turn_id=p.turn_id WHERE p.prediction_id=?').all(p.id).map(s=>({...s,origin:s.raw_json?messageOrigin(JSON.parse(s.raw_json)):null,eligible:hasSuggestion&&pairing.status==='paired'&&s.thread_id===pairing.thread_id&&s.turn_id===pairing.turn_id&&s.item_id===pairing.item_id,exactMatch:s.text==null?null:s.text===p.text}));
      const laterObservations=this.db.prepare('SELECT target_json,observed_at FROM continuation_observations WHERE prediction_id=?').all(p.id).map(r=>({target:JSON.parse(r.target_json),observedAt:r.observed_at,kind:'later_history_revision'}));
      return {...p,original:JSON.parse(p.raw_json),hasSuggestion,pairing,comparisons,laterObservations};
    });
  }
  close(){this.db.close();}
}
