export function evaluateHealth(status, { now = Date.now(), processAlive = false, appRunning = true, generationConfigured = true, proxyAvailable = true, configurationProblem = null, newGaps = 0, gapIds, conflicts = 0, recentFailures = 0 } = {}) {
  if (!appRunning) return { state: 'idle_app_closed', issues: [] };
  const issues = [];
  const add = (code, detail) => issues.push({ code, detail });
  const age = status?.at ? (now - Date.parse(status.at)) / 1000 : Infinity;
  if (!processAlive || !Number.isFinite(age) || age < 0 || age > 30) add('recorder_stopped_or_stale', 'Recorder process or status heartbeat is unavailable');
  else {
    if (status.state !== 'recording' || !status.targets?.length || status.targets.some(t => !t.connected || t.capture?.state !== 'compatible' || ['live','catch_up','submission','interaction'].some(h => !t.hooks?.includes(h)))) add('capture_unavailable', 'Recorder is not attached with all four reviewed hooks');
    if (generationConfigured && (!status.targets?.length || status.targets.some(t => t.generation?.state !== 'active'))) add('generation_inactive', 'Configured prediction engine is not active');
    if (status.historyError || status.history?.rolloutErrors?.length) add('history_read_failed', status.historyError ?? 'A saved transcript could not be read');
  }
  if (!proxyAvailable) add('configuration_proxy_unavailable', 'Local configuration service is unavailable');
  if (configurationProblem) add('configuration_not_applied', configurationProblem);
  if (newGaps) issues.push({code:'new_comparison_gap',detail:`${newGaps} unresolved source/native-message gaps beyond the historical baseline remain after the saving grace period`,...(gapIds ? {identities:gapIds} : {})});
  if (conflicts) add('original_identity_conflict', `${conflicts} new conflicts in captured original identity/text`);
  if (recentFailures >= 3) add('repeated_generation_failure', `${recentFailures} generation errors in the last 15 minutes, excluding stale-source/cancellation outcomes`);
  return { state: issues.length ? 'attention' : 'healthy', issues, heartbeatAgeSeconds: Number.isFinite(age) ? age : null };
}

// Alert once on a persistent change, retain the incident, and record recovery.
// No timer is inferred from lastReceipt: quiet use is not a failure.
export function advanceMonitor(previous, health, now = Date.now()) {
  const key = health.issues.map(i => i.code).sort().join('|');
  const priorKey = previous?.pendingKey ?? '';
  const pendingSince = key === priorKey ? previous?.pendingSince ?? now : now;
  const persistent = !!key && now - pendingSince >= 60000;
  const gapIds = health.issues.find(i=>i.code==='new_comparison_gap')?.identities;
  // Migrate an already disclosed warning without treating all its old records
  // as fresh losses. New IDs still earn a separate persistent notification.
  const acknowledged = previous?.alertedGapIds ?? (previous?.alertedKey?.includes('new_comparison_gap') ? gapIds ?? [] : []);
  const unseen = (gapIds ?? []).filter(id=>!acknowledged.includes(id)).sort();
  const gapPendingKey = unseen.join('|');
  const gapPendingSince = gapPendingKey === previous?.gapPendingKey ? previous.gapPendingSince : now;
  const alert = persistent && key !== previous?.alertedKey || unseen.length > 0 && now-gapPendingSince >= 60000;
  const recovered = !key && !!previous?.alertedKey && health.state === 'healthy';
  return { ...previous, at: new Date(now).toISOString(), health, pendingKey: key, pendingSince, alertedKey: alert ? key : key ? previous?.alertedKey ?? '' : '', alert, recovered, gapPendingKey, gapPendingSince, alertedGapIds:gapIds ? (alert ? gapIds : acknowledged.filter(id=>gapIds.includes(id))) : [] };
}

export function classifyGaps(gaps, baselineIds, startedAt, now = Date.now()) {
  const baselineGapIds = baselineIds ?? gaps.filter(g => g.first_seen <= startedAt).map(g => g.id);
  const known = new Set(baselineGapIds);
  return {
    baselineGapIds,
    knownHistoricalGaps: gaps.filter(g => known.has(g.id)).length,
    // A newly lost OLD comparison is a new incident too. Never silently rebase
    // historical exceptions on every check or consider only new predictions.
    newGaps: gaps.filter(g => !known.has(g.id) && Date.parse(g.first_seen) < now - 120000).length,
    newGapIds: gaps.filter(g => !known.has(g.id) && Date.parse(g.first_seen) < now - 120000).map(g=>g.id).sort(),
  };
}
