$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$backend = Join-Path $projectRoot 'src\windows-backend.ps1'
$fixtureRoot = Join-Path $projectRoot ('state\jobs\backend-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixtureRoot -Force | Out-Null
$fixtureImage = Join-Path $fixtureRoot 'fixture.iso'
[IO.File]::WriteAllBytes($fixtureImage, [byte[]]::new(4096))
$requestPath = Join-Path $fixtureRoot 'request.json'
$statusPath = Join-Path $fixtureRoot 'status.json'
$testResults = [Collections.Generic.List[object]]::new()
$powerShellPath = (Get-Process -Id $PID).Path

function Invoke-Backend([string]$Action, [string]$Request = '') {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $powerShellPath
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $backend, '-Operation', $Action)) { $start.ArgumentList.Add($argument) }
    if ($Request) { $start.ArgumentList.Add('-RequestPath'); $start.ArgumentList.Add($Request) }
    $child = [Diagnostics.Process]::Start($start)
    $outputTask = $child.StandardOutput.ReadToEndAsync()
    $errorTask = $child.StandardError.ReadToEndAsync()
    if (-not $child.WaitForExit(60000)) { $child.Kill(); throw 'Backend test timed out.' }
    $output = $outputTask.GetAwaiter().GetResult()
    $errorText = $errorTask.GetAwaiter().GetResult()
    if ($errorText) { throw ('Backend wrote unexpected stderr: ' + $errorText) }
    return $output | ConvertFrom-Json -ErrorAction Stop
}

function Assert-Equal($Actual, $Expected, [string]$Label) {
    if ($Actual -cne $Expected) { throw "$Label expected $Expected; received $Actual" }
}

function Run-Rejection([string]$Name, $Request, [string]$Expected) {
    $Request | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $requestPath -Encoding utf8NoBOM
    $result = Invoke-Backend 'StartEngine' $requestPath
    Assert-Equal $result.error $Expected $Name
    Assert-Equal $result.started $false $Name
    $testResults.Add([pscustomobject]@{ name = $Name; passed = $true; error = $result.error })
}

$inventory = Invoke-Backend 'Devices'
if ($inventory.devices.Count -lt 1) { throw 'No devices returned by read-only inventory.' }
foreach ($disk in $inventory.devices) {
    if ($disk.isBoot -or $disk.isSystem -or $disk.busType -ne 'USB') {
        Assert-Equal $disk.eligible $false 'Protected/internal device rejection'
    }
    if ($disk.eligible) {
        Assert-Equal $disk.descriptorBusType 7 'Eligible storage bus'
        if (-not $disk.serial -or $disk.identity -notmatch '^[a-f0-9]{64}$') { throw 'Eligible device has no verified identity.' }
    }
}
$testResults.Add([pscustomobject]@{ name = 'live read-only inventory and protected disk classification'; passed = $true; deviceCount = $inventory.devices.Count })

$outside = Invoke-Backend 'StartEngine' (Join-Path $projectRoot 'work\request.json')
Assert-Equal $outside.error 'INVALID_JOB_PATH' 'Escaped request path'
$testResults.Add([pscustomobject]@{ name = 'request path outside jobs rejected'; passed = $true })

$baseRequest = [ordered]@{
    deviceNumber = 999
    size = 30784094208
    serial = 'fixture-serial'
    imagePath = $fixtureImage
    imageSHA256 = (Get-FileHash -LiteralPath $fixtureImage -Algorithm SHA256).Hash.ToLowerInvariant()
    mode = 'dd'
    statusPath = $statusPath
    confirm = 'ERASE:999:30784094208'
    dryRun = $true
}
$missingHash = [ordered]@{}; foreach ($key in $baseRequest.Keys) { if ($key -ne 'imageSHA256') { $missingHash[$key] = $baseRequest[$key] } }
Run-Rejection 'missing image SHA-256' $missingHash 'INVALID_REQUEST'
$invalidHash = [ordered]@{}; foreach ($key in $baseRequest.Keys) { $invalidHash[$key] = $baseRequest[$key] }
$invalidHash.imageSHA256 = 'not-a-digest'
Run-Rejection 'invalid image SHA-256' $invalidHash 'INVALID_REQUEST'
$invalidConfirm = [ordered]@{}; foreach ($key in $baseRequest.Keys) { $invalidConfirm[$key] = $baseRequest[$key] }
$invalidConfirm.confirm = 'yes'
Run-Rejection 'erase confirmation mismatch' $invalidConfirm 'ERASE_NOT_CONFIRMED'
$invalidStatus = [ordered]@{}; foreach ($key in $baseRequest.Keys) { $invalidStatus[$key] = $baseRequest[$key] }
$invalidStatus.statusPath = Join-Path $projectRoot 'work\status.json'
Run-Rejection 'status path outside job' $invalidStatus 'INVALID_STATUS_PATH'
Run-Rejection 'missing target device' $baseRequest 'DEVICE_NOT_FOUND'

$protected = $inventory.devices | Where-Object { $_.isBoot -or $_.isSystem } | Select-Object -First 1
if ($protected) {
    $internalRequest = [ordered]@{}; foreach ($key in $baseRequest.Keys) { $internalRequest[$key] = $baseRequest[$key] }
    $internalRequest.deviceNumber = [int]$protected.number
    $internalRequest.size = [long]$protected.size
    $internalRequest.serial = [string]$protected.serial
    $internalRequest.confirm = 'ERASE:' + $protected.number + ':' + $protected.size
    Run-Rejection 'system disk target' $internalRequest 'DEVICE_NOT_ELIGIBLE'
}

$usb = $inventory.devices | Where-Object eligible | Select-Object -First 1
if ($usb) {
    $staleRequest = [ordered]@{}; foreach ($key in $baseRequest.Keys) { $staleRequest[$key] = $baseRequest[$key] }
    $staleRequest.deviceNumber = [int]$usb.number
    $staleRequest.size = [long]$usb.size
    $staleRequest.serial = $usb.serial + '-stale'
    $staleRequest.confirm = 'ERASE:' + $usb.number + ':' + $usb.size
    Run-Rejection 'USB identity changed' $staleRequest 'DEVICE_IDENTITY_CHANGED'
    $sourceValidationRequest = [ordered]@{}; foreach ($key in $staleRequest.Keys) { $sourceValidationRequest[$key] = $staleRequest[$key] }
    $sourceValidationRequest.serial = [string]$usb.serial
    $sourceValidationRequest.imageSHA256 = '0' * 64
    Run-Rejection 'source final volume mapped before checksum rejection' $sourceValidationRequest 'IMAGE_IDENTITY_CHANGED'
}

foreach ($file in @($fixtureImage, $requestPath)) { Remove-Item -LiteralPath $file -Force }
Remove-Item -LiteralPath $fixtureRoot -Force
[pscustomobject]@{ passed = $testResults.Count; tests = $testResults; noEngineLaunched = $true; noMediaWritten = $true } | ConvertTo-Json -Depth 5
exit 0
