[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Devices', 'StartEngine')]
    [string]$Operation,
    [string]$RequestPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$jobsRoot = Join-Path $projectRoot 'state\jobs'

function Write-JsonResult($Value) {
    [Console]::Out.WriteLine(($Value | ConvertTo-Json -Depth 10 -Compress))
}

function Assert-Backend($Condition, [string]$Code, [string]$Message) {
    if (-not $Condition) {
        $exception = [InvalidOperationException]::new($Message)
        $exception.Data['Code'] = $Code
        throw $exception
    }
}

function Initialize-StorageInterop {
    if ('HuaiDJ.RufusBridge.NativeStorage' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace HuaiDJ.RufusBridge {
    public sealed class StorageDescriptor {
        public string Serial { get; set; }
        public int BusType { get; set; }
    }
    public static class NativeStorage {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(string name, uint access,
            uint share, IntPtr security, uint creation, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool DeviceIoControl(SafeFileHandle handle, uint control,
            byte[] input, uint inputSize, byte[] output, uint outputSize,
            out uint returned, IntPtr overlapped);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle,
            StringBuilder path, uint capacity, uint flags);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool GetVolumePathNameW(string fileName,
            StringBuilder volumePath, uint length);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool GetVolumeNameForVolumeMountPointW(string mount,
            StringBuilder volumeName, uint capacity);

        public static StorageDescriptor ReadDescriptor(int number) {
            using (var handle = CreateFileW(@"\\.\PhysicalDrive" + number, 0, 3,
                IntPtr.Zero, 3, 0, IntPtr.Zero)) {
                if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
                // STORAGE_PROPERTY_QUERY: StorageDeviceProperty = 0, PropertyStandardQuery = 0.
                byte[] input = new byte[12];
                byte[] output = new byte[65536];
                uint returned;
                if (!DeviceIoControl(handle, 0x002D1400, input, (uint)input.Length,
                    output, (uint)output.Length, out returned, IntPtr.Zero))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                if (returned < 36) throw new InvalidDataException("Storage descriptor is incomplete.");
                uint size = BitConverter.ToUInt32(output, 4);
                uint serialOffset = BitConverter.ToUInt32(output, 24);
                int busType = BitConverter.ToInt32(output, 28);
                int limit = (int)Math.Min(returned, Math.Min(size, (uint)output.Length));
                string serial = "";
                if (serialOffset > 0 && serialOffset < limit) {
                    int end = (int)serialOffset;
                    while (end < limit && output[end] != 0) end++;
                    if (end == limit) throw new InvalidDataException("Storage serial is unterminated.");
                    serial = Encoding.ASCII.GetString(output, (int)serialOffset, end - (int)serialOffset);
                }
                return new StorageDescriptor { Serial = serial, BusType = busType };
            }
        }

        public static string FinalFileVolume(string path) {
            // Sharing read only prevents a writer from changing the file while this handle exists.
            using (var handle = CreateFileW(path, 0, 1, IntPtr.Zero, 3, 0, IntPtr.Zero)) {
                if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
                var finalPath = new StringBuilder(32768);
                uint length = GetFinalPathNameByHandleW(handle, finalPath, (uint)finalPath.Capacity, 0);
                if (length == 0 || length >= finalPath.Capacity)
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                string resolved = finalPath.ToString();
                if (resolved.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Network image paths are not supported.");
                var mount = new StringBuilder(32768);
                if (!GetVolumePathNameW(resolved, mount, (uint)mount.Capacity))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                var volume = new StringBuilder(1024);
                if (!GetVolumeNameForVolumeMountPointW(mount.ToString(), volume, (uint)volume.Capacity))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                return volume.ToString();
            }
        }
    }
}
'@ -ErrorAction Stop | Out-Null
}

function Get-DeviceInventory {
    Initialize-StorageInterop
    $disks = @(Get-Disk -ErrorAction Stop | Sort-Object Number)
    $partitions = @(Get-Partition -ErrorAction Stop)
    $devices = @(
        foreach ($disk in $disks) {
            $serial = ''
            $descriptorBus = $null
            $descriptorError = $null
            try {
                $descriptor = [HuaiDJ.RufusBridge.NativeStorage]::ReadDescriptor([int]$disk.Number)
                $serial = [string]$descriptor.Serial
                $descriptorBus = [int]$descriptor.BusType
            } catch {
                $cause = $_.Exception
                while ($cause.InnerException) { $cause = $cause.InnerException }
                $descriptorError = if ($cause -is [ComponentModel.Win32Exception]) {
                    'WIN32_' + $cause.NativeErrorCode
                } else { 'DESCRIPTOR_UNAVAILABLE' }
            }
            $model = [string]$disk.FriendlyName
            $identity = $null
            if (-not [string]::IsNullOrWhiteSpace($serial)) {
                $identityText = $model + [char]0 + $serial + [char]0 + ([uint64]$disk.Size).ToString([Globalization.CultureInfo]::InvariantCulture)
                $identity = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($identityText))).ToLowerInvariant()
            }
            $diskPartitions = @($partitions | Where-Object DiskNumber -eq $disk.Number)
            $letters = @($diskPartitions | Where-Object { $_.DriveLetter -and [int][char]$_.DriveLetter -ne 0 } | ForEach-Object { [string]$_.DriveLetter })
            $protectedPartition = [bool]@($diskPartitions | Where-Object { $_.IsBoot -or $_.IsSystem }).Count
            $eligible = $disk.BusType.ToString() -eq 'USB' -and $descriptorBus -eq 7 -and
                -not $disk.IsBoot -and -not $disk.IsSystem -and -not $protectedPartition -and
                -not $disk.IsReadOnly -and -not $disk.IsOffline -and [uint64]$disk.Size -gt 0 -and
                -not [string]::IsNullOrWhiteSpace($serial) -and $null -ne $identity
            [pscustomobject]@{
                number = [int]$disk.Number
                model = $model
                size = [uint64]$disk.Size
                busType = $disk.BusType.ToString()
                partitionStyle = $disk.PartitionStyle.ToString()
                descriptorBusType = $descriptorBus
                isBoot = [bool]$disk.IsBoot
                isSystem = [bool]$disk.IsSystem
                isReadOnly = [bool]$disk.IsReadOnly
                isOffline = [bool]$disk.IsOffline
                serial = $serial
                identity = $identity
                letters = $letters
                eligible = [bool]$eligible
                descriptorError = $descriptorError
            }
        }
    )
    return [pscustomobject]@{ devices = $devices; transport = 'local-windows-storage'; version = 1 }
}

function Assert-NoReparsePath([string]$Path, [string]$StopAt) {
    $current = [IO.Path]::GetFullPath($Path)
    $stop = [IO.Path]::GetFullPath($StopAt).TrimEnd('\')
    while ($true) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            Assert-Backend (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'REPARSE_JOB_PATH' 'Job paths must not contain reparse points.'
        }
        if ($current.TrimEnd('\').Equals($stop, [StringComparison]::OrdinalIgnoreCase)) { break }
        $parent = [IO.Path]::GetDirectoryName($current.TrimEnd('\'))
        Assert-Backend (-not [string]::IsNullOrEmpty($parent)) 'INVALID_JOB_PATH' 'Job path escaped its expected root.'
        $current = $parent
    }
}

function Start-RufusEngine {
    Assert-Backend (-not [string]::IsNullOrWhiteSpace($RequestPath)) 'REQUEST_REQUIRED' 'RequestPath is required.'
    $requestFile = [IO.Path]::GetFullPath($RequestPath)
    $expectedRoot = [IO.Path]::GetFullPath($jobsRoot).TrimEnd('\') + '\'
    Assert-Backend ($requestFile.StartsWith($expectedRoot, [StringComparison]::OrdinalIgnoreCase)) 'INVALID_JOB_PATH' 'RequestPath must be under the local jobs directory.'
    $relative = $requestFile.Substring($expectedRoot.Length)
    Assert-Backend ($relative -match '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\\request\.json$') 'INVALID_JOB_PATH' 'RequestPath must identify one job request.json file.'
    Assert-Backend (Test-Path -LiteralPath $requestFile -PathType Leaf) 'REQUEST_NOT_FOUND' 'The job request does not exist.'
    Assert-NoReparsePath $requestFile $projectRoot
    Assert-Backend ((Get-Item -LiteralPath $requestFile).Length -le 32768) 'REQUEST_TOO_LARGE' 'The job request is too large.'
    $request = Get-Content -LiteralPath $requestFile -Raw -Encoding utf8 | ConvertFrom-Json -ErrorAction Stop
    foreach ($field in @('deviceNumber', 'size', 'serial', 'statusPath', 'confirm', 'dryRun')) {
        Assert-Backend ($request.PSObject.Properties.Name -contains $field) 'INVALID_REQUEST' ('Missing required field: ' + $field)
    }
    $nativeOperation = if ($request.PSObject.Properties.Name -contains 'operation') { [string]$request.operation } else { 'image' }
    Assert-Backend ($nativeOperation -cin @('image', 'format')) 'INVALID_REQUEST' 'Native operation must be image or format.'
    if ($nativeOperation -eq 'image') {
        foreach ($field in @('imagePath', 'mode', 'imageSHA256')) {
            Assert-Backend ($request.PSObject.Properties.Name -contains $field) 'INVALID_REQUEST' ('Missing required field: ' + $field)
        }
    } else {
        $inapplicableFields = @(@('imagePath', 'mode', 'imageSHA256') | Where-Object { $request.PSObject.Properties.Name -contains $_ })
        Assert-Backend ($inapplicableFields.Count -eq 0) 'INVALID_REQUEST' 'Format-only requests must not include an image, hash or image mode.'
        Assert-Backend ($request.PSObject.Properties.Name -contains 'nativeOptions') 'INVALID_REQUEST' 'Format-only requests require explicit native options.'
    }
    Assert-Backend ($request.deviceNumber -is [long] -or $request.deviceNumber -is [int]) 'INVALID_REQUEST' 'deviceNumber must be an integer.'
    Assert-Backend ($request.deviceNumber -ge 0 -and $request.deviceNumber -le 1023) 'INVALID_REQUEST' 'deviceNumber is out of range.'
    Assert-Backend ($request.size -is [long] -or $request.size -is [int] -or $request.size -is [uint64]) 'INVALID_REQUEST' 'size must be an integer.'
    Assert-Backend ($request.size -gt 0) 'INVALID_REQUEST' 'size must be positive.'
    Assert-Backend ($request.serial -is [string] -and -not [string]::IsNullOrWhiteSpace($request.serial)) 'INVALID_REQUEST' 'A storage serial is required.'
    Assert-Backend ($request.serial.Length -le 1024 -and $request.serial -notmatch '[\x00-\x1f]') 'INVALID_REQUEST' 'The storage serial is invalid.'
    if ($nativeOperation -eq 'image') {
        Assert-Backend ($request.imageSHA256 -is [string] -and $request.imageSHA256 -match '^[a-fA-F0-9]{64}$') 'INVALID_REQUEST' 'imageSHA256 must be a complete SHA-256 digest.'
        Assert-Backend ($request.mode -is [string] -and $request.mode -cin @('dd', 'iso')) 'INVALID_REQUEST' 'mode must be dd or iso.'
    }
    Assert-Backend ($request.dryRun -is [bool]) 'INVALID_REQUEST' 'dryRun must be a boolean.'
    $number = [int]$request.deviceNumber
    $size = [uint64]$request.size
    $expectedConfirm = 'ERASE:' + $number.ToString([Globalization.CultureInfo]::InvariantCulture) + ':' + $size.ToString([Globalization.CultureInfo]::InvariantCulture)
    Assert-Backend ($request.confirm -is [string] -and $request.confirm -ceq $expectedConfirm) 'ERASE_NOT_CONFIRMED' 'The exact device erase confirmation is required.'
    $jobDirectory = [IO.Path]::GetDirectoryName($requestFile)
    $statusFile = [IO.Path]::GetFullPath([string]$request.statusPath)
    $expectedStatus = Join-Path $jobDirectory 'status.json'
    Assert-Backend ($statusFile.Equals($expectedStatus, [StringComparison]::OrdinalIgnoreCase)) 'INVALID_STATUS_PATH' 'statusPath must be this job status.json file.'
    Assert-NoReparsePath $statusFile $projectRoot
    if ($nativeOperation -eq 'image') {
    Assert-Backend ($request.imagePath -is [string] -and $request.imagePath -match '^[a-zA-Z]:[\\/]') 'INVALID_IMAGE_PATH' 'imagePath must be an absolute local drive path.'
    $imagePath = [IO.Path]::GetFullPath($request.imagePath)
    Assert-Backend ([IO.Path]::GetExtension($imagePath).ToLowerInvariant() -in @('.iso', '.img', '.vhd', '.vhdx')) 'INVALID_IMAGE_PATH' 'The image file extension is not supported.'
    Assert-Backend ($imagePath.Substring(2) -notmatch ':') 'INVALID_IMAGE_PATH' 'Alternate data streams are not supported.'
    Assert-Backend (Test-Path -LiteralPath $imagePath -PathType Leaf) 'IMAGE_NOT_FOUND' 'The image file does not exist.'
    $imageFile = Get-Item -LiteralPath $imagePath
    Assert-Backend ($imageFile.Length -gt 0 -and [uint64]$imageFile.Length -le $size) 'IMAGE_SIZE_INVALID' 'The image must be nonempty and fit on the USB device.'
    }
    $nativeOptions = [ordered]@{ filesystem='auto'; partitionScheme='auto'; targetSystem='auto'; clusterSize='auto'; volumeLabel=$null; quickFormat=$null }
    if ($request.nativeOptions) {
        Assert-Backend ($request.nativeOptions -is [pscustomobject]) 'INVALID_NATIVE_OPTIONS' 'Native options must be an object.'
        foreach ($property in $request.nativeOptions.PSObject.Properties) {
            Assert-Backend ($nativeOptions.Contains($property.Name)) 'INVALID_NATIVE_OPTIONS' 'Unknown native format option.'
            $nativeOptions[$property.Name] = $property.Value
        }
    }
    Assert-Backend ($nativeOptions.filesystem -cin @('auto','fat32','ntfs','exfat')) 'INVALID_NATIVE_OPTIONS' 'Unsupported native filesystem.'
    Assert-Backend ($nativeOptions.partitionScheme -cin @('auto','mbr','gpt')) 'INVALID_NATIVE_OPTIONS' 'Unsupported native partition scheme.'
    Assert-Backend ($nativeOptions.targetSystem -cin @('auto','bios','uefi')) 'INVALID_NATIVE_OPTIONS' 'Unsupported native target system.'
    $cluster = $nativeOptions.clusterSize
    Assert-Backend ($cluster -ceq 'auto' -or (($cluster -is [long] -or $cluster -is [int]) -and $cluster -ge 512 -and $cluster -le 2097152 -and ($cluster -band ($cluster-1)) -eq 0)) 'INVALID_CLUSTER_SIZE' 'Unsupported native cluster size.'
    Assert-Backend ($null -eq $nativeOptions.volumeLabel -or ($nativeOptions.volumeLabel -is [string] -and $nativeOptions.volumeLabel.Length -le 32 -and [Text.Encoding]::UTF8.GetByteCount($nativeOptions.volumeLabel) -le 63 -and $nativeOptions.volumeLabel -notmatch '[\x00-\x1f\\/:*?"<>|]')) 'INVALID_LABEL' 'Invalid native volume label.'
    Assert-Backend ($null -eq $nativeOptions.quickFormat -or $nativeOptions.quickFormat -is [bool]) 'INVALID_NATIVE_OPTIONS' 'quickFormat must be a boolean when present.'
    if ($nativeOperation -eq 'format') {
        Assert-Backend ($nativeOptions.filesystem -cne 'auto' -and $nativeOptions.targetSystem -ceq 'auto' -and $nativeOptions.quickFormat -is [bool]) 'INVALID_NATIVE_OPTIONS' 'Format-only requires an explicit filesystem and non-bootable target.'
        Assert-Backend (-not ($nativeOptions.filesystem -ceq 'fat32' -and $size -gt 32GB -and -not $nativeOptions.quickFormat)) 'LARGE_FAT32_QUICK_REQUIRED' 'Large FAT32 supports quick formatting only.'
    } elseif ($request.mode -ceq 'dd') {
        Assert-Backend ($nativeOptions.filesystem -ceq 'auto' -and $nativeOptions.partitionScheme -ceq 'auto' -and $nativeOptions.targetSystem -ceq 'auto' -and $nativeOptions.clusterSize -ceq 'auto' -and $null -eq $nativeOptions.volumeLabel -and $null -eq $nativeOptions.quickFormat) 'DD_OPTIONS_INAPPLICABLE' 'DD writes use image-defined format options.'
    }
    $inventory = Get-DeviceInventory
    $targets = @($inventory.devices | Where-Object number -eq $number)
    Assert-Backend ($targets.Count -eq 1) 'DEVICE_NOT_FOUND' 'The USB device is not present.'
    $target = $targets[0]
    Assert-Backend ($target.eligible) 'DEVICE_NOT_ELIGIBLE' 'The target is not a writable non-system USB device with verified identity.'
    Assert-Backend ($target.size -eq $size -and $target.serial -ceq $request.serial) 'DEVICE_IDENTITY_CHANGED' 'The USB identity or capacity changed after preparation.'
    if ($request.PSObject.Properties.Name -contains 'identity') {
        Assert-Backend ($request.identity -is [string] -and $target.identity -ceq $request.identity) 'DEVICE_IDENTITY_CHANGED' 'The USB fingerprint changed after preparation.'
    }
    if ($nativeOperation -eq 'image') {
    $imageVolume = [HuaiDJ.RufusBridge.NativeStorage]::FinalFileVolume($imagePath)
    $sourcePartitions = @(Get-Partition -ErrorAction Stop | Where-Object { $_.AccessPaths -contains $imageVolume })
    Assert-Backend ($sourcePartitions.Count -eq 1) 'SOURCE_VOLUME_UNKNOWN' 'The image source volume could not be mapped to one physical disk.'
    Assert-Backend ($sourcePartitions[0].DiskNumber -ne $number) 'SOURCE_ON_TARGET' 'The source image must not reside on the USB device being erased.'
    $currentHash = (Get-FileHash -LiteralPath $imagePath -Algorithm SHA256).Hash
    Assert-Backend ($currentHash -ieq $request.imageSHA256) 'IMAGE_IDENTITY_CHANGED' 'The image checksum changed after preparation.'
    }
    $nativePath = Join-Path $projectRoot 'bin\rufus-huaidj.exe'
    Assert-Backend (Test-Path -LiteralPath $nativePath -PathType Leaf) 'ENGINE_UNAVAILABLE' 'The Rufus automation engine is not installed.'
    Assert-NoReparsePath $nativePath $projectRoot
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $nativePath
    $startInfo.UseShellExecute = $true
    $startInfo.Verb = 'runas'
    $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $startInfo.WorkingDirectory = $projectRoot
    . (Join-Path $PSScriptRoot 'native-arguments.ps1')
    $nativeArguments = @(Get-HuaiDJNativeArguments -NativeOperation $nativeOperation -Request $request -Options $nativeOptions -StatusFile $statusFile -ImagePath $imagePath)
    foreach ($arg in $nativeArguments) {
        $startInfo.ArgumentList.Add($arg)
    }
    try { $engine = [Diagnostics.Process]::Start($startInfo) } catch {
        $cause = $_.Exception
        while ($cause.InnerException) { $cause = $cause.InnerException }
        if ($cause -is [ComponentModel.Win32Exception] -and $cause.NativeErrorCode -eq 1223) {
            Assert-Backend $false 'ELEVATION_CANCELLED' 'Windows administrator approval was cancelled.'
        }
        throw
    }
    Assert-Backend ($null -ne $engine) 'ENGINE_START_FAILED' 'Windows did not return an engine process.'
    return [pscustomobject]@{ started = $true; pid = $engine.Id; dryRun = [bool]$request.dryRun; deviceNumber = $number; statusPath = $statusFile }
}

try {
    Assert-Backend ($PSVersionTable.PSVersion.Major -ge 7) 'POWERSHELL_VERSION' 'PowerShell 7 or newer is required.'
    Assert-Backend ([OperatingSystem]::IsWindows()) 'WINDOWS_REQUIRED' 'This backend requires Windows.'
    if ($Operation -eq 'Devices') { Write-JsonResult (Get-DeviceInventory) }
    else { Write-JsonResult (Start-RufusEngine) }
} catch {
    $code = if ($_.Exception.Data['Code']) { [string]$_.Exception.Data['Code'] } else { 'BACKEND_ERROR' }
    $message = if ($code -eq 'BACKEND_ERROR') { 'The Windows storage operation failed. Check device connectivity and local permissions.' } else { $_.Exception.Message }
    Write-JsonResult ([ordered]@{ error = $code; message = $message; started = $false })
    exit 1
}
