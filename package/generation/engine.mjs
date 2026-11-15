// Self-contained so the same reviewed implementation can run in the app renderer.
export function createPredictionEngine(deps, profile) {
  const jobs = new Map(), cache = new Map(), moderation = new Map();
  const now = deps.now ?? Date.now;
  const timer = deps.setTimeout ?? setTimeout, clearTimer = deps.clearTimeout ?? clearTimeout;
  let disposed = false;
  const abortError = reason => new DOMException(reason || 'Prediction cancelled', 'AbortError');
  const emit = (event, data = {}) => deps.event?.({ event, at: new Date(now()).toISOString(), ...data });
  const sourceKey = t => JSON.stringify([t.hostId, t.threadId, t.latestTurnId]);
  const validateConfig = c => c && typeof c.is_enabled === 'boolean' && typeof c.prompt === 'string' && typeof c.prompt_version === 'string' && typeof c.prediction_reasoning_effort === 'string';
  function policyDecision(metadata, policy) {
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return null;
    if (policy.st != null && (typeof policy.st !== 'object' || Array.isArray(policy.st) || Object.values(policy.st).some(v => typeof v !== 'number'))) return null;
    for (const k of ['ubl', 'abl']) if (policy[k] != null && (!Array.isArray(policy[k]) || policy[k].some(v => typeof v !== 'string'))) return null;
    const scores = {}, promptLabels = new Set(), outputLabels = new Set();
    const validPhase = groups => groups == null || typeof groups === 'object' && !Array.isArray(groups) && Object.values(groups).every(g => Array.isArray(g?.outputs) && g.outputs.every(o => Array.isArray(o?.results) && o.results.every(r => r && (r.labels == null || Array.isArray(r.labels) && r.labels.every(v => typeof v === 'string')) && (r._modapi_scores == null || typeof r._modapi_scores === 'object' && !Array.isArray(r._modapi_scores) && Object.values(r._modapi_scores).every(v => typeof v === 'number')))));
    for (const entry of metadata ?? []) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !validPhase(entry.prompt) || !validPhase(entry.generation)) continue;
      for (const phase of ['prompt', 'generation']) {
        const groups = entry[phase];
        if (!groups || typeof groups !== 'object' || Array.isArray(groups)) continue;
        for (const group of Object.values(groups)) for (const output of group.outputs) for (const item of output.results) {
          const configured = phase === 'prompt' ? policy.ubl : policy.abl;
          for (const label of item.labels ?? []) if (configured?.includes(label)) (phase === 'prompt' ? promptLabels : outputLabels).add(label);
          if (phase === 'prompt' && item._modapi_scores && policy.st) for (const [key, threshold] of Object.entries(policy.st)) {
            const score = item._modapi_scores[key];
            if (score >= threshold) scores[key] = { score: Math.max(scores[key]?.score ?? score, score), threshold };
          }
        }
      }
    }
    return Object.keys(scores).length || promptLabels.size || outputLabels.size ? { st: scores, ubl: [...promptLabels], abl: [...outputLabels] } : null;
  }
  function cancel(job, reason) {
    if (!job.controller.signal.aborted) { job.reason = reason; job.controller.abort(abortError(reason)); }
    if (job.childId && job.turnId && !job.interruptSent && !job.completed) {
      job.interruptSent = true;
      deps.rpc(job.target.hostId, 'turn/interrupt', { threadId: job.childId, turnId: job.turnId }, 10000).catch(e => emit('cleanup_error', { childId: job.childId, error: String(e) }));
    }
  }
  function abortAll(reason) { for (const job of jobs.values()) cancel(job, reason); cache.clear(); }
  function notify(hostId, method, params) {
    if (method === 'account/updated' || method === 'account/login/completed') { abortAll('Account changed'); moderation.clear(); return; }
    if (method === 'turn/moderationMetadata' && params?.threadId && params?.turnId) {
      const k = sourceKey({ hostId, threadId: params.threadId, latestTurnId: params.turnId });
      moderation.set(k, [...moderation.get(k) ?? [], params.metadata]);
      if (moderation.size > 64) moderation.delete(moderation.keys().next().value);
    }
    for (const job of jobs.values()) {
      if (hostId !== job.target.hostId) continue;
      if (method === 'turn/started' && params?.threadId === job.target.threadId) { cancel(job, 'Source changed'); cache.delete(job.key); }
      if (params?.threadId !== job.childId) continue;
      if (method === 'turn/started') { job.turnId = params.turn.id; if (job.controller.signal.aborted) cancel(job, job.reason); }
      if (method === 'thread/tokenUsage/updated') job.usage = params.tokenUsage?.last;
      if (method === 'item/agentMessage/delta') job.text = (job.text ?? '') + params.delta;
      if (method === 'item/completed' && params.item?.type === 'agentMessage') job.text = params.item.text;
      if (method === 'item/started' && ['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'fileChange', 'webSearch', 'imageGeneration'].includes(params.item?.type)) cancel(job, 'Prediction attempted a tool action');
      if (method === 'error') job.error = params.error;
      if (method === 'turn/completed') { job.completed = true; job.turnId = params.turn.id; job.resolveTurn(params.turn); }
    }
  }
  async function latest(target) {
    const response = await deps.rpc(target.hostId, 'thread/turns/list', { threadId: target.threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
    const turn = response.data?.[0];
    if (!turn || turn.id !== target.latestTurnId || turn.status !== 'completed') throw abortError('Source turn is no longer current and completed');
  }
  function waitAbort(signal) {
    return new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason ?? abortError());
      else signal.addEventListener('abort', () => reject(signal.reason ?? abortError()), { once: true });
    });
  }
  async function run(job, config, ineligible) {
    const { target, controller } = job, { signal } = controller;
    const check = () => { if (signal.aborted) throw signal.reason ?? abortError(); };
    let deadline;
    try {
      const parent = await deps.rpc(target.hostId, 'thread/resume', { threadId: target.threadId, excludeTurns: true }); check();
      const reason = parent.collaborationMode?.mode === 'plan' ? 'plan_mode' : parent.modelProvider !== 'openai' ? 'unsupported_provider' : config.unsupported_models?.includes(profile.model) ? 'unsupported_model' : null;
      if (reason) { ineligible?.({ reason, hostKind: 'local', model: profile.model, parentReasoningEffort: parent.reasoningEffort, promptVersion: config.prompt_version }); return null; }
      await latest(target); check();
      // Do not abandon an in-flight fork on cancellation: consume its result, then unsubscribe it.
      const fork = await deps.rpc(target.hostId, 'thread/fork', { threadId: target.threadId, experimentalPredictionMode: true, experimentalDisablePredictionMcp: deps.disableMcp?.() ?? true, config: { thread_unload_delay_secs: 10 }, ephemeral: true, excludeTurns: true, threadSource: 'composer_predictions' });
      job.childId = fork.thread.id; check();
      const turn = new Promise(resolve => { job.resolveTurn = resolve; });
      job.generationStarted = now();
      deadline = timer(() => cancel(job, 'Prediction exceeded ' + profile.timeoutMs + ' ms'), profile.timeoutMs);
      emit('started', { ...target, childId: job.childId, parentModel: parent.model, model: profile.model, effort: profile.effort, timeoutMs: profile.timeoutMs });
      const started = await deps.rpc(target.hostId, 'turn/start', { threadId: job.childId, model: profile.model, effort: profile.effort, serviceTier: profile.serviceTier ?? 'default', approvalPolicy: 'never', permissions: ':read-only', turnTrigger: 'composer_predictions', responsesapiClientMetadata: { prediction_source_thread_id: target.threadId, prediction_source_turn_id: target.latestTurnId, prediction_trigger: target.generationTrigger }, input: [{ type: 'text', text: config.prompt + '\n\nReturn only JSON matching this schema: ' + JSON.stringify(profile.schema) + '.', text_elements: [] }], outputSchema: profile.schema }, profile.timeoutMs);
      job.turnId ??= started.turn.id;
      if (signal.aborted) cancel(job, job.reason); check();
      const completed = await Promise.race([turn, waitAbort(signal)]); check();
      if (completed.status !== 'completed') throw Error(completed.error?.message || job.error?.message || 'Prediction turn ' + completed.status);
      const parsed = JSON.parse(job.text?.trim() || 'null');
      if (!parsed || !Object.hasOwn(parsed, 'suggestion') || (typeof parsed.suggestion !== 'string' || !parsed.suggestion.trim()) || Object.keys(parsed).some(k => k !== 'suggestion')) throw Error('Invalid prediction JSON');
      await latest(target); check();
      if (!await deps.isEnabled()) return null;
      const suppression = policyDecision(moderation.get(sourceKey(target)), deps.getPolicy?.());
      if (suppression) { emit('suppressed', { ...target, childId: job.childId, policy: suppression }); return null; }
      const answer = { requestedAt: job.requestedAt, hostKind: 'local', text: parsed.suggestion || null, predictionThreadId: job.childId, predictionTurnId: job.turnId, generationTrigger: target.generationTrigger, generationSource: 'composer_astra_adapter', predictionProfileHash: job.key.slice(-64), sourceTurnId: target.latestTurnId, model: profile.model, reasoningEffort: profile.effort, serviceTier: profile.serviceTier ?? 'default', parentServiceTier: parent.serviceTier, parentModel: parent.model, parentReasoningEffort: parent.reasoningEffort, configuredReasoningEffort: profile.effort, promptVersion: config.prompt_version, totalDurationMs: now() - job.started, inputTokens: job.usage?.inputTokens, cachedInputTokens: job.usage?.cachedInputTokens };
      emit('completed', { ...target, childId: job.childId, model: profile.model, effort: profile.effort, durationMs: answer.totalDurationMs, generationMs: now() - job.generationStarted, textCharacters: answer.text?.length ?? 0 });
      return answer;
    } catch (error) { emit(signal.aborted ? 'cancelled' : 'failed', { ...target, childId: job.childId, error: String(error) }); throw error; }
    finally {
      if (deadline) clearTimer(deadline);
      if (job.childId) {
        if (!job.completed) cancel(job, job.reason || 'Prediction ended');
        try { await deps.rpc(target.hostId, 'thread/unsubscribe', { threadId: job.childId }, 10000); emit('cleaned', { childId: job.childId }); }
        catch (error) { emit('cleanup_error', { childId: job.childId, error: String(error) }); }
      }
    }
  }
  function request(target, ineligible) {
    let release = () => {}, released = false;
    const local = new AbortController();
    const promise = (async () => {
      if (disposed) throw abortError('Adapter disabled');
      if (target.hostId !== 'local') return await deps.fallback(target, ineligible);
      if (!await deps.isEnabled()) return null;
      const config = await deps.getConfig();
      if (!validateConfig(config) || !config.is_enabled) return null;
      if (local.signal.aborted) throw local.signal.reason;
      const rate = (target.generationTrigger === 'live' ? config.live_sample_rate : config.catch_up_sample_rate) ?? 1;
      if (rate < 1 && (deps.random ?? Math.random)() >= rate) return null;
      const revision = await deps.hash(JSON.stringify([config.prompt, config.prompt_version, profile.model, profile.effort, profile.timeoutMs, profile.serviceTier ?? 'default', profile.revision ?? null]));
      const key = sourceKey(target) + ':' + revision;
      if (local.signal.aborted) throw local.signal.reason;
      if (cache.has(key)) { await latest(target); const value = cache.get(key); return value == null ? null : { ...value, generationTrigger: target.generationTrigger }; }
      for (const [k, j] of jobs) if (j.target.hostId === target.hostId && j.target.threadId === target.threadId && k !== key) cancel(j, 'Source or prediction profile changed');
      for (const k of cache.keys()) if (k.startsWith(JSON.stringify([target.hostId, target.threadId]).slice(0, -1) + ',') && k !== key) cache.delete(k);
      let job = jobs.get(key);
      if (!job) {
        job = { key, target, started: now(), requestedAt: new Date(now()).toISOString(), refs: 0, controller: new AbortController(), completed: false, settled: false };
        jobs.set(key, job);
        job.promise = run(job, config, ineligible).then(value => { if (job.controller.signal.aborted) throw job.controller.signal.reason; cache.set(key, value); return value; }).finally(() => { job.settled = true; if (jobs.get(key) === job) jobs.delete(key); });
        job.promise.catch(() => {});
      }
      job.refs++;
      release = () => { if (--job.refs === 0 && !job.settled) cancel(job, 'No remaining prediction consumers'); };
      if (released) release();
      return await Promise.race([job.promise, waitAbort(local.signal), waitAbort(job.controller.signal)]);
    })();
    promise[Symbol.dispose] = () => { if (released) return; released = true; local.abort(abortError('Prediction consumer disposed')); release(); };
    return promise;
  }
  return { request, notify, abortAll, policyDecision, status: () => ({ jobs: jobs.size, cached: cache.size, disposed }), dispose: () => { disposed = true; abortAll('Adapter disabled'); } };
}
