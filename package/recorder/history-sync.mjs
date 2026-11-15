import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { messageText, messageOrigin, assessTarget } from './history.mjs';

export function syncHistory(store, file) {
  const watched = store.db.prepare("SELECT * FROM predictions WHERE host='local' AND thread_id IS NOT NULL AND source_turn_id IS NOT NULL").all();
  const result = { watched: watched.length, submissions: 0, recoveredFromRollout: 0, missingSources: 0, indexedSourceGaps: 0, rolloutErrors: [], outcomes: {}, unsupportedHosts: store.unsupportedHosts() };
  if (!watched.length) return result;
  const history = fs.existsSync(file) ? new DatabaseSync(file, { readOnly: true }) : null;
  const stateFile = path.join(path.dirname(file), 'state_5.sqlite');
  const state = fs.existsSync(stateFile) ? new DatabaseSync(stateFile, { readOnly: true }) : null;
  try {
    history?.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000');
    state?.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000');
    const findTurn = history?.prepare('SELECT rollout_ordinal FROM thread_turns WHERE thread_id=? AND turn_id=?');
    const messages = history?.prepare("SELECT * FROM thread_items WHERE thread_id=? AND item_type='userMessage' AND rollout_ordinal>? ORDER BY rollout_ordinal");
    const exact = history?.prepare("SELECT * FROM thread_items WHERE thread_id=? AND turn_id=? AND item_type='userMessage' ORDER BY rollout_ordinal");
    const lookup = state?.prepare('SELECT rollout_path FROM threads WHERE id=?');
    const transcripts = new Map();
    // Read native files before starting the write transaction, once per thread.
    for (const threadId of new Set(watched.map(p => p.thread_id))) {
      const log = lookup?.get(threadId)?.rollout_path;
      {
        try { const transcript = store.rollouts.read(log, threadId, path.dirname(file)); if (transcript) transcripts.set(threadId, transcript); }
        catch (error) { result.rolloutErrors.push({ threadId, error: String(error) }); }
      }
    }
    if (!history && !transcripts.size) throw Error('Local history and saved transcript evidence unavailable');
    const save = store.db.prepare('INSERT INTO submissions VALUES(?,?,?,?,?,?,?) ON CONFLICT(thread_id,turn_id,item_id) DO UPDATE SET raw_json=CASE WHEN submissions.text<>excluded.text THEN excluded.raw_json ELSE submissions.raw_json END,text=excluded.text,created_at_ms=excluded.created_at_ms,ordinal=excluded.ordinal');
    const decision = store.db.prepare('INSERT INTO comparison_state VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(prediction_id) DO UPDATE SET status=excluded.status,reason=excluded.reason,thread_id=excluded.thread_id,turn_id=excluded.turn_id,item_id=excluded.item_id,kind=excluded.kind,origin=excluded.origin,provenance_json=excluded.provenance_json,checked_at=excluded.checked_at');
    const seen = new Set();
    function persist(row) {
      const key = JSON.stringify([row.thread_id, row.turn_id, row.item_id]);
      if (seen.has(key)) return;
      seen.add(key);
      const item = JSON.parse(row.item_json), text = messageText(item);
      const previous = store.db.prepare('SELECT text,raw_json FROM submissions WHERE thread_id=? AND turn_id=? AND item_id=?').get(row.thread_id, row.turn_id, row.item_id);
      if (previous && previous.text !== text) store.event('persisted_message_changed', { threadId: row.thread_id, turnId: row.turn_id, itemId: row.item_id, previousRaw: previous.raw_json });
      save.run(row.thread_id, row.turn_id, row.item_id, text, row.item_json, row.created_at_ms, row.provenance ? null : row.rollout_ordinal);
      result.submissions++;
      if (row.provenance && !previous) {
        result.recoveredFromRollout++;
        store.event('history_rollout_recovered', { threadId: row.thread_id, turnId: row.turn_id, itemId: row.item_id, ...row.provenance });
      }
    }
    store.db.exec('BEGIN IMMEDIATE');
    try {
      for (const p of watched) {
        const indexedSource = findTurn?.get(p.thread_id, p.source_turn_id);
        if (!indexedSource) result.indexedSourceGaps++;
        let log = transcripts.get(p.thread_id), logSource = log?.turns.get(p.source_turn_id);
        if (!logSource) {
          const historical = store.rollouts.source(p.thread_id, p.source_turn_id, path.dirname(file));
          if (historical) { log = historical; logSource = log.turns.get(p.source_turn_id); }
        }
        // Later asynchronous tool items can still carry the source turn ID.
        // Do not let those items move the boundary past an intervening reply.
        let rows = logSource ? log.users.filter(r => r.rollout_ordinal > logSource.start && r.turn_id !== p.source_turn_id) : indexedSource ? messages.all(p.thread_id, indexedSource.rollout_ordinal).filter(r => r.turn_id !== p.source_turn_id) : [];
        for (const row of rows.filter(r => r.created_at_ms >= Date.parse(p.first_seen))) persist(row);
        const native = store.db.prepare("SELECT DISTINCT thread_id,turn_id FROM pairs WHERE prediction_id=? AND kind='native'").all(p.id);
        let assessment, kind = native.length ? 'native' : 'contextual';
        if (native.length > 1) assessment = { status: 'ambiguous', reason: 'Multiple native submitted turns' };
        else if (native.length === 1) {
          const target = native[0];
          const fromLog = transcripts.get(target.thread_id)?.users.filter(r => r.turn_id === target.turn_id) ?? [];
          const indexed = exact?.all(target.thread_id, target.turn_id) ?? [];
          // Previously verified saved items remain evidence when the app later
          // removes an old log/index. Do not turn retained proof into a new gap.
          const retained = store.db.prepare('SELECT thread_id,turn_id,item_id,raw_json AS item_json,created_at_ms,ordinal AS rollout_ordinal FROM submissions WHERE thread_id=? AND turn_id=? ORDER BY ordinal').all(target.thread_id, target.turn_id);
          const targets = fromLog.length ? fromLog : indexed.length ? indexed : retained;
          for (const row of targets) persist(row);
          assessment = targets.length ? assessTarget(targets, p.first_seen) : { status: 'missing_native_message', reason: 'Native link exists, exact saved user item is unavailable' };
        } else if (!logSource && !indexedSource) {
          const evidence = store.db.prepare('SELECT target_json FROM continuation_evidence WHERE prediction_id=?').get(p.id);
          const previous = store.db.prepare('SELECT * FROM comparison_state WHERE prediction_id=?').get(p.id);
          const retained = previous?.kind === 'contextual' && previous.item_id ? store.db.prepare('SELECT thread_id,turn_id,item_id,raw_json AS item_json,created_at_ms,ordinal AS rollout_ordinal FROM submissions WHERE thread_id=? AND turn_id=? AND item_id=?').get(previous.thread_id,previous.turn_id,previous.item_id) : null;
          if (evidence) {
            assessment = assessTarget([JSON.parse(evidence.target_json)], p.first_seen);
          } else if (retained) {
            retained.provenance = previous.provenance_json ? JSON.parse(previous.provenance_json) : { retainedComparison: { predictionId:p.id, checkedAt:previous.checked_at } };
            assessment = assessTarget([retained], p.first_seen);
            store.db.prepare('INSERT OR IGNORE INTO continuation_evidence VALUES(?,?,?,?)').run(p.id,JSON.stringify({retainedDecision:previous}),JSON.stringify(retained),new Date().toISOString());
          } else {
            result.missingSources++;
            assessment = { status: 'source_unavailable', reason: 'Source turn absent from available transcript lineage, history index and retained comparison evidence' };
          }
        } else {
          // Inspect the immediate item. Never hop across an automated run,
          // question response or an already-sent message to improve the match.
          const previous = store.db.prepare("SELECT * FROM comparison_state WHERE prediction_id=? AND kind='contextual' AND item_id IS NOT NULL").get(p.id);
          const retained = previous && store.db.prepare('SELECT thread_id,turn_id,item_id,raw_json AS item_json,created_at_ms,ordinal AS rollout_ordinal FROM submissions WHERE thread_id=? AND turn_id=? AND item_id=?').get(previous.thread_id,previous.turn_id,previous.item_id);
          // Edited history may remove an already observed sent item. Preserve
          // that original immediate comparison; record the revision separately.
          if (retained && !rows.some(r => r.item_id === retained.item_id)) {
            if (rows[0] && rows[0].item_id !== retained.item_id) store.db.prepare('INSERT OR IGNORE INTO continuation_observations VALUES(?,?,?,?)').run(p.id,rows[0].item_id,JSON.stringify(rows[0]),new Date().toISOString());
            retained.provenance = previous.provenance_json ? JSON.parse(previous.provenance_json) : { retainedComparison: { predictionId:p.id, checkedAt:previous.checked_at } };
            rows = [retained];
          }
          assessment = assessTarget(rows.slice(0, 1), p.first_seen);
          if (rows.length) {
            const prior = store.db.prepare('SELECT target_json FROM continuation_evidence WHERE prediction_id=?').get(p.id);
            const target = JSON.stringify(rows[0]);
            if (prior && JSON.parse(prior.target_json).item_id !== rows[0].item_id) store.event('continuation_selection_changed',{previousTarget:JSON.parse(prior.target_json),target:rows[0]},p.id);
            store.db.prepare('INSERT INTO continuation_evidence VALUES(?,?,?,?) ON CONFLICT(prediction_id) DO UPDATE SET source_json=excluded.source_json,target_json=excluded.target_json,observed_at=excluded.observed_at').run(p.id,JSON.stringify({threadId:p.thread_id,turnId:p.source_turn_id,transcript:logSource,indexed:indexedSource}),target,new Date().toISOString());
          }
          if (assessment.status === 'paired') store.db.prepare('INSERT OR IGNORE INTO pairs VALUES(?,?,?,?)').run(p.id, assessment.row.thread_id, assessment.row.turn_id, 'contextual');
        }
        const { row, status, reason, origin } = assessment;
        decision.run(p.id, status, reason, row?.thread_id ?? null, row?.turn_id ?? null, row?.item_id ?? null, kind, origin ?? null, row?.provenance ? JSON.stringify(row.provenance) : null, new Date().toISOString());
        result.outcomes[status] = (result.outcomes[status] ?? 0) + 1;
      }
      store.db.exec('COMMIT');
    } catch (error) { store.db.exec('ROLLBACK'); throw error; }
    return result;
  } finally { history?.close(); state?.close(); }
}
