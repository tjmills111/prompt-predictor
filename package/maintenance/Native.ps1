# External-process boundary; OS-mocked installer tests replace only this fixture provider.
function Get-PrototypePrograms { return [Environment]::GetFolderPath('Programs') }
function Invoke-PrototypeTool {
    param([string]$File,[string[]]$Arguments)
    $priorPreference=$ErrorActionPreference
    try {
        $ErrorActionPreference='Continue'
        & $File @Arguments
        $toolExit=$LASTEXITCODE
    } finally { $ErrorActionPreference=$priorPreference }
    if($toolExit -ne 0){throw "Tool failed ($toolExit): $File"}
}
