[CmdletBinding()]
param([string]$Name = 'codex-remote-mcp')
$ErrorActionPreference = 'Stop'
$settingsJson = & node.exe (Join-Path $PSScriptRoot 'tunnel-settings.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Check the bridge build, PUBLIC_BASE_URL and PORT before starting the tunnel.' }
$settings = $settingsJson | ConvertFrom-Json
$cf = (Get-Command cloudflared.exe).Source
$data = Join-Path $env:LOCALAPPDATA 'codex-remote-mcp'
$credentials = Join-Path $env:USERPROFILE '.cloudflared'
New-Item -ItemType Directory -Path $data -Force | Out-Null
$rows = & $cf tunnel list --output json
if ($LASTEXITCODE -ne 0) { throw "Run cloudflared tunnel login as the desktop user and select the zone for $($settings.hostname)." }
$t = @($rows | ConvertFrom-Json | Where-Object { $_.name -eq $Name })
if (-not $t) {
    & $cf tunnel create $Name
    if ($LASTEXITCODE -ne 0) { throw 'Tunnel creation failed.' }
    $rows = & $cf tunnel list --output json
    if ($LASTEXITCODE -ne 0) { throw 'Tunnel lookup failed.' }
    $t = @($rows | ConvertFrom-Json | Where-Object { $_.name -eq $Name })
}
if ($t.Count -ne 1) { throw 'Expected exactly one matching tunnel.' }
$id = [guid]::Parse($t[0].id).ToString()
$cred = Join-Path $credentials ($id + '.json')
if (-not (Test-Path -LiteralPath $cred)) { throw "Missing credentials for tunnel $id." }
$config = Join-Path $data 'cloudflared.yml'
$template = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'cloudflared-config.example.yml') -Raw
[IO.File]::WriteAllText($config,$template.Replace('TUNNEL_UUID',$id).Replace('TUNNEL_HOSTNAME',$settings.hostname).Replace('BRIDGE_PORT',[string]$settings.bridge).Replace('TUNNEL_CREDENTIALS_PATH',$cred.Replace("'","''")))
& $cf tunnel --config $config ingress validate
if ($LASTEXITCODE -ne 0) { throw 'Ingress validation failed.' }
& $cf tunnel route dns $id $settings.hostname
if ($LASTEXITCODE -ne 0) { throw 'DNS route failed. Inspect the existing host record before changing it.' }
$process = Start-Process -FilePath $cf -ArgumentList ('tunnel --config "'+$config+'" run '+$id) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $data 'tunnel-out.log') -RedirectStandardError (Join-Path $data 'tunnel.log')
Start-Sleep -Milliseconds 1000
if ($process.HasExited) { throw "Tunnel exited. See $data\tunnel.log" }
"Started named tunnel $Name, PID $($process.Id)."

