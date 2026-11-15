[CmdletBinding()]
param([switch]$SelfContained, [string]$OutputRoot)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $OutputRoot) { $OutputRoot = Join-Path $projectRoot 'work\desktop-build' }
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
New-Item -ItemType Directory -Path $OutputRoot -Force | Out-Null
if (-not $env:NUGET_PACKAGES) { $env:NUGET_PACKAGES = Join-Path $OutputRoot 'nuget-cache' }
if (-not $env:DOTNET_CLI_HOME) { $env:DOTNET_CLI_HOME = Join-Path $OutputRoot 'dotnet-cli-home' }
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_GENERATE_ASPNET_CERTIFICATE = 'false'
$env:DOTNET_NOLOGO = '1'
$project = Join-Path $PSScriptRoot 'HuaiDJ.DiskToolkit.Desktop.csproj'
$artifacts = Join-Path $OutputRoot 'artifacts'
$output = Join-Path $OutputRoot $(if ($SelfContained) { 'self-contained' } else { 'framework-dependent' })
$arguments = @('publish', $project, '-c', 'Release', '--artifacts-path', $artifacts, '--output', $output, '-p:NuGetAudit=false')
if ($SelfContained) { $arguments += @('-r', 'win-x64', '--self-contained', 'true') }
else { $arguments += @('--self-contained', 'false') }
& dotnet @arguments
if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed.' }
$executable = Join-Path $output 'HuaiDJ.DiskToolkit.exe'
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'Desktop executable was not produced.' }
[ordered]@{ status = 'built'; platform = 'windows-x64'; selfContained = [bool]$SelfContained; executable = $executable; executableSHA256 = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant(); renderedGuiAcceptance = 'NOT_RUN'; generatedUTC = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputRoot 'desktop-build-receipt.json') -Encoding utf8NoBOM
