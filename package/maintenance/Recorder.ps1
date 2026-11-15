param([ValidateSet('Start','Run','Stop','Status','Launch','Export','Reconnect')][string]$Action='Status')
$ErrorActionPreference='Stop'
$source=Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Paths.ps1')
$paths=Read-PrototypePaths
$node=$paths.node
$entry=Join-Path $source 'recorder\recorder.mjs'
$runtime=Join-Path $env:LOCALAPPDATA 'GreyPredictionComposer\capture'
$stateGuard=Join-Path $PSScriptRoot 'codex-state-guard.py'
$guardRuntime=Join-Path $env:LOCALAPPDATA 'GreyPredictionComposer\settings-guard'
$guardPython=$paths.python
if($Action -in @('Start','Launch') -and (Test-Path -LiteralPath $stateGuard)){
  & $guardPython -B $stateGuard ensure-watch --runtime $guardRuntime | Out-Null
  if($LASTEXITCODE -ne 0){throw 'Codex settings snapshot guard could not start'}
}
if(-not(Test-Path -LiteralPath $node)){throw 'Node 22.20 or later is required'}
function Invoke-CodexPackageActivation([string]$AppId,[string]$Arguments){
  if(-not ('CodexPackageActivation' -as [type])){
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ICodexApplicationActivationManager {
  [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appId, [MarshalAs(UnmanagedType.LPWStr)] string arguments, uint options, out uint processId);
}
public static class CodexPackageActivation {
  public static uint Launch(string appId, string arguments) {
    object manager=Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("45ba127d-10a8-46ea-8ab7-56ea9078943c")));
    try {
      uint pid;
      int result=((ICodexApplicationActivationManager)manager).ActivateApplication(appId, arguments, 0, out pid);
      Marshal.ThrowExceptionForHR(result);
      return pid;
    } finally { Marshal.FinalReleaseComObject(manager); }
  }
}
"@
  }
  [CodexPackageActivation]::Launch($AppId,$Arguments)
}
switch($Action){
 'Start' {
   $lock=Join-Path $runtime 'recorder.lock'
   if(Test-Path -LiteralPath $lock){
     $owner=Get-Content -LiteralPath $lock -Raw | ConvertFrom-Json
     if(Get-Process -Id $owner.pid -ErrorAction SilentlyContinue){Write-Output "Recorder already running: $($owner.pid)";return}
   }
   Start-Process powershell.exe -ArgumentList @('-NoProfile','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',('"'+$PSCommandPath+'"'),'-Action','Run') -WindowStyle Hidden
 }
 'Run' {
   New-Item -ItemType Directory -Path $runtime -Force | Out-Null
   $stop=Join-Path $runtime 'stop'
   if(Test-Path -LiteralPath $stop){Remove-Item -LiteralPath $stop}
   $log=Join-Path $runtime 'errors.log'
   while($true){
     if((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -gt 1048576){Move-Item -LiteralPath $log -Destination (Join-Path $runtime 'errors.previous.log') -Force}
     & $node --no-warnings $entry run 2>> $log
     if($LASTEXITCODE -eq 0 -or (Test-Path -LiteralPath $stop)){break}
     Start-Sleep -Seconds 10
   }
 }
 'Stop' { & $node --no-warnings $entry stop }
 'Status' { & $node --no-warnings $entry status }
 'Reconnect' { & $node --no-warnings $entry reconnect }
 'Export' { & $node --no-warnings $entry export }
 'Launch' {
   $launchMutex=New-Object System.Threading.Mutex($false,'Local\PromptPredictorPackageLaunch')
   $ownsLaunch=$false
   try {
     try { $ownsLaunch=$launchMutex.WaitOne(30000) } catch [System.Threading.AbandonedMutexException] { $ownsLaunch=$true }
     if(-not $ownsLaunch){throw 'Another ChatGPT launch is still in progress; no additional launch was attempted.'}
   # Keep the recorder alive/reporting even if another route opened the app without debugging.
   & $PSCommandPath -Action Start
   $app=Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
   if(-not $app){throw 'Installed ChatGPT package not found'}
   # Use the same packaged-app identity/activation route as native Windows entrypoints.
   $appId=$app.PackageFamilyName+'!App'
   try { $targets=Invoke-RestMethod http://127.0.0.1:19227/json/list -TimeoutSec 2 } catch { $targets=$null }
   $runningApps=@(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue)
   if($runningApps.Count -gt 0){
     # Reuse the existing window without starting another executable.
     $window=$runningApps | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
     if($window){
       $shell=New-Object -ComObject WScript.Shell
       [void]$shell.AppActivate($window.Id)
     }else{
       Write-Warning 'ChatGPT is already running in the background. No second instance was started.'
     }
     if(-not $targets){Write-Warning 'ChatGPT is running without local debugging, so recording is off until you quit it fully and reopen. Nothing was closed.'}
     return
   }
   if(Get-NetTCPConnection -State Listen -LocalPort 19227 -ErrorAction SilentlyContinue){throw 'Port 19227 is occupied; app was not launched'}
   # Validate/recover settings before the app can replace unreadable state with defaults.
   # This independent guard does not patch Codex or change valid settings.
   if(-not(Test-Path -LiteralPath $stateGuard)){throw 'Codex settings recovery guard is missing; app was not launched.'}
   & $guardPython -B $stateGuard preflight --runtime $guardRuntime
   if($LASTEXITCODE -ne 0){throw 'Codex settings recovery failed; app was not launched. See the CodexStateRecovery history.'}
   # No -WindowStyle Hidden: Windows applies it to the app's first ShowWindow, which can leave the main window hidden.
   [void](Invoke-CodexPackageActivation $appId '--remote-debugging-address=127.0.0.1 --remote-debugging-port=19227')
   } finally {
     if($ownsLaunch){$launchMutex.ReleaseMutex()}
     $launchMutex.Dispose()
   }
 }
}
