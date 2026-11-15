[CmdletBinding()]
param([switch]$Elevated, [string]$FixtureId, [ValidateSet('FAT32', 'UDF')][string]$InitialFilesystem = 'FAT32', [switch]$SkipExistingFormats)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtime = [Environment]::ProcessPath
$backend = Join-Path $projectRoot 'src\disk-backend.ps1'
if (-not $FixtureId) { $FixtureId = [Guid]::NewGuid().ToString() }
if ($FixtureId -notmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') { throw 'Invalid fixture ID.' }
$fixtureDirectory = Join-Path $projectRoot ('state\fixtures\' + $FixtureId)
$imagePath = Join-Path $fixtureDirectory 'disk.vhdx'
$receiptPath = Join-Path $fixtureDirectory 'test-result.json'
$isAdministrator = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $Elevated) {
    if (Test-Path -LiteralPath $fixtureDirectory) { throw 'The fixture directory already exists.' }
    New-Item -ItemType Directory -Path $fixtureDirectory | Out-Null
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $runtime; $start.UseShellExecute = $true; $start.Verb = 'runas'; $start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    foreach ($argument in @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-Elevated', '-FixtureId', $FixtureId, '-InitialFilesystem', $InitialFilesystem)) { $start.ArgumentList.Add($argument) }
    if ($SkipExistingFormats) { $start.ArgumentList.Add('-SkipExistingFormats') }
    $child = [Diagnostics.Process]::Start($start)
    [pscustomobject]@{ started = $true; pid = $child.Id; fixtureId = $FixtureId; receiptPath = $receiptPath } | ConvertTo-Json
    exit 0
}
if (-not $isAdministrator) { throw 'The fixture test requires normal Windows administrator approval.' }
if (-not (Test-Path -LiteralPath $fixtureDirectory -PathType Container) -or (Test-Path -LiteralPath $imagePath)) { throw 'The test requires a new owned fixture image.' }

$results = [Collections.Generic.List[object]]::new()
$jobs = [Collections.Generic.List[string]]::new()
$attached = $false
$created = $false

function Save-Receipt($Additional = $null) {
    $value = [ordered]@{ fixtureId = $FixtureId; imagePath = $imagePath; virtualSize = 536870912; passed = $results.Count; results = @($results.ToArray()); jobs = @($jobs.ToArray()); realPhysicalDisksWritten = $false; completedUTC = [DateTime]::UtcNow.ToString('o') }
    if ($Additional) { foreach ($key in $Additional.Keys) { $value[$key] = $Additional[$key] } }
    [IO.File]::WriteAllText($receiptPath, ($value | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
}

function Invoke-BackendFile([string[]]$Arguments) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $runtime; $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    foreach ($argument in @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $backend) + $Arguments) { $start.ArgumentList.Add($argument) }
    $child = [Diagnostics.Process]::Start($start)
    $stdout = $child.StandardOutput.ReadToEndAsync(); $stderr = $child.StandardError.ReadToEndAsync()
    if (-not $child.WaitForExit(300000)) { throw 'An owned VHD test operation exceeded five minutes; the process was left for inspection.' }
    return [pscustomobject]@{ exitCode = $child.ExitCode; stdout = $stdout.GetAwaiter().GetResult(); stderr = $stderr.GetAwaiter().GetResult() }
}

function New-FixtureRequest([string]$Action) {
    $disk = Get-Disk -Number $script:fixtureDiskNumber
    return [ordered]@{
        operation = $Action; deviceNumber = [int]$disk.Number; size = [long]$disk.Size
        serial = $script:fixtureSerial; identity = $script:fixtureIdentity
        fixturePath = $imagePath; fixtureToken = $script:fixtureToken
        confirm = $(if ($Action -eq 'verify-image') { 'VERIFY:' } else { 'ERASE:' }) + $disk.Number + ':' + $disk.Size
    }
}

function Invoke-FixtureJob($Request, [string]$ExpectedError = '') {
    $job = [Guid]::NewGuid().ToString()
    $directory = Join-Path $projectRoot ('state\jobs\' + $job)
    New-Item -ItemType Directory -Path $directory | Out-Null
    $requestPath = Join-Path $directory 'disk-request.json'
    $Request | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $requestPath -Encoding utf8NoBOM
    $hash = (Get-FileHash -LiteralPath $requestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $result = Invoke-BackendFile @('-Operation', 'RunJob', '-RequestPath', $requestPath, '-RequestSHA256', $hash)
    $jobs.Add($job)
    [IO.File]::WriteAllText((Join-Path $directory 'test-invocation.stdout.log'), $result.stdout, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $directory 'test-invocation.stderr.log'), $result.stderr, [Text.UTF8Encoding]::new($false))
    $response = $result.stdout | ConvertFrom-Json
    $status = if (Test-Path -LiteralPath (Join-Path $directory 'status.json')) { Get-Content -LiteralPath (Join-Path $directory 'status.json') -Raw | ConvertFrom-Json } else { $null }
    if ($ExpectedError) {
        if ($response.error -cne $ExpectedError) { throw "Expected $ExpectedError but received $($result.stdout)" }
    } elseif ($result.exitCode -ne 0 -or -not $status.success -or -not $status.final) {
        throw "Fixture operation did not succeed: $($result.stdout) status=$($status | ConvertTo-Json -Compress)"
    }
    return [pscustomobject]@{ job = $job; directory = $directory; requestPath = $requestPath; hash = $hash; status = $status; response = $response }
}

function Test-VolumeFileRoundtrip([string]$Filesystem) {
    $partition = Get-Partition -DiskNumber $script:fixtureDiskNumber | Where-Object { $_.Type -notin @('Reserved', 'System') } | Select-Object -Last 1
    if (-not $partition.DriveLetter) { throw 'The fixture data partition has no drive letter.' }
    $volume = $partition | Get-Volume
    if ($volume.FileSystem -ine $Filesystem) { throw 'The formatted filesystem was not read back.' }
    $file = ([string]$partition.DriveLetter) + ':\huaidj-fixture-roundtrip.bin'
    $bytes = [Security.Cryptography.RandomNumberGenerator]::GetBytes(65536)
    [IO.File]::WriteAllBytes($file, $bytes)
    $expected = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes))
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -cne $expected) { throw 'The fixture file roundtrip hash did not match.' }
    return $partition
}

