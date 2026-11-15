# SPDX-License-Identifier: GPL-3.0-or-later
[CmdletBinding()]
param(
    [string]$SourceRoot,
    [string]$OutputDirectory,
    [ValidateSet('v143')][string]$PlatformToolset = 'v143',
    [ValidateSet('x64')][string]$Platform = 'x64',
    [string]$MSBuildPath,
    [switch]$Rebuild
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $SourceRoot) {
    $packaged = Join-Path $projectRoot 'sources\rufus'
    $checkout = Join-Path $projectRoot 'vendor\rufus'
    $SourceRoot = if (Test-Path -LiteralPath $packaged) { $packaged } else { $checkout }
}
$SourceRoot = (Resolve-Path -LiteralPath $SourceRoot).Path
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot 'dist\native' }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$solution = Join-Path $SourceRoot 'rufus.sln'
if (-not (Test-Path -LiteralPath $solution -PathType Leaf)) { throw 'Rufus source solution not found.' }
if (-not $MSBuildPath) {
    $available = Get-Command MSBuild.exe -ErrorAction SilentlyContinue
    if ($available) { $MSBuildPath = $available.Source }
}
if (-not $MSBuildPath) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path -LiteralPath $vswhere) {
        $MSBuildPath = & $vswhere -latest -products '*' -requires Microsoft.Component.MSBuild -find 'MSBuild\**\Bin\MSBuild.exe' | Select-Object -First 1
    }
}
if (-not $MSBuildPath -or -not (Test-Path -LiteralPath $MSBuildPath -PathType Leaf)) { throw 'MSBuild was not found. Install Visual Studio Build Tools with C++ v143 and a Windows SDK.' }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$outputVolume = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($OutputDirectory))
if (-not $outputVolume.IsReady -or $outputVolume.AvailableFreeSpace -lt 512MB) { throw 'The actual output volume is unavailable or has less than 512 MiB free.' }
$buildTemp = Join-Path $OutputDirectory '.temp'
New-Item -ItemType Directory -Path $buildTemp -Force | Out-Null
$previousTemp = $env:TEMP
$previousTmp = $env:TMP
$previousCompilerOptions = $env:_CL_
$previousLinkerOptions = $env:LINK
$env:TEMP = $buildTemp
$env:TMP = $buildTemp
$mappingOption = [string]::Concat('/pathmap:"', $SourceRoot, '=."')
$env:_CL_ = (($previousCompilerOptions, '/utf-8', '/experimental:deterministic', $mappingOption) -join ' ').Trim()
$env:LINK = (($previousLinkerOptions, '/PDBALTPATH:%_PDB%') -join ' ').Trim()
$trailingOutput = $OutputDirectory.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
$log = Join-Path $OutputDirectory 'build.log'
$buildArguments = @(
    'rufus.sln', '/m', '/p:Configuration=Release', "/p:Platform=$Platform",
    "/p:PlatformToolset=$PlatformToolset", "/p:OutDir=$trailingOutput",
    '/fl', "/flp:logfile=$log;verbosity=normal", '/nologo', '/v:quiet'
)
if ($Rebuild) { $buildArguments += '/t:Rebuild' }
Push-Location -LiteralPath $SourceRoot
try {
    & $MSBuildPath @buildArguments
    if ($LASTEXITCODE -ne 0) { throw "Native build failed (exit $LASTEXITCODE). See the build log." }
} finally {
    Pop-Location
    $env:TEMP = $previousTemp
    $env:TMP = $previousTmp
    $env:_CL_ = $previousCompilerOptions
    $env:LINK = $previousLinkerOptions
}
$binary = Join-Path $OutputDirectory 'rufus.exe'
if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw 'MSBuild completed without the expected rufus.exe output.' }
[ordered]@{
    Status = 'built-not-hardware-tested'
    Binary = $binary
    SHA256 = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant()
    Platform = $Platform
    Toolset = $PlatformToolset
    BuildLog = $log
} | ConvertTo-Json
