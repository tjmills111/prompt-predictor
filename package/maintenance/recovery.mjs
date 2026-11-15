// One recorder recovery attempt per failure episode. Never restarts Codex.
export async function recoverRecorder({appRunning, processAlive, intentionalStop, previous, probe, start, inspect}) {
  if (!appRunning) return {state:'app_closed'};
  if (processAlive) return previous ?? {state:'process_alive'};
  if (intentionalStop) return {state:'intentional_stop'};
  if (previous?.attempted) return previous;
  let targets;
  try { targets=await probe(); } catch { return {state:'connection_unavailable',automaticRecovery:false}; }
  if (!Array.isArray(targets) || !targets.some(t=>t.type==='page' && t.url==='app://-/index.html' && /^ws:\/\/127\.0\.0\.1:19227\//.test(t.webSocketDebuggerUrl??''))) return {state:'connection_unavailable',automaticRecovery:false};
  const result={state:'attempted',attempted:true,at:new Date().toISOString(),automaticRecovery:false};
  try {
    await start();
    const status=await inspect();
    const age=Date.now()-Date.parse(status?.at);
    const ready=status?.processAlive && age>=0 && age<30000 && status.state==='recording' && status.targets?.length && status.targets.every(t=>t.connected && t.capture?.state==='compatible' && ['live','catch_up','submission','interaction'].every(h=>t.hooks?.includes(h)) && t.generation?.state==='active');
    return {...result,state:ready?'recovered':'attempted_not_healthy',automaticRecovery:!!ready};
  } catch(error) { return {...result,state:'failed',error:String(error)}; }
}