try {
    New-VHD -Path $imagePath -Dynamic -SizeBytes 512MB -ErrorAction Stop | Out-Null
    $created = $true
    Mount-VHD -Path $imagePath -ErrorAction Stop | Out-Null
    $attached = $true
    $image = Get-DiskImage -ImagePath $imagePath
    if ($image.DevicePath -notmatch 'PhysicalDrive([0-9]+)$') { throw 'The new VHD physical device could not be identified.' }
    $script:fixtureDiskNumber = [int]$Matches[1]
    $disk = Get-Disk -Number $script:fixtureDiskNumber
    if ($disk.IsBoot -or $disk.IsSystem -or $disk.Size -ne 512MB) { throw 'The new VHD did not match the isolated fixture.' }
    $script:fixtureToken = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
    $script:fixtureSerial = 'VHD:' + $FixtureId
    $text = [string]$disk.FriendlyName + [char]0 + $script:fixtureSerial + [char]0 + ([uint64]$disk.Size).ToString([Globalization.CultureInfo]::InvariantCulture)
    $script:fixtureIdentity = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($text))).ToLowerInvariant()
    [ordered]@{ fixtureId = $FixtureId; token = $script:fixtureToken; imagePath = $imagePath; virtualSize = [long]$disk.Size; imageCreationTicks = (Get-Item -LiteralPath $imagePath).CreationTimeUtc.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture); createdUTC = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $fixtureDirectory 'fixture-manifest.json') -Encoding utf8NoBOM
    Save-Receipt @{ state = 'running'; attached = $true }

    $request = New-FixtureRequest 'initialize-usb'
    $request.partitionStyle = 'GPT'; $request.filesystem = $InitialFilesystem; $request.label = 'HUAIDJTEST'; $request.quick = $true
    $job = Invoke-FixtureJob $request
    $partition = Test-VolumeFileRoundtrip $InitialFilesystem
    $results.Add([pscustomobject]@{ name = ('GPT + ' + $InitialFilesystem + ' format and file SHA-256 roundtrip'); passed = $true; job = $job.job })
    Save-Receipt @{ state = 'running'; attached = $true }
    $existingFormats = if ($SkipExistingFormats) { @() } else { @('NTFS', 'exFAT', 'UDF') }
    foreach ($filesystem in $existingFormats) {
        $request = New-FixtureRequest 'format-volume'
        $request.partitionNumber = [int]$partition.PartitionNumber; $request.partitionOffset = [long]$partition.Offset; $request.partitionSize = [long]$partition.Size
        $request.filesystem = $filesystem; $request.label = 'HUAIDJTEST'; $request.quick = $true
        $job = Invoke-FixtureJob $request
        $partition = Test-VolumeFileRoundtrip $filesystem
        $results.Add([pscustomobject]@{ name = $filesystem + ' existing-volume format and file SHA-256 roundtrip'; passed = $true; job = $job.job })
        Save-Receipt @{ state = 'running'; attached = $true }
    }
    $request = New-FixtureRequest 'initialize-usb'
    $request.partitionStyle = 'MBR'; $request.filesystem = 'FAT'; $request.label = 'HUAIDJTEST'; $request.quick = $true
    $job = Invoke-FixtureJob $request
    $partition = Test-VolumeFileRoundtrip 'FAT'
    $results.Add([pscustomobject]@{ name = 'MBR + FAT format and file SHA-256 roundtrip'; passed = $true; job = $job.job })

    $prefixPath = Join-Path $fixtureDirectory 'prefix.img'
    $prefix = [byte[]]::new(65536)
    $physical = [IO.FileStream]::new(('\\.\PhysicalDrive' + $script:fixtureDiskNumber), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try { $physical.ReadExactly($prefix) } finally { $physical.Dispose() }
    [IO.File]::WriteAllBytes($prefixPath, $prefix)
    $request = New-FixtureRequest 'verify-image'
    $request.imagePath = $prefixPath; $request.imageSHA256 = (Get-FileHash -LiteralPath $prefixPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $job = Invoke-FixtureJob $request
    if ($job.status.sourceSHA256 -cne $job.status.readbackSHA256) { throw 'Physical prefix readback did not match.' }
    $results.Add([pscustomobject]@{ name = 'physical VHD prefix SHA-256 matches locked source'; passed = $true; job = $job.job })

    $replay = Invoke-BackendFile @('-Operation', 'RunJob', '-RequestPath', $job.requestPath, '-RequestSHA256', $job.hash)
    if (($replay.stdout | ConvertFrom-Json).error -cne 'JOB_ALREADY_STARTED') { throw 'A finished job was allowed to replay.' }
    $results.Add([pscustomobject]@{ name = 'finished job replay refused'; passed = $true })
    Save-Receipt @{ state = 'passed'; attached = $true; completed = $true }
} catch {
    Save-Receipt @{ state = 'failed'; error = $_.Exception.Message; attached = $attached; completed = $true }
} finally {
    if ($attached -and $created -and $imagePath.StartsWith((Join-Path $projectRoot 'state\fixtures\'), [StringComparison]::OrdinalIgnoreCase)) {
        try { Dismount-VHD -Path $imagePath -ErrorAction Stop; $attached = $false } catch {}
    }
    if (Test-Path -LiteralPath $receiptPath) {
        $value = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
        $value.attached = $attached
        $value | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $receiptPath -Encoding utf8NoBOM
    }
}
