[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Capabilities', 'Details', 'StartJob', 'RunJob', 'VerifyImage')]
    [string]$Operation,
    [int]$DeviceNumber = -1,
    [string]$RequestPath,
    [string]$RequestSHA256
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$jobsRoot = Join-Path $projectRoot 'state\jobs'
$statusPath = $null
$ownsJob = $false

function Assert-Disk($Condition, [string]$Code, [string]$Message) {
    if (-not $Condition) {
        $errorValue = [InvalidOperationException]::new($Message)
        $errorValue.Data['Code'] = $Code
        throw $errorValue
    }
}

function Write-DiskJson($Value) {
    [Console]::Out.WriteLine(($Value | ConvertTo-Json -Depth 14 -Compress))
}

function Test-IsAdministrator {
    return ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Initialize-DiskInterop {
    if ('HuaiDJ.DiskToolkit.Storage' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace HuaiDJ.DiskToolkit {
    public sealed class Descriptor {
        public string Serial { get; set; }
        public int BusType { get; set; }
    }
    public static class Storage {
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        private static extern SafeFileHandle CreateFileW(string path, uint access, uint share,
            IntPtr security, uint creation, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError=true)]
        private static extern bool DeviceIoControl(SafeFileHandle handle, uint control, byte[] input,
            uint inputSize, byte[] output, uint outputSize, out uint returned, IntPtr overlapped);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint size, uint flags);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        private static extern bool GetVolumePathNameW(string fileName, StringBuilder volumePath, uint length);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        private static extern bool GetVolumeNameForVolumeMountPointW(string mount, StringBuilder name, uint size);

        private static Descriptor DescriptorFromHandle(SafeFileHandle handle) {
            byte[] query=new byte[12], buffer=new byte[65536]; uint returned;
            if (!DeviceIoControl(handle, 0x002D1400, query, (uint)query.Length, buffer,
                (uint)buffer.Length, out returned, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (returned<36) throw new InvalidDataException("Storage descriptor is incomplete.");
            uint size=BitConverter.ToUInt32(buffer,4), offset=BitConverter.ToUInt32(buffer,24);
            int limit=(int)Math.Min(returned,Math.Min(size,(uint)buffer.Length)); string serial="";
            if(offset>0 && offset<limit) {
                int end=(int)offset; while(end<limit && buffer[end]!=0) end++;
                if(end==limit) throw new InvalidDataException("Storage serial is unterminated.");
                serial=Encoding.ASCII.GetString(buffer,(int)offset,end-(int)offset);
            }
            return new Descriptor { Serial=serial, BusType=BitConverter.ToInt32(buffer,28) };
        }
        public static Descriptor GetDescriptor(int number) {
            using (var handle = CreateFileW(@"\\.\PhysicalDrive"+number, 0, 3, IntPtr.Zero, 3, 0, IntPtr.Zero)) {
                if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
                return DescriptorFromHandle(handle);
            }
        }
        public static string MutexName(int number, string serial) {
            ulong hash=14695981039346656037UL;
            foreach(byte value in Encoding.ASCII.GetBytes(serial)) { hash ^= value; hash=unchecked(hash*1099511628211UL); }
            return @"Global\HuaiDJ_Rufus_USB_"+number+"_"+hash.ToString("x16");
        }
        public static FileStream OpenSource(string path) {
            return new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 4*1024*1024, FileOptions.SequentialScan);
        }
        public static string SourceVolume(FileStream source) {
            var final=new StringBuilder(32768);
            uint count=GetFinalPathNameByHandleW(source.SafeFileHandle, final, (uint)final.Capacity, 0);
            if(count==0 || count>=final.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error());
            if(final.ToString().StartsWith(@"\\?\UNC\",StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Network image paths are unsupported.");
            var mount=new StringBuilder(32768);
            if(!GetVolumePathNameW(final.ToString(),mount,(uint)mount.Capacity)) throw new Win32Exception(Marshal.GetLastWin32Error());
            var volume=new StringBuilder(1024);
            if(!GetVolumeNameForVolumeMountPointW(mount.ToString(),volume,(uint)volume.Capacity)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return volume.ToString();
        }
        public static string HashSource(FileStream source, Action<long,long> progress) {
            source.Position=0;
            using(var hash=IncrementalHash.CreateHash(HashAlgorithmName.SHA256)) {
                byte[] buffer=new byte[4*1024*1024]; long done=0,total=source.Length; int read;
                while((read=source.Read(buffer,0,buffer.Length))>0) { hash.AppendData(buffer,0,read); done+=read; if(progress!=null) progress(done,total); }
                source.Position=0;
                return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
            }
        }
        public static string HashPhysicalPrefix(int number, long bytes, int sectorSize, long expectedSize, string expectedSerial, Action<long,long> progress) {
            if(bytes<=0 || sectorSize<512 || sectorSize>65536) throw new ArgumentOutOfRangeException();
            var handle=CreateFileW(@"\\.\PhysicalDrive"+number, 0x80000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
            if(handle.IsInvalid) { handle.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error()); }
            using(var stream=new FileStream(handle,FileAccess.Read,4*1024*1024,false))
            using(var hash=IncrementalHash.CreateHash(HashAlgorithmName.SHA256)) {
                var descriptor=DescriptorFromHandle(stream.SafeFileHandle);
                byte[] length=new byte[8]; uint returned;
                if(!DeviceIoControl(stream.SafeFileHandle,0x0007405C,null,0,length,8,out returned,IntPtr.Zero))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                if(returned<8 || BitConverter.ToInt64(length,0)!=expectedSize ||
                    !String.Equals(descriptor.Serial,expectedSerial,StringComparison.Ordinal))
                    throw new InvalidDataException("The opened physical device identity changed.");
                byte[] buffer=new byte[4*1024*1024]; long done=0;
                while(done<bytes) {
                    int wanted=(int)Math.Min(buffer.Length,bytes-done);
                    int aligned=((wanted+sectorSize-1)/sectorSize)*sectorSize;
                    int actual=0;
                    while(actual<aligned) {
                        int read=stream.Read(buffer,actual,aligned-actual);
                        if(read==0) throw new EndOfStreamException("Physical device ended before the image prefix.");
                        actual+=read;
                    }
                    hash.AppendData(buffer,0,wanted); done+=wanted; if(progress!=null) progress(done,bytes);
                }
                return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
            }
        }
    }
}
'@ | Out-Null
}

function Get-DiskIdentity($Disk) {
    Initialize-DiskInterop
    $descriptor = [HuaiDJ.DiskToolkit.Storage]::GetDescriptor([int]$Disk.Number)
    $serial = [string]$descriptor.Serial
    $identity = $null
    if (-not [string]::IsNullOrWhiteSpace($serial)) {
        $identityText = [string]$Disk.FriendlyName + [char]0 + $serial + [char]0 + ([uint64]$Disk.Size).ToString([Globalization.CultureInfo]::InvariantCulture)
        $identity = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($identityText))).ToLowerInvariant()
    }
    return [pscustomobject]@{ serial = $serial; identity = $identity; descriptorBusType = [int]$descriptor.BusType }
}

function Get-VolumeSupportedFormats($Volume) {
    try {
        return [pscustomobject]@{ filesystems = @(Get-SupportedFileSystems -InputObject $Volume -ErrorAction Stop); queried = $true; scope = 'storage-provider-advisory'; error = $null }
    } catch { return [pscustomobject]@{ filesystems = @(); queried = $false; scope = 'storage-provider-advisory'; error = 'VOLUME_CAPABILITY_QUERY_UNAVAILABLE' } }
}

function Get-DiskDetails {
    $disks = if ($DeviceNumber -ge 0) { @(Get-Disk -Number $DeviceNumber) } else { @(Get-Disk | Sort-Object Number) }
    $items = @(
        foreach ($disk in $disks) {
            $identity = $null
            try { $identity = Get-DiskIdentity $disk } catch {}
            $partitions = @(
                foreach ($partition in @(Get-Partition -DiskNumber $disk.Number -ErrorAction SilentlyContinue)) {
                    $volume = $null
                    try { $volume = $partition | Get-Volume -ErrorAction Stop } catch {}
                    [pscustomobject]@{
                        number = [int]$partition.PartitionNumber; size = [uint64]$partition.Size; offset = [uint64]$partition.Offset
                        driveLetter = if ($partition.DriveLetter -and [int][char]$partition.DriveLetter -gt 0) { [string]$partition.DriveLetter } else { $null }
                        type = [string]$partition.Type; gptType = [string]$partition.GptType
                        isBoot = [bool]$partition.IsBoot; isSystem = [bool]$partition.IsSystem; isActive = [bool]$partition.IsActive
                        volume = if ($volume) { [pscustomobject]@{ filesystem = [string]$volume.FileSystem; label = [string]$volume.FileSystemLabel; size = [uint64]$volume.Size; free = [uint64]$volume.SizeRemaining; health = [string]$volume.HealthStatus; supportedFormats = Get-VolumeSupportedFormats $volume } } else { $null }
                    }
                }
            )
            [pscustomobject]@{
                number = [int]$disk.Number; model = [string]$disk.FriendlyName; size = [uint64]$disk.Size; busType = [string]$disk.BusType
                partitionStyle = [string]$disk.PartitionStyle; logicalSectorSize = [int]$disk.LogicalSectorSize; physicalSectorSize = [int]$disk.PhysicalSectorSize
                isBoot = [bool]$disk.IsBoot; isSystem = [bool]$disk.IsSystem; isReadOnly = [bool]$disk.IsReadOnly; isOffline = [bool]$disk.IsOffline
                serial = if ($identity) { $identity.serial } else { $null }; identity = if ($identity) { $identity.identity } else { $null }
                descriptorBusType = if ($identity) { $identity.descriptorBusType } else { $null }; partitions = $partitions
            }
        }
    )
    return [pscustomobject]@{ disks = $items; version = 1 }
}

function Get-DiskCapabilities {
    $formatValues = @((Get-Command Format-Volume).Parameters['FileSystem'].Attributes | Where-Object { $_ -is [Management.Automation.ValidateSetAttribute] } | ForEach-Object ValidValues)
    $formatCommand = Join-Path ([Environment]::GetFolderPath('System')) 'format.com'
    $formatHelp = if (Test-Path -LiteralPath $formatCommand) { (& $formatCommand /? | Out-String) } else { '' }
    $systems = @(
        foreach ($name in @('FAT', 'FAT32', 'NTFS', 'exFAT', 'ReFS', 'UDF')) {
            $advertised = if ($name -eq 'UDF') { $formatHelp -match '\bUDF\b' -and $formatHelp -match '/Y\b' } else { $formatValues -contains $name }
            [pscustomobject]@{
                name = $name; runtimeAdvertised = [bool]$advertised
                backend = if ($name -eq 'UDF') { 'Windows format.com /Y' } else { 'Storage Format-Volume' }
                usbWriteAllowed = [bool]($advertised -and $name -ne 'ReFS')
                limitation = if ($name -eq 'ReFS') { 'ReFS on removable/external USB media is unsupported by Microsoft and is refused.' } else { 'Storage-provider format listings are advisory; the actual Windows formatting result and filesystem readback determine success.' }
            }
        }
    )
    return [pscustomobject]@{
        platform = 'Windows'; filesystems = $systems; partitionStyles = @('GPT', 'MBR')
        operations = @('verify-image', 'format-volume', 'initialize-usb'); defaultWritableBus = 'USB'
        activeBootOrSystemWritable = $false; internalPhysicalDiskWrites = $false
        readback = 'SHA-256 of the exact physical-device prefix matching the locked source-image length'
        elevation = 'Windows administrator approval is required for raw device access and formatting.'
        sources = @('https://learn.microsoft.com/en-us/windows-hardware/drivers/storage/msft-volume-getsupportedfilesystems', 'https://learn.microsoft.com/en-us/powershell/module/storage/format-volume', 'https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/format', 'https://learn.microsoft.com/en-us/windows-server/storage/refs/refs-overview')
    }
}

function Assert-OrdinaryPath([string]$Path, [string]$StopAt) {
    $current = [IO.Path]::GetFullPath($Path)
    $stop = [IO.Path]::GetFullPath($StopAt).TrimEnd('\')
    while ($true) {
        if (Test-Path -LiteralPath $current) {
            Assert-Disk (((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'REPARSE_JOB_PATH' 'Job and helper paths must not contain reparse points.'
        }
        if ($current.TrimEnd('\').Equals($stop, [StringComparison]::OrdinalIgnoreCase)) { break }
        $parent = [IO.Path]::GetDirectoryName($current.TrimEnd('\'))
        Assert-Disk (-not [string]::IsNullOrEmpty($parent)) 'INVALID_JOB_PATH' 'The job path escaped its root.'
        $current = $parent
    }
}

function Read-DiskRequest {
    Assert-Disk (-not [string]::IsNullOrWhiteSpace($RequestPath)) 'REQUEST_REQUIRED' 'RequestPath is required.'
    $file = [IO.Path]::GetFullPath($RequestPath)
    $rootPrefix = [IO.Path]::GetFullPath($jobsRoot).TrimEnd('\') + '\'
    Assert-Disk ($file.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) 'INVALID_JOB_PATH' 'The request must be inside this project jobs directory.'
    Assert-Disk ($file.Substring($rootPrefix.Length) -match '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}\\disk-request\.json$') 'INVALID_JOB_PATH' 'Use one job UUID and disk-request.json.'
    Assert-Disk (Test-Path -LiteralPath $file -PathType Leaf) 'REQUEST_NOT_FOUND' 'The disk job request does not exist.'
    Assert-OrdinaryPath $file $projectRoot
    Assert-Disk ((Get-Item -LiteralPath $file).Length -le 32768) 'INVALID_REQUEST' 'The disk job request is too large.'
    $request = Get-Content -LiteralPath $file -Raw -Encoding utf8 | ConvertFrom-Json
    foreach ($field in @('operation', 'deviceNumber', 'size', 'serial', 'identity', 'confirm')) {
        Assert-Disk ($request.PSObject.Properties.Name -contains $field) 'INVALID_REQUEST' ('Missing required field: ' + $field)
    }
    Assert-Disk ($request.operation -is [string] -and $request.operation -cin @('verify-image', 'format-volume', 'initialize-usb')) 'INVALID_OPERATION' 'The disk operation is unsupported.'
    Assert-Disk (($request.deviceNumber -is [int] -or $request.deviceNumber -is [long]) -and $request.deviceNumber -ge 0 -and $request.deviceNumber -le 1023) 'INVALID_REQUEST' 'deviceNumber must identify a physical disk.'
    Assert-Disk (($request.size -is [int] -or $request.size -is [long] -or $request.size -is [uint64]) -and $request.size -gt 0) 'INVALID_REQUEST' 'The exact physical disk size is required.'
    Assert-Disk ($request.serial -is [string] -and -not [string]::IsNullOrWhiteSpace($request.serial) -and $request.serial.Length -le 1024 -and $request.serial -notmatch '[\x00-\x1f]') 'INVALID_REQUEST' 'The exact storage serial is required.'
    Assert-Disk ($request.identity -is [string] -and $request.identity -match '^[a-fA-F0-9]{64}$') 'INVALID_REQUEST' 'A complete physical-device identity is required.'
    $confirmationType = if ($request.operation -eq 'verify-image') { 'VERIFY' } else { 'ERASE' }
    $expected = $confirmationType + ':' + $request.deviceNumber + ':' + $request.size
    Assert-Disk ($request.confirm -is [string] -and $request.confirm -ceq $expected) 'CONFIRMATION_MISMATCH' ('The exact ' + $confirmationType + ' physical-device confirmation is required.')
    if ($request.operation -eq 'verify-image') {
        Assert-Disk ($request.imagePath -is [string] -and $request.imagePath -match '^[A-Za-z]:[\\/]' -and $request.imagePath.Substring(2) -notmatch ':') 'INVALID_IMAGE_PATH' 'The source must be a local absolute image path without alternate data streams.'
        Assert-Disk ($request.imageSHA256 -is [string] -and $request.imageSHA256 -match '^[a-fA-F0-9]{64}$') 'INVALID_REQUEST' 'The complete expected source SHA-256 is required.'
        Assert-Disk (Test-Path -LiteralPath $request.imagePath -PathType Leaf) 'IMAGE_NOT_FOUND' 'The source image does not exist.'
    } else {
        Assert-Disk ($request.filesystem -is [string] -and $request.filesystem -cin @('FAT', 'FAT32', 'NTFS', 'exFAT', 'ReFS', 'UDF')) 'INVALID_FILESYSTEM' 'Select an explicitly supported Windows filesystem.'
        Assert-Disk ($request.filesystem -cne 'ReFS') 'REFS_USB_UNSUPPORTED' 'ReFS is not supported on removable/external USB media.'
        Assert-Disk ($request.label -is [string] -and $request.label.Length -le 32 -and $request.label -notmatch '[\x00-\x1f\\/:*?"<>|]') 'INVALID_LABEL' 'The volume label contains unsupported characters or is too long.'
        Assert-Disk ($request.label -ceq $request.label.Trim()) 'INVALID_LABEL' 'Leading or trailing spaces are not accepted in volume labels.'
        Assert-Disk ($request.quick -is [bool]) 'INVALID_REQUEST' 'quick must be an explicit boolean.'
        if ($request.operation -eq 'format-volume') {
            Assert-Disk (($request.partitionNumber -is [int] -or $request.partitionNumber -is [long]) -and $request.partitionNumber -gt 0 -and $request.partitionNumber -le 1024) 'INVALID_REQUEST' 'A partition number is required for volume formatting.'
            foreach ($field in @('partitionOffset', 'partitionSize')) {
                Assert-Disk (($request.$field -is [int] -or $request.$field -is [long] -or $request.$field -is [uint64]) -and $request.$field -ge 0) 'INVALID_REQUEST' ('The prepared ' + $field + ' is required.')
            }
        } else {
            Assert-Disk ($request.partitionStyle -is [string] -and $request.partitionStyle -cin @('GPT', 'MBR')) 'INVALID_PARTITION_STYLE' 'partitionStyle must be GPT or MBR.'
        }
        if ($request.PSObject.Properties.Name -contains 'allocationUnitSize') {
            Assert-Disk (($request.allocationUnitSize -is [int] -or $request.allocationUnitSize -is [long]) -and $request.allocationUnitSize -ge 512 -and $request.allocationUnitSize -le 33554432 -and (($request.allocationUnitSize -band ($request.allocationUnitSize - 1)) -eq 0)) 'INVALID_ALLOCATION_UNIT' 'The allocation unit must be a supported power-of-two byte size.'
        }
    }
    return [pscustomobject]@{ request = $request; file = $file; directory = [IO.Path]::GetDirectoryName($file); hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() }
}

function Assert-CurrentTarget($Request) {
    $disk = Get-Disk -Number ([int]$Request.deviceNumber) -ErrorAction Stop
    $partitions = @(Get-Partition -DiskNumber $disk.Number -ErrorAction SilentlyContinue)
    Assert-Disk (-not $disk.IsBoot -and -not $disk.IsSystem -and @($partitions | Where-Object { $_.IsBoot -or $_.IsSystem }).Count -eq 0) 'SYSTEM_DISK_REFUSED' 'An active boot or system disk cannot be a target.'
    if ($Request.PSObject.Properties.Name -contains 'fixturePath') {
        $identity = Assert-OwnedFixture $Request $disk
    } else {
        $identity = Get-DiskIdentity $disk
        Assert-Disk ($disk.BusType.ToString() -eq 'USB' -and $identity.descriptorBusType -eq 7) 'INTERNAL_WRITES_UNSUPPORTED' 'This operation is restricted to USB devices.'
    }
    Assert-Disk (-not $disk.IsOffline -and (-not $disk.IsReadOnly -or $Request.operation -eq 'verify-image')) 'DEVICE_NOT_WRITABLE' 'The target is offline or read-only.'
    Assert-Disk ([uint64]$disk.Size -eq [uint64]$Request.size -and $identity.serial -ceq $Request.serial -and $identity.identity -ieq $Request.identity) 'DEVICE_IDENTITY_CHANGED' 'The physical USB identity or size changed after preparation.'
    return $disk
}

function Assert-OwnedFixture($Request, $Disk) {
    Assert-Disk ($Request.fixturePath -is [string] -and $Request.fixtureToken -is [string] -and $Request.fixtureToken -match '^[a-fA-F0-9]{64}$') 'INVALID_FIXTURE' 'The fixture image path and token are required.'
    $fixture = [IO.Path]::GetFullPath($Request.fixturePath)
    $fixtureRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'state\fixtures')).TrimEnd('\') + '\'
    Assert-Disk ($fixture.StartsWith($fixtureRoot, [StringComparison]::OrdinalIgnoreCase) -and $fixture.Substring($fixtureRoot.Length) -match '^[a-fA-F0-9-]{36}\\disk\.vhdx$') 'INVALID_FIXTURE' 'Only an owned test VHDX inside project state/fixtures is accepted.'
    Assert-OrdinaryPath $fixture $projectRoot
    $manifestPath = Join-Path ([IO.Path]::GetDirectoryName($fixture)) 'fixture-manifest.json'
    Assert-OrdinaryPath $manifestPath $projectRoot
    Assert-Disk (Test-Path -LiteralPath $manifestPath -PathType Leaf) 'INVALID_FIXTURE' 'The owned VHD fixture manifest is missing.'
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding utf8 | ConvertFrom-Json
    Assert-Disk ($manifest.token -ceq $Request.fixtureToken -and [IO.Path]::GetFullPath([string]$manifest.imagePath).Equals($fixture, [StringComparison]::OrdinalIgnoreCase)) 'INVALID_FIXTURE' 'The fixture manifest does not match the request.'
    Assert-Disk ($Disk.Size -le 2GB -and $Disk.Size -eq $manifest.virtualSize -and (Get-Item -LiteralPath $fixture).CreationTimeUtc.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) -ceq [string]$manifest.imageCreationTicks) 'INVALID_FIXTURE' 'The test fixture identity or maximum size changed.'
    $image = Get-DiskImage -ImagePath $fixture -ErrorAction Stop
    Assert-Disk ($image.Attached -and ([string]$image.DevicePath).Equals(('\\.\PhysicalDrive' + $Disk.Number), [StringComparison]::OrdinalIgnoreCase)) 'INVALID_FIXTURE' 'The selected disk is not the attached owned VHD fixture.'
    Assert-Disk ($Disk.BusType.ToString() -in @('File Backed Virtual', 'FileBackedVirtual', 'Virtual', 'SCSI')) 'INVALID_FIXTURE' 'The fixture target is not a virtual disk bus.'
    $serial = 'VHD:' + [string]$manifest.fixtureId
    $text = [string]$Disk.FriendlyName + [char]0 + $serial + [char]0 + ([uint64]$Disk.Size).ToString([Globalization.CultureInfo]::InvariantCulture)
    $fingerprint = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($text))).ToLowerInvariant()
    return [pscustomobject]@{ serial = $serial; identity = $fingerprint; descriptorBusType = -1 }
}

function Assert-JobOffTarget($Context, $Disk) {
    $source = [HuaiDJ.DiskToolkit.Storage]::OpenSource($Context.file)
    try {
        $volume = [HuaiDJ.DiskToolkit.Storage]::SourceVolume($source)
        $parts = @(Get-Partition | Where-Object { $_.AccessPaths -contains $volume })
        Assert-Disk ($parts.Count -eq 1 -and $parts[0].DiskNumber -ne $Disk.Number) 'JOB_STORE_ON_TARGET_OR_UNKNOWN' 'Job files and the local helper must not reside on the disk being changed.'
    } finally { $source.Dispose() }
}

function Get-PreparedVolume($Request) {
    $partition = Get-Partition -DiskNumber ([int]$Request.deviceNumber) -PartitionNumber ([int]$Request.partitionNumber) -ErrorAction Stop
    Assert-Disk (-not $partition.IsBoot -and -not $partition.IsSystem -and [uint64]$partition.Offset -eq [uint64]$Request.partitionOffset -and [uint64]$partition.Size -eq [uint64]$Request.partitionSize) 'PARTITION_IDENTITY_CHANGED' 'The target partition changed after preparation.'
    $volumes = @($partition | Get-Volume -ErrorAction Stop)
    Assert-Disk ($volumes.Count -eq 1) 'VOLUME_NOT_FOUND' 'The selected partition must expose one Windows volume.'
    return [pscustomobject]@{ partition = $partition; volume = $volumes[0] }
}

function Assert-FormatOptions($Request, $Volume = $null) {
    $capabilities = Get-DiskCapabilities
    $capability = $capabilities.filesystems | Where-Object name -ceq $Request.filesystem | Select-Object -First 1
    Assert-Disk ($capability -and $capability.runtimeAdvertised -and $capability.usbWriteAllowed) 'FILESYSTEM_UNAVAILABLE' 'The requested filesystem is not available through the enabled Windows backend.'
    $maximumLabel = switch -CaseSensitive ($Request.filesystem) { 'FAT' { 11 } 'FAT32' { 11 } 'exFAT' { 15 } default { 32 } }
    Assert-Disk ($Request.label.Length -le $maximumLabel) 'INVALID_LABEL' 'The requested label is too long for this filesystem.'
    if ($Volume -and $Request.filesystem -ne 'UDF') {
        $support = Get-VolumeSupportedFormats $Volume
        $script:lastProviderFormatSupport = $support
    }
}

function Invoke-FormatVolumeExact($Context, $Volume) {
    $request = $Context.request
    Assert-FormatOptions $request $Volume
    Write-DiskStatus 'formatting-volume' 0 $false $false 'Formatting the explicitly selected Windows volume.' @{ operation = $request.operation; filesystem = $request.filesystem; deviceNumber = $request.deviceNumber; storageProviderAdvertised = [bool]($script:lastProviderFormatSupport -and $script:lastProviderFormatSupport.filesystems -icontains $request.filesystem) }
    if ($request.filesystem -eq 'UDF') {
        $formatter = Join-Path ([Environment]::GetFolderPath('System')) 'format.com'
        $start = [Diagnostics.ProcessStartInfo]::new()
        $start.FileName = $formatter; $start.UseShellExecute = $false; $start.CreateNoWindow = $true
        $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
        $formatterEncoding = [Text.Encoding]::GetEncoding([Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage)
        $start.StandardOutputEncoding = $formatterEncoding; $start.StandardErrorEncoding = $formatterEncoding
        foreach ($argument in @(([string]$Volume.Path).TrimEnd('\'), '/FS:UDF', '/Y', '/X', ('/V:' + $request.label))) { $start.ArgumentList.Add($argument) }
        if ($request.quick) { $start.ArgumentList.Add('/Q') }
        if ($request.PSObject.Properties.Name -contains 'allocationUnitSize') { $start.ArgumentList.Add('/A:' + $request.allocationUnitSize) }
        $child = [Diagnostics.Process]::Start($start)
        $stdout = $child.StandardOutput.ReadToEndAsync(); $stderr = $child.StandardError.ReadToEndAsync()
        $child.WaitForExit()
        [IO.File]::WriteAllText((Join-Path $Context.directory 'format-command.stdout.log'), $stdout.GetAwaiter().GetResult(), [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText((Join-Path $Context.directory 'format-command.stderr.log'), $stderr.GetAwaiter().GetResult(), [Text.UTF8Encoding]::new($false))
        Assert-Disk ($child.ExitCode -eq 0) 'WINDOWS_FORMAT_FAILED' 'The Windows UDF formatter refused the selected volume. See this job local format logs.'
    } else {
        $arguments = @{ InputObject = $Volume; FileSystem = [string]$request.filesystem; NewFileSystemLabel = [string]$request.label; Force = $true; Confirm = $false; ErrorAction = 'Stop' }
        if (-not $request.quick) { $arguments.Full = $true }
        if ($request.PSObject.Properties.Name -contains 'allocationUnitSize') { $arguments.AllocationUnitSize = [uint32]$request.allocationUnitSize }
        Format-Volume @arguments | Out-Null
    }
}

function Invoke-DiskFormat($Context, $Disk) {
    $request = $Context.request
    Assert-JobOffTarget $Context $Disk
    Assert-FormatOptions $request
    if ($request.operation -eq 'format-volume') {
        $selected = Get-PreparedVolume $request
        Invoke-FormatVolumeExact $Context $selected.volume
        $partition = $selected.partition
    } else {
        if ($request.partitionStyle -eq 'MBR') { Assert-Disk ([uint64]$disk.Size -le 2TB) 'MBR_CAPACITY_UNSUPPORTED' 'This adapter uses GPT for devices larger than 2 TiB.' }
        if ($request.filesystem -eq 'FAT') { Assert-Disk ([uint64]$disk.Size -le 4GB) 'FAT_CAPACITY_UNSUPPORTED' 'Use FAT only for USB capacities at most 4 GiB.' }
        Write-DiskStatus 'rebuilding-partition-table' 0 $false $false 'Rebuilding the explicitly confirmed USB partition table.' @{ operation = $request.operation; partitionStyle = $request.partitionStyle; deviceNumber = $request.deviceNumber }
        $null = Assert-CurrentTarget $request
        $disk = Assert-CurrentTarget $request
        if ($disk.PartitionStyle.ToString() -ne 'RAW') { Clear-Disk -InputObject $disk -RemoveData -RemoveOEM -Confirm:$false -ErrorAction Stop | Out-Null }
        $disk = Assert-CurrentTarget $request
        Initialize-Disk -InputObject $disk -PartitionStyle $request.partitionStyle -ErrorAction Stop | Out-Null
        $disk = Assert-CurrentTarget $request
        $partition = New-Partition -InputObject $disk -UseMaximumSize -AssignDriveLetter -ErrorAction Stop
        $volume = $partition | Get-Volume -ErrorAction Stop
        Invoke-FormatVolumeExact $Context $volume
    }
    $freshPartition = Get-Partition -DiskNumber $disk.Number -PartitionNumber $partition.PartitionNumber
    $freshVolume = $freshPartition | Get-Volume -ErrorAction Stop
    Assert-Disk ($freshVolume.FileSystem -ieq $request.filesystem) 'FILESYSTEM_READBACK_MISMATCH' 'The volume filesystem after formatting does not match the request.'
    Assert-Disk ($freshVolume.FileSystemLabel -ieq $request.label) 'LABEL_READBACK_MISMATCH' 'The volume label after formatting does not match the request.'
    if ($request.PSObject.Properties.Name -contains 'allocationUnitSize') {
        Assert-Disk ([uint64]$freshVolume.AllocationUnitSize -eq [uint64]$request.allocationUnitSize) 'ALLOCATION_UNIT_READBACK_MISMATCH' 'The formatted allocation unit does not match the request.'
    }
    Write-DiskStatus 'formatted' 100 $true $true 'The requested filesystem and partition metadata were read back successfully.' @{ operation = $request.operation; deviceNumber = [int]$disk.Number; partitionNumber = [int]$freshPartition.PartitionNumber; partitionOffset = [uint64]$freshPartition.Offset; partitionSize = [uint64]$freshPartition.Size; filesystem = [string]$freshVolume.FileSystem; label = [string]$freshVolume.FileSystemLabel; allocationUnitSize = [uint64]$freshVolume.AllocationUnitSize; partitionStyle = [string](Get-Disk -Number $disk.Number).PartitionStyle }
}

function Write-DiskStatus([string]$Phase, [int]$Progress, [bool]$Success, [bool]$Final, [string]$Message, $Extra = $null) {
    Assert-Disk (-not [string]::IsNullOrEmpty($script:statusPath)) 'INVALID_STATUS_PATH' 'No disk status path is bound.'
    $value = [ordered]@{ phase = $Phase; progress = $Progress; success = $Success; final = $Final; message = $Message; updatedUTC = [DateTime]::UtcNow.ToString('o') }
    if ($Extra) { foreach ($key in $Extra.Keys) { $value[$key] = $Extra[$key] } }
    $temporary = $script:statusPath + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    [IO.File]::WriteAllText($temporary, ($value | ConvertTo-Json -Depth 10 -Compress), [Text.UTF8Encoding]::new($false))
    [IO.File]::Move($temporary, $script:statusPath, $true)
}

function Start-DiskJob($Context) {
    Assert-Disk (-not (Test-Path -LiteralPath (Join-Path $Context.directory 'disk-run.lock'))) 'JOB_ALREADY_STARTED' 'This disk job has already run; prepare a new job instead of replaying it.'
    $null = Assert-CurrentTarget $Context.request
    if ($Context.request.operation -ne 'verify-image') {
        Assert-FormatOptions $Context.request
        if ($Context.request.operation -eq 'format-volume') { $prepared = Get-PreparedVolume $Context.request; Assert-FormatOptions $Context.request $prepared.volume }
    }
    $script:statusPath = Join-Path $Context.directory 'status.json'
    Assert-OrdinaryPath $script:statusPath $projectRoot
    $startRecord = Join-Path $Context.directory 'disk-started.json'
    try { $record = [IO.FileStream]::new($startRecord, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None) }
    catch { Assert-Disk $false 'JOB_ALREADY_STARTED' 'This disk job has already been submitted; prepare a new job instead of replaying it.' }
    try { $bytes = [Text.Encoding]::UTF8.GetBytes('{"requestSHA256":"' + $Context.hash + '"}'); $record.Write($bytes, 0, $bytes.Length) } finally { $record.Dispose() }
    Write-DiskStatus 'awaiting-administrator' 0 $false $false 'Waiting for Windows administrator approval.' @{ operation = $Context.request.operation; deviceNumber = $Context.request.deviceNumber }
    $runtime = [Environment]::ProcessPath
    Assert-Disk (-not [string]::IsNullOrWhiteSpace($runtime) -and [IO.Path]::GetFileName($runtime).Equals('pwsh.exe', [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $runtime -PathType Leaf)) 'RUNTIME_UNAVAILABLE' 'The running PowerShell 7 executable could not be resolved.'
    Assert-OrdinaryPath $runtime ([IO.Path]::GetDirectoryName($runtime))
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $runtime; $start.UseShellExecute = $true; $start.Verb = 'runas'; $start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden; $start.WorkingDirectory = $projectRoot
    foreach ($argument in @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-Operation', 'RunJob', '-RequestPath', $Context.file, '-RequestSHA256', $Context.hash)) { $start.ArgumentList.Add($argument) }
    try { $child = [Diagnostics.Process]::Start($start) } catch {
        $cause = $_.Exception
        while ($cause.InnerException) { $cause = $cause.InnerException }
        $startError = if ($cause -is [ComponentModel.Win32Exception] -and $cause.NativeErrorCode -eq 1223) { 'ELEVATION_CANCELLED' } else { 'ELEVATION_OR_START_FAILED' }
        $startMessage = if ($startError -eq 'ELEVATION_CANCELLED') { 'Windows administrator approval was cancelled. No disk operation was started.' } else { 'Windows administrator approval or process startup did not complete.' }
        Write-DiskStatus 'error' 0 $false $true $startMessage @{ error = $startError }
        Assert-Disk $false $startError $startMessage
    }
    return [pscustomobject]@{ started = $true; pid = $child.Id; operation = $Context.request.operation; deviceNumber = $Context.request.deviceNumber; statusPath = $script:statusPath }
}

function Invoke-ImageReadback($Context, $Disk) {
    $request = $Context.request
    $source = [HuaiDJ.DiskToolkit.Storage]::OpenSource([IO.Path]::GetFullPath($request.imagePath))
    try {
        Assert-Disk ($source.Length -gt 0 -and [uint64]$source.Length -le [uint64]$disk.Size) 'IMAGE_SIZE_INVALID' 'The source image must fit on the selected USB.'
        $sourceVolume = [HuaiDJ.DiskToolkit.Storage]::SourceVolume($source)
        $sourcePartitions = @(Get-Partition | Where-Object { $_.AccessPaths -contains $sourceVolume })
        Assert-Disk ($sourcePartitions.Count -eq 1 -and $sourcePartitions[0].DiskNumber -ne $disk.Number) 'SOURCE_ON_TARGET_OR_UNKNOWN' 'The source image must map to a different known physical disk.'
        $script:lastProgress = -1
        $sourceProgress = [Action[long,long]]{
            param($done, $total)
            $percent = [int][Math]::Floor(100.0 * $done / $total)
            if ($percent -ge $script:lastProgress + 10) { $script:lastProgress = $percent; Write-DiskStatus 'hashing-source' $percent $false $false 'Hashing the locked source image.' @{ bytesProcessed = $done; bytesTotal = $total; operation = 'verify-image' } }
        }
        $sourceHash = [HuaiDJ.DiskToolkit.Storage]::HashSource($source, $sourceProgress)
        Assert-Disk ($sourceHash -ieq $request.imageSHA256) 'IMAGE_IDENTITY_CHANGED' 'The source image does not match the expected SHA-256.'
        $null = Assert-CurrentTarget $request
        $script:lastProgress = -1
        $deviceProgress = [Action[long,long]]{
            param($done, $total)
            $percent = [int][Math]::Floor(100.0 * $done / $total)
            if ($percent -ge $script:lastProgress + 5) { $script:lastProgress = $percent; Write-DiskStatus 'reading-physical-prefix' $percent $false $false 'Reading back the physical USB image prefix.' @{ bytesProcessed = $done; bytesTotal = $total; operation = 'verify-image' } }
        }
        $expectedRawSerial = if ($request.PSObject.Properties.Name -contains 'fixturePath') { ([HuaiDJ.DiskToolkit.Storage]::GetDescriptor([int]$disk.Number)).Serial } else { [string]$request.serial }
        $readbackHash = [HuaiDJ.DiskToolkit.Storage]::HashPhysicalPrefix([int]$disk.Number, $source.Length, [int]$disk.LogicalSectorSize, [long]$disk.Size, $expectedRawSerial, $deviceProgress)
        $matched = $sourceHash -ceq $readbackHash
        Write-DiskStatus $(if ($matched) { 'verified' } else { 'mismatch' }) 100 $matched $true $(if ($matched) { 'The physical USB prefix exactly matches the source image.' } else { 'The physical USB prefix does not match the source image.' }) @{ operation = 'verify-image'; deviceNumber = [int]$disk.Number; bytesTotal = $source.Length; sourceSHA256 = $sourceHash; readbackSHA256 = $readbackHash; error = $(if ($matched) { $null } else { 'READBACK_MISMATCH' }) }
    } finally { $source.Dispose() }
}

function Invoke-DiskRun($Context) {
    Assert-Disk (Test-IsAdministrator) 'ADMINISTRATOR_REQUIRED' 'Raw device verification and formatting require Windows administrator approval.'
    Assert-Disk ($RequestSHA256 -match '^[a-fA-F0-9]{64}$' -and $RequestSHA256 -ieq $Context.hash) 'REQUEST_IDENTITY_CHANGED' 'The disk request changed after approval.'
    $requestHandle = [IO.FileStream]::new($Context.file, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $mutex = $null; $hasMutex = $false
    try {
        $lockedHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($requestHandle)).ToLowerInvariant()
        Assert-Disk ($lockedHash -ceq $Context.hash) 'REQUEST_IDENTITY_CHANGED' 'The disk request changed before its read lock was acquired.'
        $script:statusPath = Join-Path $Context.directory 'status.json'
        Assert-OrdinaryPath $script:statusPath $projectRoot
        $runLock = Join-Path $Context.directory 'disk-run.lock'
        try { $marker = [IO.FileStream]::new($runLock, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None); $marker.Dispose() }
        catch { Assert-Disk $false 'JOB_ALREADY_STARTED' 'This disk job has already started; prepare a new job instead of replaying it.' }
        $script:ownsJob = $true
        Write-DiskStatus 'validating-device' 0 $false $false 'Validating the physical target and acquiring its shared device mutex.' @{ operation = $Context.request.operation }
        $disk = Assert-CurrentTarget $Context.request
        $mutexName = [HuaiDJ.DiskToolkit.Storage]::MutexName([int]$disk.Number, [string]$Context.request.serial)
        $mutex = [Threading.Mutex]::new($false, $mutexName)
        try { $hasMutex = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $hasMutex = $true }
        Assert-Disk $hasMutex 'USB_BUSY' 'Another native operation currently owns this USB.'
        $disk = Assert-CurrentTarget $Context.request
        if ($Context.request.operation -eq 'verify-image') { Invoke-ImageReadback $Context $disk }
        else { Invoke-DiskFormat $Context $disk }
    } finally {
        if ($hasMutex -and $mutex) { $mutex.ReleaseMutex() }
        if ($mutex) { $mutex.Dispose() }
        $requestHandle.Dispose()
    }
}

try {
    Assert-Disk ([OperatingSystem]::IsWindows() -and $PSVersionTable.PSVersion.Major -ge 7) 'WINDOWS_POWERSHELL7_REQUIRED' 'This adapter requires Windows and PowerShell 7.'
    Initialize-DiskInterop
    switch ($Operation) {
        'Capabilities' { Write-DiskJson (Get-DiskCapabilities) }
        'Details' { Write-DiskJson (Get-DiskDetails) }
        'StartJob' { Write-DiskJson (Start-DiskJob (Read-DiskRequest)) }
        'VerifyImage' {
            $context = Read-DiskRequest
            Assert-Disk ($context.request.operation -ceq 'verify-image') 'INVALID_OPERATION' 'VerifyImage accepts only a verify-image request.'
            Write-DiskJson (Start-DiskJob $context)
        }
        'RunJob' { Invoke-DiskRun (Read-DiskRequest); Write-DiskJson ([pscustomobject]@{ completed = $true; statusPath = $script:statusPath }) }
    }
} catch {
    $code = if ($_.Exception.Data['Code']) { [string]$_.Exception.Data['Code'] } else { 'DISK_BACKEND_ERROR' }
    $message = if ($code -eq 'DISK_BACKEND_ERROR') { 'The Windows disk operation failed. Inspect the local job evidence and device access.' } else { $_.Exception.Message }
    if ($script:ownsJob -and $script:statusPath) {
        try { Write-DiskStatus 'error' 0 $false $true $message @{ error = $code } } catch {}
    }
    Write-DiskJson ([ordered]@{ error = $code; message = $message; started = $false })
    exit 1
}
