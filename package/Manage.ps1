param([ValidateSet('Check','Install','Status','Remove','Restore')][string]$Action='Check',
      [switch]$NativeWorker,[string]$ResultPath,[string]$NodePath,[string]$UvPath)
$ErrorActionPreference='Stop'
$owner='prompt-predictor-prototype-v1'
$runtime=Join-Path $env:LOCALAPPDATA 'GreyPredictionComposer'
$source=Join-Path $env:LOCALAPPDATA 'PromptPredictorPrototype\app'
$record=Join-Path $runtime 'installation.json'
$taskName='PromptComposerReliabilityMonitor'
$runKey='HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$shellExe=Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
. (Join-Path $PSScriptRoot 'maintenance\Native.ps1')

# WMI launches outside packaged-app redirected registry/filesystem views.
if(-not $NativeWorker){
    if($Action -in @('Check','Install')){
        if(-not $NodePath){$discovered=Get-Command node -ErrorAction SilentlyContinue;if($discovered){$NodePath=$discovered.Source}}
        if(-not $UvPath){$discovered=Get-Command uv -ErrorAction SilentlyContinue;if($discovered){$UvPath=$discovered.Source}}
    }
    $receipt=Join-Path $PSScriptRoot ('operation-'+[guid]::NewGuid().ToString('N')+'.json')
    $command='"'+$shellExe+'" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$PSCommandPath+'" -Action '+$Action+' -NativeWorker -ResultPath "'+$receipt+'"'
    if($NodePath){$command+=' -NodePath "'+$NodePath+'"'}
    if($UvPath){$command+=' -UvPath "'+$UvPath+'"'}
    $startup=New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}
    $worker=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$command;ProcessStartupInformation=$startup}
    if($worker.ReturnValue -ne 0){throw 'Could not start native Windows worker'}
    $deadline=(Get-Date).AddMinutes(10)
    while(-not(Test-Path -LiteralPath $receipt)){
        if((Get-Date) -gt $deadline){throw "Operation not confirmed. Do not retry blindly; inspect worker $($worker.ProcessId)."}
        Start-Sleep -Milliseconds 500
    }
    $result=Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
    $result | ConvertTo-Json -Depth 7
    if(-not $result.success){exit 1};exit 0
}

