$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtime = [Environment]::ProcessPath
$backend = Join-Path $projectRoot 'src\disk-backend.ps1'
$evidence = Join-Path $projectRoot ('work\disk-backend-safety-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $evidence | Out-Null
$image = Join-Path $evidence 'input.img'
[IO.File]::WriteAllBytes($image, [byte[]]::new(4096))
$tests = [Collections.Generic.List[object]]::new()

function Invoke-DiskBackend([string[]]$Arguments) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $runtime; $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    foreach ($argument in @('-NoProfile', '-NonInteractive', '-File', $backend) + $Arguments) { $start.ArgumentList.Add($argument) }
    $child = [Diagnostics.Process]::Start($start)
    $output = $child.StandardOutput.ReadToEndAsync(); $errorOutput = $child.StandardError.ReadToEndAsync()
    if (-not $child.WaitForExit(60000)) { throw 'Disk backend safety test timed out.' }
    $text = $output.GetAwaiter().GetResult()
    if ($errorOutput.GetAwaiter().GetResult()) { throw 'The disk backend emitted unexpected stderr.' }
    return $text | ConvertFrom-Json
}

function Assert-Code([string]$Name, $Request, [string]$Code) {
    $directory = Join-Path $projectRoot ('state\jobs\' + [Guid]::NewGuid().ToString())
    New-Item -ItemType Directory -Path $directory | Out-Null
    $file = Join-Path $directory 'disk-request.json'
    $Request | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $file -Encoding utf8NoBOM
    $result = Invoke-DiskBackend @('-Operation', 'StartJob', '-RequestPath', $file)
    if ($result.error -cne $Code) { throw "$Name expected $Code but received $($result | ConvertTo-Json -Compress)" }
    if (Test-Path -LiteralPath (Join-Path $directory 'disk-started.json')) { throw 'A rejected request reached process startup.' }
    $tests.Add([pscustomobject]@{ name = $Name; passed = $true; error = $Code })
}

$capabilities = Invoke-DiskBackend @('-Operation', 'Capabilities')
if (@($capabilities.filesystems).Count -ne 6 -or ($capabilities.filesystems | Where-Object name -eq 'ReFS').usbWriteAllowed -ne $false) { throw 'Filesystem capability policy is incorrect.' }
if ($capabilities.filesystems.name -contains 'ext4' -or $capabilities.filesystems.name -contains 'APFS') { throw 'Foreign filesystems were incorrectly advertised as Windows native formatters.' }
$tests.Add([pscustomobject]@{ name = 'six Windows filesystem capabilities and ReFS USB restriction'; passed = $true })
$outside = Invoke-DiskBackend @('-Operation', 'StartJob', '-RequestPath', (Join-Path $evidence 'disk-request.json'))
if ($outside.error -cne 'INVALID_JOB_PATH') { throw 'Out-of-root disk request was accepted.' }
$tests.Add([pscustomobject]@{ name = 'out-of-root request rejected'; passed = $true })

$base = [ordered]@{ operation = 'verify-image'; deviceNumber = 999; size = 536870912; serial = 'synthetic-test'; identity = 'a' * 64; confirm = 'VERIFY:999:536870912'; imagePath = $image; imageSHA256 = '0' * 64 }
function Copy-Request { $copy = [ordered]@{}; foreach ($key in $base.Keys) { $copy[$key] = $base[$key] }; return $copy }
$request = Copy-Request; $request.operation = 'shell'; Assert-Code 'unknown operation rejected' $request 'INVALID_OPERATION'
$request = Copy-Request; $request.confirm = 'ERASE:999:536870912'; Assert-Code 'verification never accepts erase confirmation' $request 'CONFIRMATION_MISMATCH'
$request = Copy-Request; $request.imageSHA256 = 'bad'; Assert-Code 'verification needs complete expected digest' $request 'INVALID_REQUEST'
$request = Copy-Request; $request.operation = 'initialize-usb'; $request.confirm = 'ERASE:999:536870912'; $request.filesystem = 'ReFS'; $request.label = 'TEST'; $request.quick = $true; $request.partitionStyle = 'GPT'; Assert-Code 'ReFS USB format rejected before mutation' $request 'REFS_USB_UNSUPPORTED'
$request.filesystem = 'ext4'; Assert-Code 'ext4 is not Windows formatting support' $request 'INVALID_FILESYSTEM'
$request.filesystem = 'NTFS'; $request.partitionStyle = 'invalid'; Assert-Code 'unknown partition style rejected' $request 'INVALID_PARTITION_STYLE'
$request.operation = 'format-volume'; $request.partitionNumber = 1; Assert-Code 'existing volume requires prepared offset and size' $request 'INVALID_REQUEST'

# Load only owned function definitions, then replace the device-query functions
# with synthetic records. These guard tests cannot call formatting or elevation.
$ast = [Management.Automation.Language.Parser]::ParseFile($backend, [ref]$null, [ref]$null)
foreach ($definition in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) { Invoke-Expression $definition.Extent.Text }
$script:mockDisk = [pscustomobject]@{ Number = 999; FriendlyName = 'Synthetic Disk'; Size = 536870912; BusType = 'USB'; IsBoot = $true; IsSystem = $false; IsOffline = $false; IsReadOnly = $false }
function Get-Disk { param($Number, $ErrorAction) return $script:mockDisk }
function Get-Partition { param($DiskNumber, $ErrorAction) return @() }
function Get-DiskIdentity { param($Disk) return [pscustomobject]@{ serial = 'synthetic-test'; identity = 'a' * 64; descriptorBusType = 7 } }
try { $null = Assert-CurrentTarget ([pscustomobject]$base); throw 'A synthetic active system disk was accepted.' } catch { if ($_.Exception.Data['Code'] -cne 'SYSTEM_DISK_REFUSED') { throw } }
$tests.Add([pscustomobject]@{ name = 'synthetic active boot/system disk refused'; passed = $true })
$script:mockDisk.IsBoot = $false; $script:mockDisk.BusType = 'NVMe'
try { $null = Assert-CurrentTarget ([pscustomobject]$base); throw 'A synthetic internal disk was accepted.' } catch { if ($_.Exception.Data['Code'] -cne 'INTERNAL_WRITES_UNSUPPORTED') { throw } }
$tests.Add([pscustomobject]@{ name = 'synthetic internal disk refused'; passed = $true })

$receipt = [ordered]@{ passed = $tests.Count; tests = @($tests.ToArray()); noPhysicalMediaWritten = $true; noElevatedJobStarted = $true; evidenceDirectory = $evidence; completedUTC = [DateTime]::UtcNow.ToString('o') }
$receipt | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath (Join-Path $evidence 'result.json') -Encoding utf8NoBOM
$receipt | ConvertTo-Json -Depth 7
exit 0
