import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserAdapter } from './browser-adapter.mjs';
import { createPredictionEngine } from './engine.mjs';
import fs from 'node:fs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const source = { hostId: 'local', threadId: 'source', latestTurnId: 'source-turn', generationTrigger: 'catch_up' };

// Actual adapter + engine, with isolated settings/bridge/backend services. No desktop connection.
async function deliveryFixture(t, { autoComplete = true, text = '{"suggestion":"Exact cached prediction."}' } = {}) {
  const priorWindow = globalThis.window;
  globalThis.window = new EventTarget();
  const fixtureWindow = globalThis.window;
  const moduleUrl = 'data:text/javascript,' + encodeURIComponent(`
    // ${crypto.randomUUID()}
    export class Callback { constructor(fn) { this.fn = fn; } }
    let preference, handleRpc; const listeners = new Set();
    export const settings = { subscribe: async (key, cb) => { preference = cb; return { unsubscribe: async () => {} }; } };
    export const deliverPreference = effective => preference.fn({ effective });
    export const setRpc = fn => { handleRpc = fn; };
    export const bridge = {
      subscribe: (name, cb) => { listeners.add(cb); return () => listeners.delete(cb); },
      dispatchMessage: (name, {request}) => { void (async () => {
        try { const result = await handleRpc(request.method, request.params); for (const cb of listeners) cb({message:{id:request.id,result}}); }
        catch(error) { for (const cb of listeners) cb({message:{id:request.id,error:{message:error.message}}}); }
      })(); }
    };
    export const consume = async handle => { try { return await handle; } finally { handle[Symbol.dispose]?.(); } };
    export const services = {
      cumberbatch: { isEnabledByRemoteConfig: async () => true, requestUserMessagePrediction: async () => null }, settings,
      statsigEvaluations: { subscribe: async cb => { cb.fn({payload:'{}'}); return {unsubscribe:async()=>{}}; } },
      httpFetch: { fetch: async () => ({response:{ok:true,json:async()=>({is_enabled:true,prompt:'Unchanged test prompt',_prompt_predictor_route:'fork-v1',prompt_version:'5',prediction_reasoning_effort:'high',live_sample_rate:1,catch_up_sample_rate:1})}}) }
    };
  `);
  const module = await import(moduleUrl), calls = [];
  let child = 0, currentTurn = source.latestTurnId, resolveStarted;
  const started = new Promise(resolve => { resolveStarted = resolve; });
  function notify(threadId, method, params) {
    fixtureWindow.dispatchEvent(new MessageEvent('message', { data: { type: 'mcp-notification', hostId: 'local', method, params: { threadId, ...params } } }));
  }
  function complete(childId = 'child-1', output = text) {
    notify(childId, 'item/completed', { turnId: 'prediction-turn', item: { type: 'agentMessage', text: output } });
    notify(childId, 'turn/completed', { turn: { id: 'prediction-turn', status: 'completed' } });
  }
  module.setRpc(async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/resume') return { model: 'parent', modelProvider: 'openai' };
    if (method === 'thread/turns/list') return { data: [{ id: currentTurn, status: 'completed' }] };
    if (method === 'thread/fork') return { thread: { id: 'child-' + ++child } };
    if (method === 'turn/start') { resolveStarted(); if (autoComplete) queueMicrotask(() => complete(params.threadId)); return { turn: { id: 'prediction-turn' } }; }
    if (method === 'thread/unsubscribe' || method === 'turn/interrupt') return {};
    throw Error('Unexpected fixture RPC: ' + method);
  });
  const profile = { ...JSON.parse(fs.readFileSync(new URL('../recorder/manifest.json', import.meta.url))).generation, moduleUrl, loader: undefined, revision: 'delivery-fixture', bindings: { services: 'services', callback: 'Callback', bridge: 'bridge', consume: 'consume' } };
  await installBrowserAdapter(profile, createPredictionEngine);
  t.after(async () => { const adapter = globalThis.__COMPOSER_ASTRA_ADAPTER; await adapter?.dispose(); for (let i = 0; adapter?.status().jobs && i < 100; i++) await tick(); await tick(); if (priorWindow === undefined) delete globalThis.window; else globalThis.window = priorWindow; });
  return { calls, module, complete, started, request: target => module.services.cumberbatch.requestUserMessagePrediction(target ?? source), changeSource() { currentTurn = 'new-turn'; notify(source.threadId, 'turn/started', { turn: { id: currentTurn } }); } };
}

test('initial preference delivery is awaited, never cached by the native caller as a successful blank', { timeout: 3000 }, async t => {
  const f = await deliveryFixture(t);
  assert.equal(globalThis.__COMPOSER_ASTRA_ADAPTER.status().preferenceReady, false);
  let settled = false;
  const pending = f.module.consume(f.request()).then(value => { settled = true; return value; });
  await tick();
  assert.equal(settled, false, 'missing preference snapshot must remain pending, not become a successful null');
  assert.equal(f.calls.length, 0);
  f.module.deliverPreference(true);
  assert.equal((await pending).text, 'Exact cached prediction.');
  assert.equal(globalThis.__COMPOSER_ASTRA_ADAPTER.status().preferenceReady, true);
  const returned = await f.module.consume(f.request());
  assert.equal(returned.predictionThreadId, 'child-1');
  assert.equal(f.calls.filter(c => c.method === 'thread/fork').length, 1);
});

