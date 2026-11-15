import fs from 'node:fs';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

export function messageText(item) {
  return (item.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('');
}

// Automation uses the user-message transport too. Preserve its raw evidence,
// but never count it as Tyler's prediction target or skip across it.
export function messageOrigin(item) {
  const text = messageText(item).trim();
  const client = item.clientId ?? item.client_id;
  if (!client && /^<heartbeat>\s*<automation_id>[^<]+<\/automation_id>[\s\S]*<instructions>[\s\S]*<\/instructions>\s*<\/heartbeat>$/.test(text)) return 'automation';
  if (text.startsWith('<send_user_message_question_reply>')) return 'question_reply';
  if (!client && text.startsWith('<realtime_delegation>')) return 'voice_delegation';
  return 'user';
}

// Only explicit completed items in the original thread qualify. Incremental
// byte reads avoid rescanning large, growing transcripts every heartbeat.
// This cache is derived and in memory; the native logs remain read-only.
export class RolloutIndex {
  constructor() { this.files = new Map(); }
  line(index, text, file) {
    index.line++;
    if (!text.trim()) return;
    let row;
    try { row = JSON.parse(text); }
    catch { throw Error(`Invalid completed rollout line: ${file}:${index.line}`); }
    const p = row.payload, item = p?.item;
    if (row.type === 'session_meta') index.meta = p;
    if (row.type !== 'event_msg' || p?.type !== 'item_completed' || p.thread_id !== index.threadId || typeof p.turn_id !== 'string' || !item) return;
    const ordinal = Number.isInteger(row.ordinal) ? row.ordinal : index.line;
    const prior = index.turns.get(p.turn_id);
    index.turns.set(p.turn_id, { start: prior?.start ?? ordinal, end: ordinal });
    const entry = { turn: p.turn_id, ordinal, provenance: { file, line: index.line, ordinal, originalThreadId: p.thread_id } };
    index.entries.push(entry);
    if (!['UserMessage', 'userMessage'].includes(item.type) || typeof item.id !== 'string') return;
    const timestamp = Date.parse(row.timestamp);
    entry.user = { thread_id: index.threadId, turn_id: p.turn_id, item_id: item.id, item_json: JSON.stringify(item), created_at_ms: Number.isFinite(timestamp) ? timestamp : null, rollout_ordinal: ordinal, provenance: entry.provenance };
    index.users.push(entry.user);
  }
  read(file, threadId) {
    const stat = fs.statSync(file);
    let index = this.files.get(file);
    if (file.endsWith('.zst')) {
      if (index?.size === stat.size && index.mtimeMs === stat.mtimeMs && index.threadId === threadId) return index;
      index = { threadId, offset: 0, line: 0, turns: new Map(), users: [], entries: [], size: stat.size, mtimeMs: stat.mtimeMs };
      const bytes = zstdDecompressSync(fs.readFileSync(file));
      if (bytes.length && bytes.at(-1) !== 10) throw Error(`Incomplete compressed rollout: ${file}`);
      for (const text of bytes.toString('utf8').split('\n').slice(0, -1)) this.line(index, text, file);
      this.files.set(file, index);
      return index;
    }
    if (!index || index.threadId !== threadId || stat.size < index.offset || (stat.size === index.size && stat.mtimeMs !== index.mtimeMs)) {
      index = { threadId, offset: 0, line: 0, turns: new Map(), users: [], entries: [], size: 0, mtimeMs: 0 };
      this.files.set(file, index);
    }
    const fd = fs.openSync(file, 'r');
    try {
      // Read complete lines only. A partial last append is retried next time.
      let tail = Buffer.alloc(0), position = index.offset;
      const buffer = Buffer.alloc(1024 * 1024);
      while (position < stat.size) {
        const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - position), position);
        if (!n) break;
        position += n;
        const bytes = Buffer.concat([tail, buffer.subarray(0, n)]);
        let start = 0, end;
        while ((end = bytes.indexOf(10, start)) !== -1) {
          const text = bytes.subarray(start, end).toString('utf8').trim();
          index.offset += end - start + 1;
          start = end + 1;
          this.line(index, text, file);
        }
        tail = Buffer.from(bytes.subarray(start));
      }
      index.size = stat.size;
      index.mtimeMs = stat.mtimeMs;
      return index;
    } catch (error) { this.files.delete(file); throw error; }
    finally { fs.closeSync(fd); }
  }
}

