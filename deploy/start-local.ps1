[CmdletBinding()]
param([switch]$Foreground)
$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
$runtime = Join-Path $env:LOCALAPPDATA 'codex-remote-mcp'
if ([Security.Principal.WindowsIdentity]::GetCurrent().IsSystem) { throw 'Use the signed-in Windows desktop account.' }
if (-not $env:CODEX_HOME) { $env:CODEX_HOME = Join-Path $env:USERPROFILE '.codex' }
if (-not $env:CODEX_EXE) {
    $shim = Get-Command codex.ps1 -ErrorAction SilentlyContinue
    if ($shim) {
        $package = Join-Path (Split-Path $shim.Source) 'node_modules\@openai\codex'
        $binary = Get-ChildItem -LiteralPath $package -File -Recurse -Filter codex.exe -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($binary) { $env:CODEX_EXE = $binary.FullName }
    }
    if (-not $env:CODEX_EXE) { throw 'Set CODEX_EXE to the standalone CLI installation.' }
}
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
$passwordFile = Join-Path $runtime 'owner-password.txt'
if (-not (Test-Path -LiteralPath $passwordFile)) {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $stream = [IO.File]::Open($passwordFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {
        $secretBytes = [Text.Encoding]::ASCII.GetBytes([Convert]::ToBase64String($bytes))
        $stream.Write($secretBytes,0,$secretBytes.Length)
    } finally { $stream.Dispose() }
}
$entry = Join-Path $project 'dist\index.js'
if (-not (Test-Path -LiteralPath $entry)) { throw 'Build the project before starting it.' }
$node = (Get-Command node.exe).Source
if ($Foreground) { & $node $entry; exit $LASTEXITCODE }
$process = Start-Process -FilePath $node -ArgumentList ('"' + $entry + '"') -WorkingDirectory $project -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtime 'service.log') -RedirectStandardError (Join-Path $runtime 'service-error.log')
Start-Sleep -Milliseconds 800
if ($process.HasExited) { throw "Service exited. See $runtime\service-error.log" }
"Started local bridge PID $($process.Id). Logs and authorization password are in $runtime"

