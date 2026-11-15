// Configuration is intent; only a fresh, connected renderer proves activation.
export function generationHealth(configured, status, { now = Date.now(), processAlive = true } = {}) {
  const targets = status?.targets ?? [];
  const heartbeatAgeSeconds = status?.at ? (now - Date.parse(status.at)) / 1000 : null;
  const failures = Object.values(status?.recovery ?? {}).filter(r => r.blocked).map(r => r.reason);
  const active = targets.length > 0 && targets.every(t => t.connected && t.generation?.state === 'active');
  const fresh = processAlive && heartbeatAgeSeconds !== null && Number.isFinite(heartbeatAgeSeconds) && heartbeatAgeSeconds >= 0 && heartbeatAgeSeconds <= 20;
  return {
    configured,
    state: !configured ? 'disabled' : !fresh ? 'unavailable_or_stale' : active ? 'active' : 'configured_but_inactive',
    heartbeatAgeSeconds,
    recorderState: status?.state ?? 'unknown',
    reasons: [...failures, ...targets.flatMap(t => t.generation?.error ? [t.generation.error] : [])],
    targets: targets.map(t => ({ id: t.id, connected: t.connected, generation: t.generation })),
  };
}
