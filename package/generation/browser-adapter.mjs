// This function is serialized into the verified app renderer by the existing recorder.
export async function installBrowserAdapter(profile, createEngine) {
  const slot = '__COMPOSER_ASTRA_ADAPTER';
  const previous = globalThis[slot];
  if (previous?.revision === profile.revision) return previous.status();
  if (previous) await previous.dispose();
  const m = await import(profile.moduleUrl);
  const bindings = profile.bindings;
  const pick = binding => typeof binding === 'string' ? m[binding] : m.__webpack_require__(binding.moduleId)[binding.export];
  if (profile.loader === 'rspack') {
    const runtime = m.__webpack_require__;
    if (typeof runtime !== 'function' || !runtime.m || !runtime.c) throw Error('Reviewed renderer module runtime unavailable');
    for (const binding of Object.values(bindings)) {
      if (!Object.hasOwn(runtime.c, binding.moduleId)) return { state: 'waiting_for_services' };
      const factory = runtime.m[binding.moduleId];
      if (typeof factory !== 'function') throw Error('Reviewed module factory unavailable: ' + binding.moduleId);
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(factory.toString()))), b => b.toString(16).padStart(2, '0')).join('');
      if (hash !== binding.factorySha256) throw Error('Renderer binding factory changed: ' + binding.moduleId);
    }
  }
  const services = pick(bindings.services), Callback = pick(bindings.callback);
  const bridge = pick(bindings.bridge), consume = pick(bindings.consume);
  const original = services?.cumberbatch;
  if (!original || !services.httpFetch || !services.settings || !Callback || !bridge || !consume) return { state: 'waiting_for_services' };
  const pending = new Map(), subscriptions = [], callbacks = [];
  let ready = false, enabled = false, policy, disableMcp = true, lastEvent = null, stopped = false;
  let releasePreference;
  const preferenceReady = new Promise(resolve => { releasePreference = resolve; });
  async function isEnabled() {
    // Unknown initial preference is not an abstention: native queries cache null as fresh.
    if (!ready) await preferenceReady;
    if (stopped) throw new DOMException('Adapter disabled', 'AbortError');
    return enabled && await consume(original.isEnabledByRemoteConfig());
  }
  const log = event => { lastEvent = event; console.info('__COMPOSER_GENERATION', JSON.stringify(event)); };
  async function rpc(hostId, method, params, timeoutMs = 120000) {
    const id = 'composer-astra:' + crypto.randomUUID();
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pending.delete(id); reject(Error('RPC timed out: ' + method)); }, timeoutMs + 1000);
      pending.set(id, { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } });
      bridge.dispatchMessage('mcp-request', { hostId, request: { id, method, params }, timeoutMs });
    });
  }
  const offResponse = bridge.subscribe('mcp-response', e => {
    const call = pending.get(e.message?.id); if (!call) return;
    pending.delete(e.message.id);
    if (e.message.error) call.reject(Error(e.message.error.message || JSON.stringify(e.message.error))); else call.resolve(e.message.result);
  });
  async function getConfig() {
    const id = 'composer-astra-config:' + crypto.randomUUID();
    const call = services.httpFetch.fetch(id, { url: '/wham/predictions/config', method: 'GET', headers: {'x-prompt-predictor-route': 'fork-v1'} });
    try { const result = await call; if (!result.response?.ok) throw Error('Prediction configuration unavailable'); const config = await result.response.json(); if(config._prompt_predictor_route !== 'fork-v1') { log({event:'configuration_failed',error:'Custom prompt receipt missing; refusing stock prediction'}); throw Error('Custom prompt receipt missing; refusing stock prediction'); } return config; }
    finally { call[Symbol.dispose]?.(); }
  }
  const engine = createEngine({ rpc, getConfig, isEnabled, getPolicy: () => policy, disableMcp: () => disableMcp, hash: async text => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join(''), event: log, fallback: (target, callback) => consume(original.requestUserMessagePrediction(target, callback)) }, profile);
  const listener = e => { let d = e.data; if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return; } } if (d?.type === 'mcp-notification') engine.notify(d.hostId, d.method, d.params); };
  window.addEventListener('message', listener);
  const settingsCallback = new Callback(value => { if (stopped) return; const next = value.effective === true; if (ready && next !== enabled) engine.abortAll('Prediction preference changed'); enabled = next; ready = true; releasePreference(); });
  const evaluationsCallback = new Callback(value => {
    const evaluation = JSON.parse(value.payload);
    const nextPolicy = evaluation.dynamic_configs?.['3941626706']?.value;
    if (JSON.stringify(policy) !== JSON.stringify(nextPolicy)) engine.abortAll('Prediction policy changed');
    policy = nextPolicy;
    disableMcp = evaluation.feature_gates?.['1558648544']?.value === true;
  });
  callbacks.push(settingsCallback, evaluationsCallback);
  try {
    for (const call of [services.settings.subscribe('composer-predictions-enabled', settingsCallback), services.statsigEvaluations.subscribe(evaluationsCallback)]) {
      const subscription = await call; subscriptions.push({ call, subscription });
    }
  } catch (error) { stopped = true; releasePreference(); engine.dispose(); window.removeEventListener('message', listener); offResponse(); for (const cb of callbacks) cb[Symbol.dispose]?.(); throw error; }
  const wrapper = {
    isEnabledByRemoteConfig: (...args) => original.isEnabledByRemoteConfig(...args),
    requestUserMessagePrediction: (target, callback) => stopped || target.hostId !== 'local' ? original.requestUserMessagePrediction(target, callback) : engine.request(target, value => callback?.(value)?.catch?.(() => {})),
  };
  services.cumberbatch = wrapper;
  const state = {
    owner: 'prompt-predictor-prototype-v1',
    revision: profile.revision,
    service: wrapper,
    status: () => ({ state: stopped ? 'disabled' : 'active', preferenceReady: ready, revision: profile.revision, model: profile.model, effort: profile.effort, timeoutMs: profile.timeoutMs, ...engine.status(), lastEvent }),
    async dispose() {
      stopped = true; if (services.cumberbatch === wrapper) services.cumberbatch = original;
      releasePreference();
      engine.dispose();
      if (globalThis[slot] === state) delete globalThis[slot];
      // Restore native routing immediately; retain the RPC listener until late fork cleanup settles.
      void (async () => {
        while (engine.status().jobs) await new Promise(r => setTimeout(r, 50));
        window.removeEventListener('message', listener); offResponse();
        for (const { call, subscription } of subscriptions) { try { await subscription.unsubscribe(); } catch {} call[Symbol.dispose]?.(); }
        for (const cb of callbacks) cb[Symbol.dispose]?.();
        for (const call of pending.values()) call.reject(Error('Adapter disabled')); pending.clear();
      })();
    },
  };
  globalThis[slot] = state;
  log({ event: 'adapter_installed', at: new Date().toISOString(), revision: profile.revision, model: profile.model, effort: profile.effort, timeoutMs: profile.timeoutMs });
  return state.status();
}
