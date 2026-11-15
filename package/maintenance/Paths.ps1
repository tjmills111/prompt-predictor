function Read-PrototypePaths {
    $record=Join-Path $env:LOCALAPPDATA 'GreyPredictionComposer\installation.json'
    $paths=Get-Content -LiteralPath $record -Raw | ConvertFrom-Json
    if($paths.owner -ne 'prompt-predictor-prototype-v1'){throw 'No owned prototype installation record'}
    if($paths.removed){throw 'Prototype is removed; files/data were retained'}
    return $paths
}
