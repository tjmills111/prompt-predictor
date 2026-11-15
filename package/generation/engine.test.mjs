import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createPredictionEngine } from './engine.mjs';

const profile = JSON.parse(fs.readFileSync(new URL('../recorder/manifest.json', import.meta.url), 'utf8')).generation;
const target = { hostId: 'local', threadId: 'source', latestTurnId: 'source-turn', generationTrigger: 'live' };
const tick = () => new Promise(r => setImmediate(r));
function fixture(options = {}) {
  const calls = [], events = []; let latest = target.latestTurnId, child = 0, enabled = true, timeout;
  const config = { is_enabled: true, prompt: 'Approved prompt', prompt_version: '5', prediction_reasoning_effort: 'high', unsupported_models: ['gpt-6-sol'], live_sample_rate: 1, catch_up_sample_rate: 1 };
  let engine;
  const deps = {
    isEnabled: async () => enabled, getConfig: async () => config, getPolicy: () => options.policy,
    hash: async s => createHash('sha256').update(s).digest('hex'), event: e => events.push(e),
    setTimeout: fn => { timeout = fn; return 1; }, clearTimeout: () => {},
    rpc: async (host, method, params) => {
      calls.push({ host, method, params });
      if (method === 'thread/resume') return { model: 'gpt-6-sol', modelProvider: 'openai', reasoningEffort: 'xhigh', serviceTier: 'default', ...options.parent };
      if (method === 'thread/turns/list') return { data: [{ id: latest, status: 'completed' }] };
      if (method === 'thread/fork') { if (options.forkGate) await options.forkGate; return { thread: { id: 'child-' + ++child } }; }
      if (method === 'turn/start') {
        const id = 'prediction-turn';
        engine.notify(host, 'turn/started', { threadId: params.threadId, turn: { id } });
        if (options.auto !== false) queueMicrotask(() => complete(params.threadId));
        return { turn: { id } };
      }
      if (method === 'thread/unsubscribe' || method === 'turn/interrupt') return {};
      throw Error('Unexpected RPC ' + method);
    },
  };
  function complete(childId = 'child-1', text = options.text ?? '{"suggestion":"A substantial next move."}') {
    engine.notify('local', 'item/completed', { threadId: childId, turnId: 'prediction-turn', item: { type: 'agentMessage', text } });
    engine.notify('local', 'turn/completed', { threadId: childId, turn: { id: 'prediction-turn', status: 'completed' } });
  }
  engine = createPredictionEngine(deps, profile);
  return { engine, config, calls, events, complete, expire: () => timeout(), changeSource: () => { latest = 'new-turn'; engine.notify('local', 'turn/started', { threadId: 'source', turn: { id: latest } }); }, disable: () => { enabled = false; engine.abortAll('Preference changed'); } };
}
test('Sol parent uses inherited prediction fork, explicit Sol 6.1/High and unchanged prompt; child cleaned', async () => {
  const f = fixture(); const result = await f.engine.request(target);
  assert.equal(result.model, 'gpt-6.1-sol'); assert.equal(result.parentModel, 'gpt-6-sol'); assert.equal(result.parentReasoningEffort, 'xhigh');
  assert.equal(result.text, 'A substantial next move.');
  const fork = f.calls.find(c => c.method === 'thread/fork').params;
  assert.equal(fork.experimentalPredictionMode, true); assert.equal(fork.ephemeral, true); assert.equal(fork.threadId, 'source'); assert.equal(fork.model, undefined);
  const turn = f.calls.find(c => c.method === 'turn/start').params;
  assert.equal(turn.model, 'gpt-6.1-sol'); assert.equal(turn.effort, 'high'); assert.equal(turn.serviceTier, 'default'); assert.equal(turn.permissions, ':read-only'); assert.equal(turn.turnTrigger, 'composer_predictions');
  assert.ok(turn.input[0].text.startsWith('Approved prompt\n\nReturn only JSON matching this schema: '));
  assert.equal(f.calls.at(-1).method, 'thread/unsubscribe');
  assert.equal(f.calls.some(c => c.method === 'thread/sample'), false);
});
test('configuration off and plan/provider exclusions do not create children', async () => {
  for (const options of [{ parent: { collaborationMode: { mode: 'plan' } } }, { parent: { modelProvider: 'other' } }, {}]) {
    const f = fixture(options); if (!options.parent) f.config.is_enabled = false;
    assert.equal(await f.engine.request(target), null); assert.equal(f.calls.some(c => c.method === 'thread/fork'), false);
  }
});
test('live and catch-up deduplicate; cache tracks prompt revision and preserves caller trigger', async () => {
  const f = fixture(); const [a, b] = await Promise.all([f.engine.request(target), f.engine.request({ ...target, generationTrigger: 'catch_up' })]);
  assert.equal(a.predictionThreadId, b.predictionThreadId); assert.equal(f.calls.filter(c => c.method === 'thread/fork').length, 1);
  const cached = await f.engine.request({ ...target, generationTrigger: 'catch_up' }); assert.equal(cached.generationTrigger, 'catch_up');
  f.config.prompt = 'Revised approved prompt'; await f.engine.request(target);
  assert.equal(f.calls.filter(c => c.method === 'thread/fork').length, 2);
});
test('source change rejects pending result and interrupts/unsubscribes child', async () => {
  const f = fixture({ auto: false }); const p = f.engine.request(target); p.catch(() => {}); await tick();
  f.changeSource(); await assert.rejects(p, /Source changed/); await tick();
  assert.ok(f.calls.some(c => c.method === 'turn/interrupt')); assert.ok(f.calls.some(c => c.method === 'thread/unsubscribe'));
});
test('120-second allowance exhaustion interrupts and cleans; no abandoned child', async () => {
  const f = fixture({ auto: false }); const p = f.engine.request(target); p.catch(() => {}); await tick(); f.expire();
  await assert.rejects(p, /120000/); await tick(); assert.ok(f.calls.some(c => c.method === 'turn/interrupt')); assert.ok(f.calls.some(c => c.method === 'thread/unsubscribe'));
});
test('cancellation during fork still consumes and cleans the late-created child', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const f = fixture({ forkGate: gate }); const p = f.engine.request(target); p.catch(() => {}); await tick(); p[Symbol.dispose]();
  await assert.rejects(p, /disposed/); release(); await tick();
  assert.equal(f.calls.some(c => c.method === 'turn/start'), false); assert.ok(f.calls.some(c => c.method === 'thread/unsubscribe'));
});
test('one disposed consumer does not cancel a second consumer of the same generation', async () => {
  const f = fixture({ auto: false }); const a = f.engine.request(target); a.catch(() => {}); const b = f.engine.request(target); await tick(); a[Symbol.dispose]();
  await assert.rejects(a, /disposed/); assert.equal(f.calls.some(c => c.method === 'turn/interrupt'), false);
  f.complete(); assert.equal((await b).text, 'A substantial next move.');
});
test('moderation source policy suppresses output, including threshold equality', async () => {
  const f = fixture({ policy: { st: { risk: 0.5 } } });
  f.engine.notify('local', 'turn/moderationMetadata', { threadId: 'source', turnId: 'source-turn', metadata: { prompt: { model: { outputs: [{ results: [{ _modapi_scores: { risk: 0.5 } }] }] } } } });
  assert.equal(await f.engine.request(target), null); assert.equal(await f.engine.request(target), null);
  assert.equal(f.calls.filter(c => c.method === 'thread/fork').length, 1); assert.ok(f.events.some(e => e.event === 'suppressed'));
});
test('invalid prediction JSON fails rather than being cached as an empty success', async () => {
  const f = fixture({ text: 'not JSON' }); await assert.rejects(f.engine.request(target), /JSON/); await assert.rejects(f.engine.request(target), /JSON/);
  assert.equal(f.calls.filter(c => c.method === 'thread/fork').length, 2);
});
test('native moderation schema rejects an entire invalid metadata entry', () => {
  const f = fixture();
  const prompt = { model: { outputs: [{ results: [{ labels: ['blocked'] }] }] } };
  assert.ok(f.engine.policyDecision([{ prompt }], { ubl: ['blocked'] }));
  assert.equal(f.engine.policyDecision([{ prompt, generation: { bad: { outputs: 'invalid' } } }], { ubl: ['blocked'] }), null);
  assert.ok(f.engine.policyDecision([{ generation: prompt }], { abl: ['blocked'] }));
});
test('tool attempt is interrupted and preference disable cancels pending generation', async () => {
  for (const kind of ['tool', 'preference']) {
    const f = fixture({ auto: false }); const p = f.engine.request(target); p.catch(() => {}); await tick();
    if (kind === 'tool') f.engine.notify('local', 'item/started', { threadId: 'child-1', item: { type: 'commandExecution' } }); else f.disable();
    await assert.rejects(p, /tool action|Preference changed/); await tick(); assert.ok(f.calls.some(c => c.method === 'turn/interrupt')); assert.ok(f.calls.some(c => c.method === 'thread/unsubscribe'));
  }
});


test('always-suggest contract is enforced in server schema and rejects cached blanks', async () => {
  const good = fixture(); await good.engine.request(target);
  const start = good.calls.find(c => c.method === 'turn/start').params;
  assert.deepEqual(start.outputSchema, profile.schema);
  assert.deepEqual(start.outputSchema.properties.suggestion, { type: 'string', minLength: 1 });
  for (const text of ['{"suggestion":null}', '{"suggestion":""}', '{"suggestion":"   "}']) {
    const f = fixture({ text });
    await assert.rejects(f.engine.request(target), /Invalid prediction JSON/);
    await assert.rejects(f.engine.request(target), /Invalid prediction JSON/);
    assert.equal(f.calls.filter(c => c.method === 'thread/fork').length, 2);
  }
});
