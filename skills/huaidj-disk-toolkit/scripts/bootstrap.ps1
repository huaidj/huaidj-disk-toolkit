# HuaiDJ Disk Toolkit fixed-release installer. GPL-3.0-or-later.
# Windows PowerShell 5.1 entry point. No elevation, system PATH changes or ISO downloads.
[CmdletBinding()]
param(
    [string]$InstallRoot,
    [ValidateSet('Skill','Mcp')][string]$Flavor = 'Mcp',
    [ValidateSet('codex','claude-code','claude-desktop','gemini','opencode','vscode')][string]$Client,
    [string]$SkillTarget,
    [switch]$RuntimeOnly,
    [switch]$Apply
)

$script:HuaiDJInstallerVersion = '0.1.0'
$script:HuaiDJInstallerTag = 'v0.1.0'
$script:HuaiDJInstallerRepository = 'yutianyu111602-glitch/huaidj-disk-toolkit'

function Stop-HuaiDJInstall([string]$Code, [string]$Message) { throw "[$Code] $Message" }
function Get-HuaiDJField($Object, [string]$Name, $Default = $null) {
    if ($null -eq $Object) { return $Default }
    if ($Object -is [Collections.IDictionary]) { if (@($Object.Keys) -contains $Name) { return $Object[$Name] }; return $Default }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -ne $property) { return $property.Value }
    return $Default
}
function Test-HuaiDJVersion([string]$Actual, [string]$Minimum) {
    if ($Actual -notmatch '^v?(\d+)\.(\d+)\.(\d+)$') { return $false }
    return ([version]$Actual.TrimStart('v') -ge [version]$Minimum)
}
function ConvertFrom-HuaiDJBytes([byte[]]$Bytes) {
    $stream = New-Object IO.MemoryStream(,$Bytes)
    $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8, $true)
    try { return $reader.ReadToEnd() } finally { $reader.Dispose(); $stream.Dispose() }
}
function Get-HuaiDJHttpBytes([string]$Url) {
    $uri = [uri]$Url
    if ($uri.Scheme -cne 'https') { Stop-HuaiDJInstall 'HTTPS_REQUIRED' 'Only fixed HTTPS download sources are accepted.' }
    $oldProtocol = [Net.ServicePointManager]::SecurityProtocol
    try {
        [Net.ServicePointManager]::SecurityProtocol = $oldProtocol -bor [Net.SecurityProtocolType]::Tls12
        $request = [Net.HttpWebRequest]::Create($uri)
        $request.UserAgent = 'HuaiDJ-Disk-Toolkit/0.1.0'
        $request.Timeout = 30000; $request.ReadWriteTimeout = 30000
        $response = $request.GetResponse()
        try {
            $inputStream = $response.GetResponseStream(); $memory = New-Object IO.MemoryStream
            try { $inputStream.CopyTo($memory); return ,$memory.ToArray() }
            finally { $memory.Dispose(); $inputStream.Dispose() }
        } finally { $response.Dispose() }
    } finally { [Net.ServicePointManager]::SecurityProtocol = $oldProtocol }
}
function Save-HuaiDJDownload([string]$Url, [string]$Destination) {
    $uri = [uri]$Url
    if ($uri.Scheme -cne 'https') { Stop-HuaiDJInstall 'HTTPS_REQUIRED' 'Only fixed HTTPS download sources are accepted.' }
    $oldProtocol = [Net.ServicePointManager]::SecurityProtocol
    try {
        [Net.ServicePointManager]::SecurityProtocol = $oldProtocol -bor [Net.SecurityProtocolType]::Tls12
        $request = [Net.HttpWebRequest]::Create($uri)
        $request.UserAgent = 'HuaiDJ-Disk-Toolkit/0.1.0'; $request.Timeout = 30000; $request.ReadWriteTimeout = 30000
        $response = $request.GetResponse()
        try {
            $inputStream = $response.GetResponseStream()
            $outputStream = New-Object IO.FileStream($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try { $inputStream.CopyTo($outputStream); $outputStream.Flush() }
            finally { $outputStream.Dispose(); $inputStream.Dispose() }
        } finally { $response.Dispose() }
    } finally { [Net.ServicePointManager]::SecurityProtocol = $oldProtocol }
}
function Assert-HuaiDJNoReparse([string]$FullPath) {
    $full = [IO.Path]::GetFullPath($FullPath)
    $drive = [IO.Path]::GetPathRoot($full)
    if ($full.StartsWith('\\') -or $drive -notmatch '^[a-zA-Z]:\\$') { Stop-HuaiDJInstall 'LOCAL_INSTALL_ROOT_REQUIRED' 'Use a local Windows drive path.' }
    $current = $drive
    foreach ($part in $full.Substring($drive.Length).Split([char]'\')) {
        if (-not $part) { continue }; $current = Join-Path $current $part
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-HuaiDJInstall 'LINKED_INSTALL_ROOT' 'Choose an ordinary install path without junctions or symbolic links.' }
        }
    }
    return $full
}
function Resolve-HuaiDJInstallRoot([string]$Requested) {
    if (-not $Requested) {
        if ($env:HUAIDJ_TOOLKIT_HOME) { $Requested = $env:HUAIDJ_TOOLKIT_HOME }
        elseif ($env:LOCALAPPDATA) { $Requested = Join-Path $env:LOCALAPPDATA 'HuaiDJ\DiskToolkit' }
        else { Stop-HuaiDJInstall 'INSTALL_ROOT_REQUIRED' 'LOCALAPPDATA is unavailable. Supply an ordinary writable InstallRoot.' }
    }
    if (-not [IO.Path]::IsPathRooted($Requested)) { Stop-HuaiDJInstall 'LOCAL_INSTALL_ROOT_REQUIRED' 'InstallRoot must be an absolute local directory.' }
    $full = Assert-HuaiDJNoReparse $Requested
    if ($full.TrimEnd('\') -eq ([IO.Path]::GetPathRoot($full)).TrimEnd('\') -or $full.Length -gt 140) { Stop-HuaiDJInstall 'INSTALL_ROOT_TOO_BROAD' 'Choose a short application subdirectory, not a drive root.' }
    foreach ($protected in @($env:WINDIR, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if ($protected -and ($full.Equals($protected, [StringComparison]::OrdinalIgnoreCase) -or $full.StartsWith($protected.TrimEnd('\')+'\', [StringComparison]::OrdinalIgnoreCase))) { Stop-HuaiDJInstall 'PER_USER_INSTALL_REQUIRED' 'Choose a writable per-user or data-drive application directory.' }
    }
    return $full
}
function Get-HuaiDJSHA256([string]$File) {
    $stream=[IO.File]::OpenRead($File); $algorithm=[Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-','').ToLowerInvariant() }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}
function Assert-HuaiDJHash([string]$File, [string]$Expected) {
    if ($Expected -notmatch '^[a-fA-F0-9]{64}$' -or (Get-HuaiDJSHA256 $File) -ine $Expected) { Stop-HuaiDJInstall 'CHECKSUM_MISMATCH' 'The downloaded file does not match the fixed release digest. It was not executed or extracted.' }
}
function Assert-HuaiDJChecksumText([string]$Text, [string]$File, [string]$Expected) {
    $matchesFound = @()
    foreach ($line in ($Text -split '\r?\n')) {
        if ($line.TrimStart([char]0xFEFF) -match '^([a-fA-F0-9]{64})\s+\*?(.+?)\s*$') {
            if ($Matches[2] -ceq $File) { $matchesFound += $Matches[1].ToLowerInvariant() }
        }
    }
    if ($matchesFound.Count -ne 1 -or $matchesFound[0] -cne $Expected.ToLowerInvariant()) { Stop-HuaiDJInstall 'OFFICIAL_DIGEST_MISMATCH' 'The official checksum list does not match the dependency pin.' }
}
function Expand-HuaiDJCheckedZip([string]$Archive, [string]$Destination) {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if (Test-Path -LiteralPath $Destination) { Stop-HuaiDJInstall 'STAGING_ALREADY_EXISTS' 'Extraction requires a new private staging directory.' }
    $null = [IO.Directory]::CreateDirectory($Destination)
    $base = (Assert-HuaiDJNoReparse $Destination).TrimEnd('\')+'\'
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        $seen = @{}; [long]$total = 0
        if ($zip.Entries.Count -gt 100000) { Stop-HuaiDJInstall 'ARCHIVE_LIMIT' 'The archive has too many entries.' }
        foreach ($entry in $zip.Entries) {
            $rel = $entry.FullName.Replace('\','/'); $parts = @($rel.TrimEnd('/').Split('/'))
            if (-not $rel -or $rel.StartsWith('/') -or $rel.Contains(':') -or $rel -match '[\x00-\x1f]' -or @($parts | Where-Object { -not $_ -or $_ -eq '.' -or $_ -eq '..' -or $_ -match '[. ]$' -or $_ -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)' }).Count -gt 0) { Stop-HuaiDJInstall 'UNSAFE_ARCHIVE_PATH' 'The archive contains an unsafe path.' }
            $key = $rel.TrimEnd('/').ToLowerInvariant()
            if ($seen.ContainsKey($key)) { Stop-HuaiDJInstall 'DUPLICATE_ARCHIVE_PATH' 'Archive paths collide or repeat.' }; $seen[$key] = $true
            [long]$attrs = [long]$entry.ExternalAttributes -band 4294967295L
            $kind = ($attrs -shr 16) -band 61440
            if ($kind -ne 0 -and $kind -ne 32768 -and $kind -ne 16384) { Stop-HuaiDJInstall 'ARCHIVE_LINK_FORBIDDEN' 'Archive links and special nodes are not supported.' }
            if (($attrs -band 1024) -ne 0) { Stop-HuaiDJInstall 'ARCHIVE_LINK_FORBIDDEN' 'Archive reparse points are not supported.' }
            $total += $entry.Length
            if ($total -gt 1610612736L) { Stop-HuaiDJInstall 'ARCHIVE_LIMIT' 'The expanded archive exceeds the bounded size limit.' }
            $target = [IO.Path]::GetFullPath((Join-Path $Destination ($rel.Replace('/','\'))))
            if (-not $target.StartsWith($base, [StringComparison]::OrdinalIgnoreCase) -or $target.Length -gt 250) { Stop-HuaiDJInstall 'UNSAFE_ARCHIVE_PATH' 'An archive path escapes staging or exceeds this PowerShell entry point limit.' }
        }
        foreach ($entry in $zip.Entries) {
            $rel = $entry.FullName.Replace('/','\'); $target = Join-Path $Destination $rel
            if ($entry.FullName.EndsWith('/') -or $entry.FullName.EndsWith('\')) { $null = [IO.Directory]::CreateDirectory($target); continue }
            $parent = [IO.Path]::GetDirectoryName($target); $null = [IO.Directory]::CreateDirectory($parent); $null = Assert-HuaiDJNoReparse $parent
            $inputStream = $entry.Open(); $outputStream = New-Object IO.FileStream($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose(); $inputStream.Dispose() }
        }
    } finally { $zip.Dispose() }
}
function ConvertTo-HuaiDJArgument([string]$Value) {
    if ($Value -ne '' -and $Value -notmatch '[\s"]') { return $Value }
    $builder = New-Object Text.StringBuilder; $null = $builder.Append('"'); $slashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq [char]'\') { $slashes++; continue }
        if ($character -eq [char]'"') { $null = $builder.Append(('\' * (2*$slashes+1))); $null = $builder.Append('"') }
        else { if ($slashes) { $null = $builder.Append(('\' * $slashes)) }; $null = $builder.Append($character) }
        $slashes = 0
    }
    if ($slashes) { $null = $builder.Append(('\' * (2*$slashes))) }; $null = $builder.Append('"'); return $builder.ToString()
}
function Invoke-HuaiDJCommand([string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory, [switch]$NpmIsolated) {
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $FilePath; $start.Arguments = (($Arguments | ForEach-Object { ConvertTo-HuaiDJArgument $_ }) -join ' ')
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    if ($WorkingDirectory) { $start.WorkingDirectory = $WorkingDirectory }
    if ($NpmIsolated) {
        foreach ($name in @($start.EnvironmentVariables.Keys)) { if ($name -match '^(?i:NPM_CONFIG_|NPM_TOKEN$|NODE_AUTH_TOKEN$|GITHUB_TOKEN$|GH_TOKEN$)') { $start.EnvironmentVariables.Remove($name) } }
    }
    $process = New-Object Diagnostics.Process; $process.StartInfo = $start
    $null = $process.Start(); $stdoutTask = $process.StandardOutput.ReadToEndAsync(); $stderrTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(600000)) { try { $process.Kill(); $null=$process.WaitForExit(10000) } catch {}; $process.Dispose(); Stop-HuaiDJInstall 'COMMAND_TIMEOUT' 'The owned setup command timed out and was stopped; retained setup evidence requires review.' }
    $stdout = $stdoutTask.Result; $stderr = $stderrTask.Result
    $exitCode=$process.ExitCode; $process.Dispose()
    if ($exitCode -ne 0) {
        $reason=''; try { $refusal=$stdout|ConvertFrom-Json; $reason=[string](Get-HuaiDJField $refusal 'code' (Get-HuaiDJField $refusal 'error' '')) } catch {}
        if ($reason -cmatch '^[A-Z][A-Z0-9_]+$') { Stop-HuaiDJInstall 'SETUP_COMMAND_FAILED' ('Generic setup or dependency preparation refused this operation ('+$reason+'). Existing runtime and agent entries were preserved.') }
        Stop-HuaiDJInstall 'SETUP_COMMAND_FAILED' 'A dependency or generic setup command failed. No existing runtime or agent entry was overwritten.'
    }
    return [pscustomobject]@{ exitCode = $exitCode; stdout = $stdout; stderr = $stderr }
}
function Find-HuaiDJRuntimes {
    $nodeResult = $null; $psResult = $null
    $nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($nodeCommand) {
        try {
            $version = (& $nodeCommand.Source --version 2>$null | Out-String).Trim()
            $npmJs = Join-Path ([IO.Path]::GetDirectoryName($nodeCommand.Source)) 'node_modules\npm\bin\npm-cli.js'
            if ((Test-HuaiDJVersion $version '22.15.0') -and (Test-Path -LiteralPath $npmJs -PathType Leaf)) { $nodeResult = @{ path=$nodeCommand.Source; npmPath=$npmJs; version=$version.TrimStart('v'); existing=$true } }
        } catch { $nodeResult = $null }
    }
    $psCommand = Get-Command pwsh.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($psCommand) {
        try { $version = (& $psCommand.Source -NoProfile -NonInteractive -Command '$PSVersionTable.PSVersion.ToString()' 2>$null | Out-String).Trim(); if (Test-HuaiDJVersion $version '7.0.0') { $psResult = @{path=$psCommand.Source;version=$version;existing=$true} } } catch { $psResult=$null }
    }
    return @{ node=$nodeResult; powershell=$psResult }
}
function Assert-HuaiDJManifest($Manifest) {
    if ((Get-HuaiDJField $Manifest 'schemaVersion') -ne 1 -or (Get-HuaiDJField $Manifest 'version') -cne $script:HuaiDJInstallerVersion -or (Get-HuaiDJField $Manifest 'tag') -cne $script:HuaiDJInstallerTag -or (Get-HuaiDJField $Manifest 'repository') -cne $script:HuaiDJInstallerRepository) { Stop-HuaiDJInstall 'INVALID_RELEASE_MANIFEST' 'The manifest does not describe this fixed installer release.' }
    $prefix = 'https://github.com/'+$script:HuaiDJInstallerRepository+'/releases/download/'+$script:HuaiDJInstallerTag+'/'
    foreach ($asset in @(Get-HuaiDJField $Manifest 'assets')) {
        $file = [string](Get-HuaiDJField $asset 'file')
        if ($file -notmatch '^[a-zA-Z0-9._-]+$' -or (Get-HuaiDJField $asset 'url') -cne ($prefix+$file) -or (Get-HuaiDJField $asset 'sha256') -notmatch '^[a-fA-F0-9]{64}$') { Stop-HuaiDJInstall 'INVALID_RELEASE_ASSET' 'Release assets must use the fixed repository, tag, filename and SHA-256.' }
    }
    $windows = @((Get-HuaiDJField $Manifest 'assets') | Where-Object { (Get-HuaiDJField $_ 'name') -ceq 'windows-x64' })
    if ($windows.Count -ne 1 -or (Get-HuaiDJField $windows[0] 'file') -cne 'huaidj-disk-toolkit-v0.1.0-windows-x64.zip' -or (Get-HuaiDJField $windows[0] 'archiveRoot') -cne '.') { Stop-HuaiDJInstall 'WINDOWS_PACKAGE_REQUIRED' 'This installer requires the fixed flat Windows x64 toolkit asset.' }
    foreach ($kind in @('node','powershell')) {
        $dep = Get-HuaiDJField (Get-HuaiDJField $Manifest 'dependencies') $kind
        $version = [string](Get-HuaiDJField $dep 'version'); $platform = Get-HuaiDJField (Get-HuaiDJField $dep 'platforms') 'windows-x64'
        if ($version -notmatch '^\d+\.\d+\.\d+$' -or (Get-HuaiDJField $platform 'sha256') -notmatch '^[a-fA-F0-9]{64}$') { Stop-HuaiDJInstall 'INVALID_DEPENDENCY_PIN' 'Portable dependencies require a fixed version and digest.' }
        if (($kind -eq 'node' -and -not (Test-HuaiDJVersion $version '22.15.0')) -or ($kind -eq 'powershell' -and -not (Test-HuaiDJVersion $version '7.0.0'))) { Stop-HuaiDJInstall 'DEPENDENCY_TOO_OLD' 'The pinned dependency does not satisfy the toolkit runtime requirement.' }
        if ($kind -eq 'node') { $expectedFile='node-v'+$version+'-win-x64.zip'; $base='https://nodejs.org/dist/v'+$version+'/'; $expectedRoot='node-v'+$version+'-win-x64'; $entry='node.exe'; $checksums=$base+'SHASUMS256.txt' }
        else { $expectedFile='PowerShell-'+$version+'-win-x64.zip'; $base='https://github.com/PowerShell/PowerShell/releases/download/v'+$version+'/'; $expectedRoot='.'; $entry='pwsh.exe'; $checksums=$base+'hashes.sha256' }
        if ((Get-HuaiDJField $platform 'file') -cne $expectedFile -or (Get-HuaiDJField $platform 'url') -cne ($base+$expectedFile) -or (Get-HuaiDJField $platform 'checksumsUrl') -cne $checksums -or (Get-HuaiDJField $platform 'archiveRoot') -cne $expectedRoot -or (Get-HuaiDJField $platform 'entry') -cne $entry) { Stop-HuaiDJInstall 'UNTRUSTED_DEPENDENCY_SOURCE' 'Portable dependency pins must refer to the official fixed Node.js or PowerShell release.' }
    }
    return $windows[0]
}
function Assert-HuaiDJPackage([string]$AppRoot) {
    foreach ($required in @('package.json','package-lock.json','config.example.json','src\cli.mjs','src\setup.mjs','src\windows-backend.ps1','bin\rufus-huaidj.exe','skills\huaidj-disk-toolkit\SKILL.md','sources\rufus\src\rufus.c','sources\rufus\src\huaidj_autopilot.c','sources\native-source-manifest.json','patches\native-adapter.patch','LICENSE')) { if (-not (Test-Path -LiteralPath (Join-Path $AppRoot $required) -PathType Leaf)) { Stop-HuaiDJInstall 'INCOMPLETE_TOOLKIT_PACKAGE' 'The verified archive does not contain the required toolkit and corresponding-source files.' } }
    if (Test-Path -LiteralPath (Join-Path $AppRoot 'config.json')) { Stop-HuaiDJInstall 'PRIVATE_CONFIG_IN_PACKAGE' 'A release package must not contain a private local config.json.' }
    $sourceManifestFile=Join-Path $AppRoot 'sources\native-source-manifest.json'
    if ((Get-Item -LiteralPath $sourceManifestFile).Length -gt 33554432) { Stop-HuaiDJInstall 'INVALID_NATIVE_SOURCE_MANIFEST' 'The corresponding-source manifest exceeds the bounded size limit.' }
    try { $nativeSource=Get-Content -LiteralPath $sourceManifestFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { Stop-HuaiDJInstall 'INVALID_NATIVE_SOURCE_MANIFEST' 'The corresponding-source manifest is not valid JSON.' }
    if ($nativeSource.sourceDirectory -cne 'sources/rufus' -or $nativeSource.upstreamRepository -cne 'https://github.com/pbatard/rufus.git' -or $nativeSource.upstreamCommit -notmatch '^[a-f0-9]{40}$' -or $nativeSource.nativeLicense -cne 'GPL-3.0-or-later' -or $nativeSource.sourceInventorySha256 -notmatch '^[a-f0-9]{64}$' -or $nativeSource.patch -cne 'patches/native-adapter.patch' -or $nativeSource.patchSha256 -notmatch '^[a-f0-9]{64}$' -or $nativeSource.binary.path -cne 'bin/rufus-huaidj.exe' -or $nativeSource.binary.sha256 -notmatch '^[a-f0-9]{64}$' -or $nativeSource.sourceFiles -isnot [array] -or $nativeSource.sourceFiles.Count -lt 2 -or $nativeSource.sourceFiles.Count -gt 10000) { Stop-HuaiDJInstall 'INVALID_NATIVE_SOURCE_MANIFEST' 'The package must bind its pinned upstream source, patch and native binary using the canonical source layout.' }
    $sourceSeen=New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($sourceEntry in $nativeSource.sourceFiles) {
        $relative=[string]$sourceEntry.path
        if (-not $relative -or $relative -match '[\\:\x00-\x1f]' -or $relative.StartsWith('/') -or @($relative.Split('/') | Where-Object { $_ -in @('','.','..','.git') }).Count -gt 0 -or -not $sourceSeen.Add($relative) -or $sourceEntry.sha256 -notmatch '^[a-f0-9]{64}$' -or [string]$sourceEntry.size -notmatch '^\d{1,19}$') { Stop-HuaiDJInstall 'INVALID_NATIVE_SOURCE_MANIFEST' 'The source inventory contains unsafe, duplicate or invalid file records.' }
        $sourceFile=Join-Path (Join-Path $AppRoot 'sources\rufus') $relative.Replace('/','\')
        if (-not (Test-Path -LiteralPath $sourceFile -PathType Leaf) -or (Get-Item -LiteralPath $sourceFile).Length.ToString() -cne [string]$sourceEntry.size) { Stop-HuaiDJInstall 'INCOMPLETE_TOOLKIT_PACKAGE' 'A recorded corresponding-source input is missing or has an incorrect size.' }
        Assert-HuaiDJHash $sourceFile $sourceEntry.sha256
    }
    foreach ($requiredSource in @('src/rufus.c','src/huaidj_autopilot.c')) { if (-not $sourceSeen.Contains($requiredSource)) { Stop-HuaiDJInstall 'INVALID_NATIVE_SOURCE_MANIFEST' 'The source inventory does not identify the required native engine and adapter.' } }
    Assert-HuaiDJHash (Join-Path $AppRoot 'patches\native-adapter.patch') $nativeSource.patchSha256
    Assert-HuaiDJHash (Join-Path $AppRoot 'bin\rufus-huaidj.exe') $nativeSource.binary.sha256
    $package = Get-Content -LiteralPath (Join-Path $AppRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($package.version -cne $script:HuaiDJInstallerVersion) { Stop-HuaiDJInstall 'PACKAGE_VERSION_MISMATCH' 'The package version does not match the installer release.' }
    $lockText=[IO.File]::ReadAllText((Join-Path $AppRoot 'package-lock.json'),[Text.Encoding]::UTF8)
    # npm lockfiles have an empty-string root key; PS5.1 ConvertFrom-Json cannot represent it as a PSObject.
    if ($PSVersionTable.PSVersion.Major -ge 6) { $lock=ConvertFrom-Json -InputObject $lockText -AsHashtable }
    else { Add-Type -AssemblyName System.Web.Extensions; $serializer=New-Object Web.Script.Serialization.JavaScriptSerializer; $serializer.MaxJsonLength=33554432; $serializer.RecursionLimit=256; $lock=$serializer.DeserializeObject($lockText) }
    if ((Get-HuaiDJField $lock 'lockfileVersion') -notin @(2,3)) { Stop-HuaiDJInstall 'LOCKFILE_REQUIRED' 'A supported npm lockfile is required.' }
    $packages=Get-HuaiDJField $lock 'packages'
    if ($packages -isnot [Collections.IDictionary]) { Stop-HuaiDJInstall 'LOCKFILE_REQUIRED' 'The npm lockfile must contain its package map.' }
    foreach ($lockedPackage in $packages.Values) {
        $resolved = Get-HuaiDJField $lockedPackage 'resolved'
        if ($resolved -and ($resolved -notmatch '^https://registry\.npmjs\.org/' -or (Get-HuaiDJField $lockedPackage 'integrity') -notmatch '^sha(256|384|512)-[A-Za-z0-9+/=]+$')) { Stop-HuaiDJInstall 'UNTRUSTED_NPM_LOCK' 'Locked dependencies must use the public npm registry with integrity digests.' }
    }
}
function Invoke-HuaiDJInstaller {
    # Manifest/DownloadProvider/RuntimeProbe/CommandRunner are trusted test helpers, not script parameters or MCP inputs.
    param([hashtable]$Options, $Manifest, [scriptblock]$DownloadProvider, [scriptblock]$TextProvider, [scriptblock]$RuntimeProbe, [scriptblock]$CommandRunner)
    $ErrorActionPreference = 'Stop'
    if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { Stop-HuaiDJInstall 'WINDOWS_X64_REQUIRED' 'The native package currently targets Windows x64. Use the query-only source bootstrap on other platforms.' }
    if (-not $Options) { $Options=@{} }
    $chosenRoot = Resolve-HuaiDJInstallRoot (Get-HuaiDJField $Options 'InstallRoot')
    $chosenFlavor = [string](Get-HuaiDJField $Options 'Flavor' 'Mcp'); $chosenClient = [string](Get-HuaiDJField $Options 'Client' '')
    if ($chosenFlavor -notin @('Skill','Mcp') -or ($chosenClient -and $chosenClient -notin @('codex','claude-code','claude-desktop','gemini','opencode','vscode'))) { Stop-HuaiDJInstall 'INVALID_INSTALL_SELECTION' 'Choose one supported flavor and, optionally, one explicit client.' }
    $doApply = [bool](Get-HuaiDJField $Options 'Apply' $false); $runtimeOnly = [bool](Get-HuaiDJField $Options 'RuntimeOnly' $false)
    if (-not $DownloadProvider) { $DownloadProvider={ param($Url,$Destination) Save-HuaiDJDownload $Url $Destination } }
    if (-not $TextProvider) { $TextProvider={ param($Url) ConvertFrom-HuaiDJBytes (Get-HuaiDJHttpBytes $Url) } }
    if (-not $RuntimeProbe) { $RuntimeProbe={ Find-HuaiDJRuntimes } }
    if (-not $CommandRunner) { $CommandRunner={ param($Exe,$Argv,$Cwd,$IsNpm) Invoke-HuaiDJCommand -FilePath $Exe -Arguments $Argv -WorkingDirectory $Cwd -NpmIsolated:$IsNpm } }
    $manifestUrl = 'https://github.com/'+$script:HuaiDJInstallerRepository+'/releases/download/'+$script:HuaiDJInstallerTag+'/release-manifest.json'
    if (-not $Manifest) { try { $Manifest = (& $TextProvider $manifestUrl) | ConvertFrom-Json } catch { Stop-HuaiDJInstall 'RELEASE_NOT_AVAILABLE' 'The fixed release manifest is unavailable. Publication/download verification is pending; no package has been installed.' } }
    $asset = Assert-HuaiDJManifest $Manifest
    $runtime = & $RuntimeProbe
    $versionRoot = Join-Path $chosenRoot 'versions\v0.1.0\windows-x64'; $appRoot = Join-Path $versionRoot 'app'; $receiptPath=Join-Path $versionRoot 'install-receipt.json'
    $plan = [ordered]@{ status='preview'; version=$script:HuaiDJInstallerVersion; tag=$script:HuaiDJInstallerTag; flavor=$chosenFlavor; client=$chosenClient; installRoot=$chosenRoot; asset=(Get-HuaiDJField $asset 'file'); packageSHA256=(Get-HuaiDJField $asset 'sha256'); runtimeOnly=$runtimeOnly; willDownloadNode=($null -eq (Get-HuaiDJField $runtime 'node')); willDownloadPowerShell=($null -eq (Get-HuaiDJField $runtime 'powershell')); configurationApplied=$false; systemPATHModified=$false; elevationRequested=$false; osImagesDownloaded=$false }
    if (-not $doApply) { return [pscustomobject]$plan }
    $null=Assert-HuaiDJNoReparse $chosenRoot; $null=[IO.Directory]::CreateDirectory($chosenRoot)
    try { $installGuard=New-Object IO.FileStream((Join-Path $chosenRoot '.install.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) }
    catch { Stop-HuaiDJInstall 'INSTALLER_BUSY' 'Another installer owns this install root. Existing files were not changed.' }
    try {
    $receipt=$null
    if (Test-Path -LiteralPath $versionRoot) {
        $null=Assert-HuaiDJNoReparse $versionRoot
        if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) { Stop-HuaiDJInstall 'INCOMPLETE_RUNTIME' 'The existing version directory has no complete receipt. It was preserved; inspect it or choose a new InstallRoot.' }
        $receipt=Get-Content -LiteralPath $receiptPath -Raw -Encoding UTF8|ConvertFrom-Json
        if ($receipt.schemaVersion -ne 1 -or $receipt.packageSHA256 -ine (Get-HuaiDJField $asset 'sha256') -or $receipt.status -cne 'complete') { Stop-HuaiDJInstall 'RUNTIME_CONFLICT' 'An existing runtime differs from this fixed release and was preserved.' }
        foreach ($required in @('package.json','package-lock.json','src\cli.mjs','src\setup.mjs','src\windows-backend.ps1','bin\rufus-huaidj.exe')) { if (@($receipt.criticalFiles | Where-Object { $_.path -ceq $required }).Count -ne 1) { Stop-HuaiDJInstall 'RUNTIME_RECEIPT_INCOMPLETE' 'The existing runtime receipt lacks required integrity records.' } }
        foreach ($entry in $receipt.criticalFiles) {
            $relative=[string]$entry.path
            if ($relative -notmatch '^(package(?:-lock)?\.json|bin\\rufus-huaidj\.exe|src\\[^:]+)$' -or @($relative.Split([char]'\') | Where-Object { $_ -eq '.' -or $_ -eq '..' }).Count -gt 0 -or $relative.Contains('/')) { Stop-HuaiDJInstall 'RUNTIME_RECEIPT_PATH' 'The runtime receipt contains an unsafe integrity path.' }
            $file=Join-Path $appRoot $relative; $null=Assert-HuaiDJNoReparse $file; Assert-HuaiDJHash $file $entry.sha256
        }
        if (-not (Test-Path -LiteralPath $receipt.nodePath -PathType Leaf) -or -not (Test-Path -LiteralPath $receipt.powershellPath -PathType Leaf)) { Stop-HuaiDJInstall 'RUNTIME_DEPENDENCY_MISSING' 'A recorded runtime dependency is no longer available. Existing files were preserved.' }
        $nodePath=[string]$receipt.nodePath; $psPath=[string]$receipt.powershellPath; $reused=$true
    } else {
        $stageParent=Join-Path $chosenRoot '.staging'; $null=[IO.Directory]::CreateDirectory($stageParent); $null=Assert-HuaiDJNoReparse $stageParent
        $stage=Join-Path $stageParent ([guid]::NewGuid().ToString('N').Substring(0,8)); $null=[IO.Directory]::CreateDirectory($stage)
        try {
            $packageZip=Join-Path $stage 'toolkit.zip'; $null=& $DownloadProvider (Get-HuaiDJField $asset 'url') $packageZip; Assert-HuaiDJHash $packageZip (Get-HuaiDJField $asset 'sha256')
            $stageApp=Join-Path $stage 'app'; Expand-HuaiDJCheckedZip $packageZip $stageApp; Assert-HuaiDJPackage $stageApp
            $resolvedRuntimes=@{}
            foreach ($kind in @('node','powershell')) {
                $existing=Get-HuaiDJField $runtime $kind
                if ($existing) { $resolvedRuntimes[$kind]=$existing; continue }
                $dep=Get-HuaiDJField (Get-HuaiDJField $Manifest 'dependencies') $kind; $pin=Get-HuaiDJField (Get-HuaiDJField $dep 'platforms') 'windows-x64'
                $official=& $TextProvider (Get-HuaiDJField $pin 'checksumsUrl'); Assert-HuaiDJChecksumText $official (Get-HuaiDJField $pin 'file') (Get-HuaiDJField $pin 'sha256')
                $zipPath=Join-Path $stage ($kind+'.zip'); $null=& $DownloadProvider (Get-HuaiDJField $pin 'url') $zipPath; Assert-HuaiDJHash $zipPath (Get-HuaiDJField $pin 'sha256')
                $relative='runtimes\'+$kind; $depDestination=Join-Path $stage $relative; $null=[IO.Directory]::CreateDirectory((Split-Path -Parent $depDestination)); Expand-HuaiDJCheckedZip $zipPath $depDestination
                $archiveRoot=[string](Get-HuaiDJField $pin 'archiveRoot'); if ($archiveRoot -cne '.') { $relative=Join-Path $relative $archiveRoot }
                $entryRelative=Join-Path $relative ([string](Get-HuaiDJField $pin 'entry')); $stageExe=Join-Path $stage $entryRelative
                if (-not (Test-Path -LiteralPath $stageExe -PathType Leaf)) { Stop-HuaiDJInstall 'PORTABLE_RUNTIME_INCOMPLETE' 'The verified portable archive has no required executable.' }
                $resolvedRuntimes[$kind]=@{path=$stageExe;finalPath=(Join-Path $versionRoot $entryRelative);existing=$false;version=(Get-HuaiDJField $dep 'version')}
                if ($kind -eq 'node') { $resolvedRuntimes[$kind].npmPath=Join-Path (Split-Path -Parent $stageExe) 'node_modules\npm\bin\npm-cli.js' }
            }
            $nodePath=[string](Get-HuaiDJField $resolvedRuntimes.node 'path'); $npmPath=[string](Get-HuaiDJField $resolvedRuntimes.node 'npmPath')
            if (-not (Test-Path -LiteralPath $npmPath -PathType Leaf)) { Stop-HuaiDJInstall 'NPM_CLI_REQUIRED' 'A matching npm CLI is required for locked dependency installation.' }
            $emptyUser=Join-Path $stage 'npm-user.npmrc'; $emptyGlobal=Join-Path $stage 'npm-global.npmrc'; [IO.File]::WriteAllText($emptyUser,''); [IO.File]::WriteAllText($emptyGlobal,'')
            $cache=Join-Path $chosenRoot 'cache\npm'
            $npmArgs=@($npmPath,'ci','--ignore-scripts','--omit=dev','--no-audit','--no-fund','--registry','https://registry.npmjs.org','--userconfig',$emptyUser,'--globalconfig',$emptyGlobal,'--cache',$cache)
            $null=& $CommandRunner $nodePath $npmArgs $stageApp $true
            if (-not (Test-Path -LiteralPath (Join-Path $stageApp 'node_modules') -PathType Container)) { Stop-HuaiDJInstall 'NPM_INSTALL_INCOMPLETE' 'Locked dependency installation did not produce a local node_modules directory.' }
            $finalNode=[string](Get-HuaiDJField $resolvedRuntimes.node 'finalPath' $nodePath); $psPath=[string](Get-HuaiDJField $resolvedRuntimes.powershell 'finalPath' (Get-HuaiDJField $resolvedRuntimes.powershell 'path'))
            $config=Get-Content -LiteralPath (Join-Path $stageApp 'config.example.json') -Raw -Encoding UTF8|ConvertFrom-Json; $config | Add-Member -NotePropertyName powershell -NotePropertyValue $psPath -Force
            [IO.File]::WriteAllText((Join-Path $stageApp 'config.json'),($config|ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding($false)))
            $critical=@(); $criticalPaths=@('package.json','package-lock.json','bin\rufus-huaidj.exe')
            foreach ($sourceFile in (Get-ChildItem -LiteralPath (Join-Path $stageApp 'src') -File -Recurse)) { $criticalPaths += $sourceFile.FullName.Substring($stageApp.Length+1) }
            foreach ($relativeFile in $criticalPaths) { $critical += @{path=$relativeFile;sha256=(Get-HuaiDJSHA256 (Join-Path $stageApp $relativeFile))} }
            $receipt=[ordered]@{schemaVersion=1;status='complete';version=$script:HuaiDJInstallerVersion;packageSHA256=(Get-HuaiDJField $asset 'sha256');nodePath=$finalNode;powershellPath=$psPath;cliPath=(Join-Path $appRoot 'src\cli.mjs');toolkitRoot=$appRoot;criticalFiles=$critical;createdUTC=[DateTime]::UtcNow.ToString('o')}
            [IO.File]::WriteAllText((Join-Path $stage 'install-receipt.json'),($receipt|ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding($false)))
            $null=[IO.Directory]::CreateDirectory((Split-Path -Parent $versionRoot)); $null=Assert-HuaiDJNoReparse (Split-Path -Parent $versionRoot)
            if (Test-Path -LiteralPath $versionRoot) { Stop-HuaiDJInstall 'RUNTIME_APPEARED' 'The version directory appeared during preparation; neither copy was overwritten.' }
            [IO.Directory]::Move($stage,$versionRoot); $nodePath=$finalNode; $reused=$false
        } catch {
            if (Test-Path -LiteralPath $stage) { [IO.File]::WriteAllText((Join-Path $stage 'incomplete.json'),'{"status":"incomplete","preserved":true}') }
            throw
        }
    }
    $cliPath=Join-Path $appRoot 'src\cli.mjs'; $setupResult=$null
    $canRegister=(-not $runtimeOnly -and (($chosenFlavor -eq 'Mcp' -and $chosenClient -ne '') -or ($chosenFlavor -eq 'Skill' -and (Get-HuaiDJField $Options 'SkillTarget'))))
    if ($canRegister) {
        if ($chosenFlavor -eq 'Mcp') { $setupArgs=@($cliPath,'setup-mcp','--client',$chosenClient) }
        else { $setupArgs=@($cliPath,'setup-skill','--target',[string](Get-HuaiDJField $Options 'SkillTarget')) }
        $setupPreview=& $CommandRunner $nodePath $setupArgs $appRoot $false
        try { $setupPlan=([string](Get-HuaiDJField $setupPreview 'stdout'))|ConvertFrom-Json } catch { Stop-HuaiDJInstall 'INVALID_SETUP_RESULT' 'Generic setup did not return a reviewable JSON preview.' }
        if ((Get-HuaiDJField $setupPlan 'changesNeeded') -eq $false) { $setupResult=$setupPreview }
        else { $setupResult=& $CommandRunner $nodePath ($setupArgs+@('--apply')) $appRoot $false }
    }
    $appliedResult=$null; if ($setupResult) { try { $appliedResult=([string](Get-HuaiDJField $setupResult 'stdout'))|ConvertFrom-Json } catch { Stop-HuaiDJInstall 'INVALID_SETUP_RESULT' 'Generic setup did not return a verifiable JSON result.' } }
    $plan.status='ready'; $plan.configurationApplied=[bool](Get-HuaiDJField $appliedResult 'applied' $false)
    $plan.willDownloadNode=$false; $plan.willDownloadPowerShell=$false
    $plan['runtimeReused']=$reused; $plan['cliCommand']=$nodePath; $plan['cliArgs']=@($cliPath); $plan['cliArgsPrefix']=@($cliPath)
    $plan['nodePath']=$nodePath; $plan['powershellPath']=$psPath; $plan['cliPath']=$cliPath; $plan['toolkitRoot']=$appRoot
    $plan['copyPrompt']='Use this installed HuaiDJ Disk Toolkit runtime. Preserve any existing working agent entry. Select one supported client and run setup-mcp in preview first, then apply only that matching setup; for Skill supply its explicit final target folder. Do not change every client configuration.'
    return [pscustomobject]$plan
    } finally { $installGuard.Dispose() }
}

if ($MyInvocation.InvocationName -ne '.') {
    [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
    try {
        $options=@{InstallRoot=$InstallRoot;Flavor=$Flavor;Client=$Client;SkillTarget=$SkillTarget;RuntimeOnly=[bool]$RuntimeOnly;Apply=[bool]$Apply}
        Invoke-HuaiDJInstaller -Options $options | ConvertTo-Json -Depth 12
    } catch {
        $message=[string]$_.Exception.Message; $code='INSTALLER_FAILED'
        if ($message -match '^\[([A-Z_]+)\] (.+)$') { $code=$Matches[1]; $message=$Matches[2] }
        else { $message='Installation did not complete. Existing runtime and agent configuration were preserved; no elevation was requested.' }
        [ordered]@{status='failed';code=$code;message=$message}|ConvertTo-Json -Depth 4
        exit 1
    }
}
