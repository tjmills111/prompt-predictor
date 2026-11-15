param([ValidateSet('Check','Status')][string]$Action='Check')
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Paths.ps1')
$node=(Read-PrototypePaths).node
$entry=Join-Path $PSScriptRoot 'monitor.mjs'
if($Action -eq 'Status'){& $node --no-warnings $entry status}
else{& $node --no-warnings $entry check --quiet}
exit $LASTEXITCODE
