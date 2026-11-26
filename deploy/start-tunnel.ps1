[CmdletBinding()]
param([string]$Name = 'codex-remote-mcp', [switch]$Configure)
$ErrorActionPreference = 'Stop'
$data = Join-Path $env:LOCALAPPDATA 'codex-remote-mcp'
$config = Join-Path $data 'cloudflared.yml'
$cf = Join-Path $data 'bin/cloudflared.exe'
if (-not (Test-Path -LiteralPath $cf -PathType Leaf)) { $cf = (Get-Command cloudflared.exe).Source }

# An explicit tunnel name retains the original provisioning command.
if ($Configure -or $PSBoundParameters.ContainsKey('Name')) {
    $settingsJson = & node.exe (Join-Path $PSScriptRoot 'tunnel-settings.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Check the bridge build, PUBLIC_BASE_URL and PORT before starting the tunnel.' }
    $settings = $settingsJson | ConvertFrom-Json
    $credentials = Join-Path $env:USERPROFILE '.cloudflared'
    New-Item -ItemType Directory -Path $data -Force | Out-Null
    $rows = & $cf tunnel list --output json
    if ($LASTEXITCODE -ne 0) { throw "Run cloudflared tunnel login as the desktop user and select the zone for $($settings.hostname)." }
    $t = @(($rows | ConvertFrom-Json) | Where-Object { $_.name -eq $Name })
    if (-not $t) {
        & $cf tunnel create $Name
        if ($LASTEXITCODE -ne 0) { throw 'Tunnel creation failed.' }
        $rows = & $cf tunnel list --output json
        if ($LASTEXITCODE -ne 0) { throw 'Tunnel lookup failed.' }
        $t = @(($rows | ConvertFrom-Json) | Where-Object { $_.name -eq $Name })
    }
    if ($t.Count -ne 1) { throw 'Expected exactly one matching tunnel.' }
    $id = [guid]::Parse($t[0].id).ToString()
    $cred = Join-Path $credentials ($id + '.json')
    if (-not (Test-Path -LiteralPath $cred)) { throw "Missing credentials for tunnel $id." }
    $template = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'cloudflared-config.example.yml') -Raw
    $bridgeOrigin = "http://127.0.0.1:$($settings.bridge)"
    $candidate = Join-Path $data ([guid]::NewGuid().ToString() + ".yml")
    try {
        [IO.File]::WriteAllText($candidate,$template.Replace('TUNNEL_UUID',$id).Replace('TUNNEL_HOSTNAME',$settings.hostname).Replace('http://127.0.0.1:9088',$bridgeOrigin).Replace('TUNNEL_CREDENTIALS_PATH',$cred.Replace("'","''")))
        & $cf tunnel --config $candidate ingress validate
        if ($LASTEXITCODE -ne 0) { throw 'Ingress validation failed.' }
        & $cf tunnel route dns $id $settings.hostname
        if ($LASTEXITCODE -ne 0) { throw 'DNS route failed. Inspect the existing host record before changing it.' }
        Move-Item -LiteralPath $candidate -Destination $config -Force
    } finally {
        if (Test-Path -LiteralPath $candidate) { Remove-Item -LiteralPath $candidate }
    }
    if ($Configure) {
        "Configured tunnel $Name. Run start-tunnel.ps1 without arguments to start it."
        return
    }
}
if (-not (Test-Path -LiteralPath $config -PathType Leaf)) {
    throw 'Run start-tunnel.ps1 -Configure to provision the named tunnel first.'
}
$process = Start-Process -FilePath $cf -ArgumentList ('tunnel --config "'+$config+'" run') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $data 'tunnel-out.log') -RedirectStandardError (Join-Path $data 'tunnel.log')
Start-Sleep -Milliseconds 1000
if ($process.HasExited) { throw "Tunnel exited. See $data\tunnel.log" }
"Started tunnel from $config, PID $($process.Id)."