test('adapter disposal rejects a request waiting for initial settings without manufacturing a blank', { timeout: 3000 }, async t => {
  const f = await deliveryFixture(t), pending = f.module.consume(f.request());
  pending.catch(() => {});
  await tick();
  await globalThis.__COMPOSER_ASTRA_ADAPTER.dispose();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(f.calls.length, 0);
});

test('an initial disabled snapshot resolves normally and enabling later permits generation', { timeout: 3000 }, async t => {
  const f = await deliveryFixture(t), pending = f.module.consume(f.request());
  f.module.deliverPreference(false);
  assert.equal(await pending, null);
  assert.equal(f.calls.length, 0);
  f.module.deliverPreference(true);
  assert.equal((await f.module.consume(f.request())).text, 'Exact cached prediction.');
});

test('leave before completion then return retrieves the exact completed cached result without another generation', { timeout: 3000 }, async t => {
  const f = await deliveryFixture(t, { autoComplete: false });
  f.module.deliverPreference(true);
  const handle = f.module.consume(f.request()), controller = new AbortController();
  // The shipped caller aborts the outer query, without passing its signal to consume.
  const visible = new Promise((resolve, reject) => { controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }); handle.then(resolve, reject); });
  visible.catch(() => {});
  await f.started; controller.abort(new DOMException('Composer left', 'AbortError'));
  await assert.rejects(visible, { name: 'AbortError' });
  f.complete();
  const completed = await handle, returned = await f.module.consume(f.request());
  assert.equal(returned.predictionThreadId, completed.predictionThreadId);
  assert.equal(returned.text, completed.text);
  assert.equal(f.calls.filter(c => c.method === 'thread/fork').length, 1);
});

test('valid suggestion remains cached, and a changed source cannot retrieve the old cached answer', { timeout: 3000 }, async t => {
  const f = await deliveryFixture(t, { text: '{"suggestion":"A next move."}' });
  f.module.deliverPreference(true);
  const first = await f.module.consume(f.request()), second = await f.module.consume(f.request());
  assert.equal(first.text, 'A next move.'); assert.equal(second.predictionThreadId, first.predictionThreadId);
  assert.equal(f.calls.filter(c => c.method === 'thread/fork').length, 1);
  f.changeSource();
  await assert.rejects(f.module.consume(f.request()), /no longer current/);
  await f.module.consume(f.request({ ...source, latestTurnId: 'new-turn' }));
  assert.equal(f.calls.filter(c => c.method === 'thread/fork').length, 2);
});

test('reviewed export bindings install and roll back the same service without assuming old export names', async () => {
  const originalWindow = globalThis.window;
  const events = new EventTarget();
  globalThis.window = events;
  const moduleUrl = 'data:text/javascript,' + encodeURIComponent(`
    export const original = { isEnabledByRemoteConfig: async () => true, requestUserMessagePrediction: async () => 'native' };
    export const calls = { unsubscribed: 0 };
    const subscribe = async () => ({ unsubscribe: async () => { calls.unsubscribed++; } });
    export const renamedServices = { cumberbatch: original, httpFetch: {}, settings: { subscribe }, statsigEvaluations: { subscribe } };
    export class renamedCallback { constructor(fn) { this.fn = fn; } }
    export const renamedBridge = { subscribe: () => () => {}, dispatchMessage() {} };
    export const renamedConsume = async value => await value;
  `);
  const module = await import(moduleUrl);
  const profile = { moduleUrl, revision: 'binding-test', bindings: { services: 'renamedServices', callback: 'renamedCallback', bridge: 'renamedBridge', consume: 'renamedConsume' } };
  let disposed = false;
  try {
    const state = await installBrowserAdapter(profile, () => ({ request: async () => 'owned', status: () => ({ jobs: 0 }), notify() {}, abortAll() {}, dispose() { disposed = true; } }));
    assert.equal(state.state, 'active');
    assert.notEqual(module.renamedServices.cumberbatch, module.original);
    assert.equal(await module.renamedServices.cumberbatch.requestUserMessagePrediction({ hostId: 'local' }), 'owned');
    assert.equal(await module.renamedServices.cumberbatch.requestUserMessagePrediction({ hostId: 'ssh' }), 'native');
    await globalThis.__COMPOSER_ASTRA_ADAPTER.dispose();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(module.renamedServices.cumberbatch, module.original);
    assert.equal(disposed, true);
    assert.equal(module.calls.unsubscribed, 2);
    assert.equal(globalThis.__COMPOSER_ASTRA_ADAPTER, undefined);
  } finally {
    await globalThis.__COMPOSER_ASTRA_ADAPTER?.dispose();
    if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
  }
});
