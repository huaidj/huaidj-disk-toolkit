# SPDX-License-Identifier: GPL-3.0-or-later
[CmdletBinding()]
param([string]$SourceRoot, [string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $SourceRoot) {
    $packaged = Join-Path $projectRoot 'sources\rufus'
    $SourceRoot = if (Test-Path -LiteralPath $packaged) { $packaged } else { Join-Path $projectRoot 'vendor\rufus' }
}
$SourceRoot = (Resolve-Path -LiteralPath $SourceRoot).Path
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot 'dist\native-option-tests' }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$outputVolume = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($OutputDirectory))
if (-not $outputVolume.IsReady -or $outputVolume.AvailableFreeSpace -lt 128MB) { throw 'The actual test-output volume is unavailable or has insufficient space.' }
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$msbuild = (Get-Command MSBuild.exe -ErrorAction SilentlyContinue).Source
if (-not $msbuild -and (Test-Path -LiteralPath $vswhere)) { $msbuild = & $vswhere -latest -products '*' -requires Microsoft.Component.MSBuild -find 'MSBuild\**\Bin\MSBuild.exe' | Select-Object -First 1 }
if (-not $msbuild) { throw 'MSBuild with MSVC v143 is required for the offline native parser tests.' }
$temporary = Join-Path $OutputDirectory '.temp'
New-Item -ItemType Directory -Path $OutputDirectory,$temporary -Force | Out-Null
$priorTemp = $env:TEMP
$priorTmp = $env:TMP
try {
    $env:TEMP = $temporary
    $env:TMP = $temporary
    $out = $OutputDirectory.TrimEnd('\', '/') + '\'
    $obj = Join-Path $OutputDirectory 'obj\'
    & $msbuild (Join-Path $SourceRoot '.vs\huaidj-options-test.vcxproj') '/m' '/p:Configuration=Release' '/p:Platform=x64' '/p:PlatformToolset=v143' "/p:OutDir=$out" "/p:IntDir=$obj" '/nologo' '/v:quiet'
    if ($LASTEXITCODE -ne 0) { throw 'Offline native parser test compilation failed.' }
    # This standalone AsInvoker executable links only the pure option module
    # and its tests. It contains no Rufus UI, storage or erase implementation.
    & (Join-Path $OutputDirectory 'huaidj-options-test.exe')
    if ($LASTEXITCODE -ne 0) { throw 'Offline native parser contract tests failed.' }
} finally {
    $env:TEMP = $priorTemp
    $env:TMP = $priorTmp
}