// Reconstruct only the declared history_base chain. A shared turn ID or a
// filename match alone never authorizes borrowing another branch's reply.
export class TranscriptHistory {
  constructor() { this.index = new RolloutIndex(); this.catalog = new Map(); this.scannedAt = 0; }
  discover(home) {
    if (this.home === home && Date.now() - this.scannedAt < 30000) return;
    this.home = home; this.scannedAt = Date.now(); this.catalog.clear();
    for (const dir of ['sessions', 'archived_sessions']) {
      const root = path.join(home, dir);
      if (!fs.existsSync(root)) continue;
      for (const relative of fs.readdirSync(root, { recursive: true })) {
        const match = path.basename(relative).match(/^rollout-.*-([a-f0-9-]{36})(?:_([a-f0-9-]{36}))?\.jsonl(?:\.zst)?$/i);
        if (!match) continue;
        const key = match[2] ?? match[1], file = path.join(root, relative);
        const rows = this.catalog.get(key) ?? [];
        rows.push({ file, owner: match[1] }); this.catalog.set(key, rows);
      }
    }
  }
  existing(file) { return file && fs.existsSync(file) ? file : file && fs.existsSync(file + '.zst') ? file + '.zst' : null; }
  segment(id) {
    const candidates = this.catalog.get(id) ?? [];
    // Compression can briefly leave both copies. They are one logical file.
    const logical = new Map(candidates.map(c => [c.file.replace(/\.zst$/, ''), c]));
    if (logical.size !== 1) return null;
    const candidate = [...logical.values()][0];
    return { ...candidate, file: this.existing(candidate.file.replace(/\.zst$/, '')) };
  }
  read(file, threadId, home) {
    this.discover(home);
    const resolve = (file, owner, visiting = new Set()) => {
      if (visiting.has(file)) throw Error('Cyclic transcript history_base: ' + file);
      const next = new Set(visiting).add(file), current = this.index.read(file, owner);
      if (current.meta && (current.meta.session_id ?? current.meta.id) !== owner) throw Error('Transcript metadata identity mismatch: ' + file);
      const base = current.meta?.history_base;
      let inherited = [];
      if (base) {
        if (!Number.isInteger(base.end_ordinal_exclusive) || base.end_ordinal_exclusive < 0) throw Error('Invalid transcript history cutoff: ' + file);
        const parent = this.segment(base.thread_id);
        if (parent?.file) inherited = resolve(parent.file, parent.owner, next).filter(e => e.ordinal < base.end_ordinal_exclusive).map(e => ({ ...e, provenance: { ...e.provenance, historyBase: { file, threadId: base.thread_id, endOrdinalExclusive: base.end_ordinal_exclusive } }, user: e.user && { ...e.user, provenance: { ...e.user.provenance, historyBase: { file, threadId: base.thread_id, endOrdinalExclusive: base.end_ordinal_exclusive } } } }));
      }
      return [...inherited, ...current.entries];
    };
    const selected = this.existing(file) ?? this.segment(threadId)?.file;
    if (!selected) return null;
    const entries = resolve(selected, threadId), turns = new Map(), users = [];
    for (const e of entries) {
      const prior = turns.get(e.turn);
      turns.set(e.turn, { start: prior?.start ?? e.ordinal, end: e.ordinal, provenance: e.provenance });
      if (e.user) users.push({ ...e.user, thread_id: threadId });
    }
    return { turns, users };
  }
  source(threadId, sourceTurnId, home) {
    this.discover(home);
    const candidates = [];
    for (const segments of this.catalog.values()) for (const segment of segments) {
      if (segment.owner !== threadId || segment.file.endsWith('.zst') && fs.existsSync(segment.file.slice(0, -4))) continue;
      const index = this.index.read(segment.file, threadId);
      if ((index.meta?.session_id ?? index.meta?.id) !== threadId || !index.turns.has(sourceTurnId)) continue;
      candidates.push(segment.file);
    }
    // A historical segment can retain a source removed by an edited branch.
    // Require a unique explicit same-thread source, never a global turn-ID join.
    return candidates.length === 1 ? this.read(candidates[0], threadId, home) : null;
  }
}

export function assessTarget(rows, firstSeen) {
  if (!rows.length) return { status: 'awaiting_continuation', reason: 'No following saved user item' };
  const unique = [...new Map(rows.map(r => [r.item_id, r])).values()];
  if (unique.length !== 1) return { status: 'ambiguous', reason: 'More than one saved user item for the native target turn' };
  const row = unique[0], item = JSON.parse(row.item_json), origin = messageOrigin(item);
  if (origin !== 'user') return { status: 'excluded_' + origin, reason: 'Immediate target is ' + origin, row, origin };
  if (!Number.isFinite(row.created_at_ms) || row.created_at_ms < Date.parse(firstSeen)) return { status: 'late_or_unknown_timing', reason: 'Target preceded first receipt, or saved time is unavailable', row, origin };
  return { status: 'paired', reason: null, row, origin };
}
