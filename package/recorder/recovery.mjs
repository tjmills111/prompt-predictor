// Capture incompatibility requires review; transport failures earn bounded retries.
export class IncompatibleCapture extends Error {}
export function isTemporary(error) {
  return /Debugger (?:timeout|disconnected|not connected|connect timeout|connect failed|socket error)|Cannot find context|Execution context was destroyed|No script with given id/i.test(String(error?.message ?? error));
}
export class RecoveryGate {
  constructor(now = Date.now) { this.now = now; this.entries = new Map(); }
  state(key) { return this.entries.get(key) ?? { attempts: 0, nextAt: 0, blocked: false }; }
  ready(key) { const s = this.state(key); return !s.blocked && this.now() >= s.nextAt; }
  fail(key, error) {
    const prior = this.state(key), attempts = prior.attempts + 1;
    const kind = error instanceof IncompatibleCapture ? 'incompatible' : isTemporary(error) ? 'temporary' : 'needs_review';
    const blocked = kind !== 'temporary' || attempts > 3;
    const value = { attempts, kind, blocked, reason: String(error.message ?? error), nextAt: blocked ? null : this.now() + [2000, 5000, 15000][attempts - 1] };
    this.entries.set(key, value); return value;
  }
  reset(key) { this.entries.delete(key); }
  healthy(key, since) { if (this.now() - since >= 30000) this.reset(key); }
}

// This queue never gates capture installation or the recorder's main loop.
// A timed-out status evaluation is not evidence that reviewed renderer code changed.
// Retry only this observed failure; arm/binding errors still stop in the queue below.
export function generationCheckReady(client) {
  return !client.generationFailed && (!client.generationCheckRecovery || client.generationCheckRecovery.ready('ensure'));
}
export function recordGenerationCheck(client, now = Date.now) {
  if (client.generationState?.state === 'error') {
    client.generationHealthySince = null;
    if (!/^(?:Error: )?Debugger timeout: Runtime\.evaluate$/.test(client.generationState.error ?? '')) {
      client.generationFailed = true;
      return;
    }
    client.generationCheckRecovery ??= new RecoveryGate(now);
    const recovery = client.generationCheckRecovery.fail('ensure', Error('Debugger timeout: Runtime.evaluate'));
    client.generationState = { ...client.generationState, recovery };
    client.generationFailed = recovery.blocked;
  } else if (client.generationState?.state === 'active' && client.generationCheckRecovery) {
    client.generationHealthySince ??= now();
    client.generationCheckRecovery.healthy('ensure', client.generationHealthySince);
  } else {
    client.generationHealthySince = null;
  }
}
export function scheduleGeneration(client, task) {
  client.generationQueue ??= Promise.resolve();
  client.generationQueue = client.generationQueue.then(task).catch(error => {
    client.generationState = { state: 'error', error: String(error) };
    client.generationFailed = true;
  });
  return client.generationQueue;
}