function Save-Installation($installation){
    $temp=$record+'.tmp'
    $installation | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath $temp -Encoding UTF8
    Move-Item -LiteralPath $temp -Destination $record -Force
}
function Get-OwnedInstallation {
    $i=Get-Content -LiteralPath $record -Raw | ConvertFrom-Json
    if($i.owner -ne $owner -or $i.source -ne $source -or $i.runtime -ne $runtime){throw 'Installation ownership/path mismatch; nothing removed'}
    return $i
}
function Check-Package {
    $manifest=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -Raw | ConvertFrom-Json
    if($manifest.owner -ne $owner){throw 'Unexpected package identity'}
    foreach($entry in $manifest.files.PSObject.Properties){
        if([IO.Path]::IsPathRooted($entry.Name) -or $entry.Name.Split('/') -contains '..'){throw 'Unsafe package member'}
        $file=Join-Path $PSScriptRoot $entry.Name
        if(-not(Test-Path -LiteralPath $file -PathType Leaf) -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLower() -ne $entry.Value){throw ('Package integrity mismatch: '+$entry.Name)}
    }
    return $manifest
}
function Preflight([switch]$ForRestore) {
    $manifest=Check-Package
    $retained=$null
    if($ForRestore){
        $retained=Get-OwnedInstallation
        if($retained.removed -ne $true -or $retained.installedComplete -ne $true){throw 'Restore requires an owned completed installation and confirmed successful removal'}
        $packageHash=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -Algorithm SHA256).Hash.ToLower()
        if($retained.packageSha256 -ne $packageHash -or (Get-FileHash -LiteralPath (Join-Path $source 'manifest.json') -Algorithm SHA256).Hash.ToLower() -ne $packageHash){throw 'Restore requires the identical package; upgrades and legacy records are not supported'}
        foreach($entry in $manifest.files.PSObject.Properties){
            $file=Join-Path $source $entry.Name
            if(-not(Test-Path -LiteralPath $file -PathType Leaf) -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLower() -ne $entry.Value){throw ('Retained package changed; nothing overwritten: '+$entry.Name)}
        }
        foreach($file in @($retained.node,$retained.python,$retained.pythonw)){
            if(-not(Test-Path -LiteralPath $file -PathType Leaf)){throw 'Retained runtime is missing; Restore does not rebuild dependencies'}
        }
        if($retained.python -ne (Join-Path $runtime 'venv\Scripts\python.exe') -or $retained.pythonw -ne (Join-Path $runtime 'venv\Scripts\pythonw.exe')){throw 'Retained Python path mismatch'}
        $certificate=[Security.Cryptography.X509Certificates.X509Certificate2]::new((Join-Path $runtime 'ca\mitmproxy-ca-cert.cer'))
        if($retained.thumbprint -ne $certificate.Thumbprint -or (Get-Content -LiteralPath (Join-Path $runtime 'certificate-thumbprint.txt') -Raw).Trim() -ne $certificate.Thumbprint){throw 'Retained certificate identity mismatch'}
        if(Test-Path -LiteralPath ('Cert:\CurrentUser\Root\'+$certificate.Thumbprint)){throw 'Retained certificate is still trusted; removal must be complete before Restore'}
    }else{
        if(Test-Path -LiteralPath $runtime){throw 'Existing runtime: preserve it; use Restore only after owned successful removal'}
        if(Test-Path -LiteralPath $source){throw 'Existing source installation; no overwrite'}
    }
    $auth=Join-Path $env:USERPROFILE '.codex\auth.json'
    if(-not(Test-Path -LiteralPath $auth)){throw 'Sign in with ChatGPT first; default file-based authentication is required'}
    if($env:CODEX_HOME -and [IO.Path]::GetFullPath($env:CODEX_HOME) -ne [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.codex'))){throw 'Custom CODEX_HOME is not supported by this prototype'}
    $app=Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1
    if(-not $app -or [string]$app.Version -ne $manifest.appVersion){throw ('Unsupported app build; reviewed build is '+$manifest.appVersion)}
    $proxy=Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
    if($proxy.AutoConfigURL -or $proxy.ProxyEnable){throw 'Existing proxy/PAC; no replacement'}
    $run=Get-ItemProperty -LiteralPath $runKey -ErrorAction SilentlyContinue
    if($run.GreyPredictionComposer -or $run.ComposerPredictionsRecorder -or $run.PromptPredictorRecorder){throw 'Existing startup owner; preserve it'}
    if(Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue){throw 'Existing monitor task; preserve it'}
    $ports=if($ForRestore){@(18891,18892)}else{@(18891,18892,19227)}
    foreach($port in $ports){if(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue){throw "Port $port is occupied; no changes"}}
    $nativeStartup=Get-ItemProperty -LiteralPath 'HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\SystemAppData\OpenAI.Codex_2p2nqsd0c76g0\App' -ErrorAction SilentlyContinue
    if($nativeStartup.State -eq 2){throw 'Turn off the competing native app entry in Windows Startup settings first; then retry'}
    $shortcut=Join-Path (Get-PrototypePrograms) 'Prompt Predictor.lnk'
    if(Test-Path -LiteralPath $shortcut){throw 'Existing Prompt Predictor shortcut; preserve it'}
    if($ForRestore){
        if($retained.shortcut -ne $shortcut){throw 'Retained shortcut path mismatch'}
        $node=$retained.node;$uv=$null
    }elseif($NodePath){if(-not(Test-Path -LiteralPath $NodePath -PathType Leaf)){throw 'NodePath does not exist'};$node=$NodePath}
    else{$found=Get-Command node -ErrorAction SilentlyContinue;if(-not $found){throw 'The installing AI should obtain Node, then pass its absolute -NodePath'};$node=$found.Source}
    if(-not $ForRestore){
        if($UvPath){if(-not(Test-Path -LiteralPath $UvPath -PathType Leaf)){throw 'UvPath does not exist'};$uv=$UvPath}
        else{$found=Get-Command uv -ErrorAction SilentlyContinue;if(-not $found){throw 'The installing AI should obtain uv, then pass its absolute -UvPath'};$uv=$found.Source}
    }
    Invoke-PrototypeTool $node @('--no-warnings',(Join-Path $PSScriptRoot 'maintenance\runtime-check.mjs')) | Out-Null
    if($ForRestore){
        if(Get-NetTCPConnection -State Listen -LocalPort 19227 -ErrorAction SilentlyContinue){
            if(-not(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue)){throw 'Debug port has another owner; Restore did not change anything'}
            Invoke-PrototypeTool $node @('--no-warnings',(Join-Path $source 'maintenance\restore-renderer-check.mjs')) | Out-Null
        }
        Invoke-PrototypeTool $retained.python @('-B',(Join-Path $source 'maintenance\restore-check.py')) | Out-Null
    }
    return @{manifest=$manifest;node=$node;uv=$uv;shortcut=$shortcut;installation=$retained}
}
function Assert-Owners($i){
    $run=Get-ItemProperty -LiteralPath $runKey -ErrorAction SilentlyContinue
    if($run.PromptPredictorRecorder -and $run.PromptPredictorRecorder -ne $i.startupCommand){throw 'Recorder startup was changed by another owner; preserve it'}
    if($run.GreyPredictionComposer){
        if($i.helperCommand){if($run.GreyPredictionComposer -ne $i.helperCommand){throw 'Helper startup changed; preserve it'}}
        elseif($run.GreyPredictionComposer.IndexOf((Join-Path $source 'control.py'),[StringComparison]::OrdinalIgnoreCase) -lt 0){throw 'Helper startup has another owner; preserve it'}
    }
    $task=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if($task -and ($task.Actions.Execute -ne $i.pythonw -or $task.Actions.Arguments -ne $i.taskArguments)){throw 'Monitor task has another owner; preserve it'}
    if(Test-Path -LiteralPath $i.shortcut){
        $link=(New-Object -ComObject WScript.Shell).CreateShortcut($i.shortcut)
        if($link.TargetPath -ne $shellExe -or $link.Arguments -ne $i.launchArguments){throw 'Shortcut has another owner; preserve it'}
    }
}
function Remove-Prototype($i){
    if($i.removed){return @{success=$true;removed=$true;alreadyRemoved=$true;dataRetained=$true}}
    Assert-Owners $i
    $task=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if($task){Stop-ScheduledTask -TaskName $taskName;Unregister-ScheduledTask -TaskName $taskName -Confirm:$false}
    $capture=Join-Path $runtime 'capture'
    if(Test-Path -LiteralPath $capture){
        @{enabled=$false;updatedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $capture 'generation.json') -Encoding ascii
        Invoke-PrototypeTool $i.node @('--no-warnings',(Join-Path $source 'recorder\recorder.mjs'),'stop') | Out-Null
        $deadline=(Get-Date).AddSeconds(20)
        while(Test-Path -LiteralPath (Join-Path $capture 'recorder.lock')){
            $lock=Get-Content -LiteralPath (Join-Path $capture 'recorder.lock') -Raw | ConvertFrom-Json
            if(-not(Get-Process -Id $lock.pid -ErrorAction SilentlyContinue)){break}
            if((Get-Date) -gt $deadline){throw 'Recorder stop not confirmed; nothing force-killed. Retry after normal app exit.'}
            Start-Sleep -Milliseconds 250
        }
    }
    if($i.activationAttempted){
        $cleanupArgs=@('--no-warnings',(Join-Path $source 'maintenance\cleanup.mjs'))
        if(-not(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue)){$cleanupArgs+='--app-closed'}
        Invoke-PrototypeTool $i.node $cleanupArgs | Out-Null
        Invoke-PrototypeTool $i.python @('-B',(Join-Path $source 'maintenance\codex-state-guard.py'),'stop','--runtime',(Join-Path $runtime 'settings-guard')) | Out-Null
    }
    $run=Get-ItemProperty -LiteralPath $runKey -ErrorAction SilentlyContinue
    if($run.PromptPredictorRecorder){Remove-ItemProperty -LiteralPath $runKey -Name PromptPredictorRecorder}
    if(Test-Path -LiteralPath $i.shortcut){Remove-Item -LiteralPath $i.shortcut}
    if($i.helperAttempted){Invoke-PrototypeTool $i.python @('-B',(Join-Path $source 'control.py'),'disable') | Out-Null}
    foreach($port in @(18891,18892)){if(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue){throw 'Helper shutdown unconfirmed; certificate retained. Inspect before retrying.'}}
    if($i.trustAdded -and $i.thumbprint){
        if($i.thumbprint -notmatch '^[A-Fa-f0-9]{40}$'){throw 'Invalid certificate thumbprint'}
        if(Test-Path -LiteralPath ('Cert:\CurrentUser\Root\'+$i.thumbprint)){
            Invoke-PrototypeTool 'certutil.exe' @('-user','-delstore','Root',$i.thumbprint) | Out-Null
            if(Test-Path -LiteralPath ('Cert:\CurrentUser\Root\'+$i.thumbprint)){throw 'Certificate removal not confirmed'}
        }
    }
    $i.removed=$true;Save-Installation $i
    return @{success=$true;removed=$true;dataRetained=$true;source=$source;note='Owned controls removed. Files, records and local certificates/keys retained without trust; app not closed.'}
}

$installation=$null
try{
    if($Action -eq 'Check'){
        $check=Preflight
        $result=@{success=$true;changesMade=$false;appVersion=$check.manifest.appVersion;note='Read-only local preflight; account eligibility/network/install remain unverified.'}
    }elseif($Action -eq 'Status'){
        $installation=Get-OwnedInstallation
        $result=@{success=$true;installation=$installation;note='Use recorder status and app receipt for activation; installed is not verified display.'}
        if(-not $installation.removed){
            $result.recorder=Invoke-PrototypeTool $installation.node @('--no-warnings',(Join-Path $source 'recorder\recorder.mjs'),'status') | Out-String
            $result.helper=Invoke-PrototypeTool $installation.python @('-B',(Join-Path $source 'control.py'),'status') | Out-String
            $monitorStatus=Join-Path $runtime 'capture\monitor.json'
            if(Test-Path -LiteralPath $monitorStatus){$result.monitor=Get-Content -LiteralPath $monitorStatus -Raw | ConvertFrom-Json}
        }
    }elseif($Action -eq 'Remove'){
        $installation=Get-OwnedInstallation
        $result=Remove-Prototype $installation
    }else{
        if($Action -eq 'Restore'){
            $check=Preflight -ForRestore
            $installation=$check.installation
            $python=$installation.python;$pythonw=$installation.pythonw
            $launchArguments=$installation.launchArguments
            $installation.removed=$false;$installation.trustAdded=$false
            $installation.helperAttempted=$false;$installation.activationAttempted=$false
            Save-Installation $installation
        }else{
        $check=Preflight
        New-Item -ItemType Directory -Path $source -Force | Out-Null
        foreach($entry in $check.manifest.files.PSObject.Properties){
            $target=Join-Path $source $entry.Name
            New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
            Copy-Item -LiteralPath (Join-Path $PSScriptRoot $entry.Name) -Destination $target
        }
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -Destination (Join-Path $source 'manifest.json')
        New-Item -ItemType Directory -Path $runtime -Force | Out-Null
        $python=Join-Path $runtime 'venv\Scripts\python.exe'
        $pythonw=Join-Path $runtime 'venv\Scripts\pythonw.exe'
        $launchArguments='-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+(Join-Path $source 'maintenance\Recorder.ps1')+'" -Action Launch'
        $installation=@{owner=$owner;source=$source;runtime=$runtime;node=$check.node;python=$python;pythonw=$pythonw;shortcut=$check.shortcut;launchArguments=$launchArguments;startupCommand=('"'+$shellExe+'" '+$launchArguments);taskArguments=('"'+(Join-Path $source 'maintenance\Monitor.pyw')+'" -Action Check');removed=$false;trustAdded=$false;thumbprint=$null;helperAttempted=$false;helperCommand=$null;activationAttempted=$false;installedComplete=$false;packageSha256=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -Algorithm SHA256).Hash.ToLower()}
        Save-Installation $installation
        Invoke-PrototypeTool $check.uv @('venv','--python','3.14',(Join-Path $runtime 'venv')) | Out-Null
        Invoke-PrototypeTool $check.uv @('pip','install','--python',$python,'-r',(Join-Path $source 'requirements.txt')) | Out-Null
        Invoke-PrototypeTool $python @('-B','-c','import sys;sys.path.insert(0,sys.argv[1]);import control;control.require_native_runtime()',$source) | Out-Null
        Invoke-PrototypeTool $python @('-B',(Join-Path $source 'control.py'),'prepare') | Out-Null
        }
        $stock=Get-Content -LiteralPath (Join-Path $runtime 'stock-config.json') -Raw | ConvertFrom-Json
        if(-not $stock.is_enabled){throw 'Account is not eligible; no routing or trust enabled'}
        $cert=[Security.Cryptography.X509Certificates.X509Certificate2]::new((Join-Path $runtime 'ca\mitmproxy-ca-cert.cer'))
        $installation.thumbprint=$cert.Thumbprint
        $cert.Thumbprint | Set-Content -LiteralPath (Join-Path $runtime 'certificate-thumbprint.txt')
        if(Test-Path -LiteralPath ('Cert:\CurrentUser\Root\'+$cert.Thumbprint)){throw 'Unexpected existing trust for a fresh CA; inspect before proceeding'}
        $installation.trustAdded=$true;Save-Installation $installation
        Invoke-PrototypeTool 'certutil.exe' @('-user','-addstore','Root',(Join-Path $runtime 'ca\mitmproxy-ca-cert.cer')) | Out-Null
        if(-not(Test-Path -LiteralPath ('Cert:\CurrentUser\Root\'+$cert.Thumbprint))){throw 'Certificate trust unconfirmed'}
        $installation.helperAttempted=$true;Save-Installation $installation
        Invoke-PrototypeTool $python @('-B',(Join-Path $source 'control.py'),'enable') | Out-Null
        $installation.helperCommand=(Get-ItemProperty -LiteralPath $runKey).GreyPredictionComposer
        if(-not $installation.helperCommand){throw 'Helper startup registration missing'}
        Save-Installation $installation
        Invoke-PrototypeTool $python @('-B',(Join-Path $source 'control.py'),'verify') | Out-Null
        $capture=Join-Path $runtime 'capture';New-Item -ItemType Directory -Path $capture -Force | Out-Null
        @{enabled=$true;updatedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $capture 'generation.json') -Encoding ascii
        $link=(New-Object -ComObject WScript.Shell).CreateShortcut($installation.shortcut)
        $link.TargetPath=$shellExe;$link.Arguments=$launchArguments;$link.WorkingDirectory=$source;$link.Description='Prompt Predictor';$link.WindowStyle=7;$link.Save()
        Set-ItemProperty -LiteralPath $runKey -Name PromptPredictorRecorder -Value $installation.startupCommand
        $taskAction=New-ScheduledTaskAction -Execute $pythonw -Argument $installation.taskArguments
        $trigger=@((New-ScheduledTaskTrigger -AtLogOn),(New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 2)))
        $principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
        $settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 1)
        Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
        Assert-Owners $installation
        $installedRun=Get-ItemProperty -LiteralPath $runKey
        if($installedRun.PromptPredictorRecorder -ne $installation.startupCommand -or -not(Get-ScheduledTask -TaskName $taskName)){throw 'Startup/monitor registration unconfirmed'}
        $installation.activationAttempted=$true;Save-Installation $installation
        Invoke-PrototypeTool $shellExe @('-NoProfile','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',(Join-Path $source 'maintenance\Recorder.ps1'),'-Action','Start') | Out-Null
        $installation.installedComplete=$true;Save-Installation $installation
        # Does not launch/restart Codex. Normal launch is a user-selected next step.
        $result=@{success=$true;installed=$true;restored=($Action -eq 'Restore');displayVerified=$false;source=$source;next='When ready, reopen Codex using Prompt Predictor in Start. Check status, app prompt receipt and a real suggestion.'}
    }
}catch{
    $failure=$_.Exception.Message;$rollback=$null
    if($Action -in @('Install','Restore') -and $installation){try{$rollback=Remove-Prototype $installation}catch{$rollback=@{success=$false;error=$_.Exception.Message}}}
    $result=@{success=$false;error=$failure;rollback=$rollback;note='Files/data retained. Inspect result before retrying.'}
}
if($ResultPath){
    $receiptTemp=$ResultPath+'.tmp'
    $result | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath $receiptTemp -Encoding UTF8
    Move-Item -LiteralPath $receiptTemp -Destination $ResultPath -Force
}
$result | ConvertTo-Json -Depth 7
if(-not $result.success){exit 1}
exit 0
