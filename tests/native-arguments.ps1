$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '..\src\native-arguments.ps1')
$defaultOptions=[ordered]@{filesystem='auto';partitionScheme='auto';targetSystem='auto';clusterSize='auto';volumeLabel=$null;quickFormat=$null}
$imageRequest=[pscustomobject]@{deviceNumber=9;size=64000000000;serial='SERIAL WITH SPACE';confirm='ERASE:9:64000000000';mode='dd';imageSHA256=('A'*64);dryRun=$true}
$imageArgs=@(Get-HuaiDJNativeArguments -NativeOperation image -Request $imageRequest -Options $defaultOptions -StatusFile 'X:\job folder\status.json' -ImagePath 'X:\image folder\image.iso')
if($imageArgs -contains '--huaidj-quick-format'){throw 'DD must not receive quick-format'}
if($imageArgs[$imageArgs.IndexOf('--huaidj-serial')+1] -cne 'SERIAL WITH SPACE'){throw 'Serial argument was not preserved'}
if($imageArgs[$imageArgs.IndexOf('--huaidj-image')+1] -cne 'X:\image folder\image.iso'){throw 'Image argument was not preserved'}
if($imageArgs[$imageArgs.IndexOf('--huaidj-sha256')+1] -cne ('a'*64)){throw 'Digest normalization failed'}
$formatOptions=[ordered]@{filesystem='fat32';partitionScheme='mbr';targetSystem='auto';clusterSize=32768;volumeLabel='DJ USB';quickFormat=$true}
$formatRequest=[pscustomobject]@{deviceNumber=9;size=64000000000;serial='TEST';confirm='ERASE:9:64000000000';dryRun=$false}
$formatArgs=@(Get-HuaiDJNativeArguments -NativeOperation format -Request $formatRequest -Options $formatOptions -StatusFile 'X:\status.json')
foreach($forbidden in @('--huaidj-image','--huaidj-sha256','--huaidj-mode')){if($formatArgs -contains $forbidden){throw 'Format-only received an image argument'}}
if($formatArgs[$formatArgs.IndexOf('--huaidj-volume-label')+1] -cne 'DJ USB'){throw 'Label argument was not preserved'}
if($formatArgs[$formatArgs.IndexOf('--huaidj-quick-format')+1] -cne 'true'){throw 'Boolean serialization failed'}
if($formatArgs[$formatArgs.IndexOf('--huaidj-cluster-size')+1] -cne '32768'){throw 'Cluster argument was not preserved'}
[pscustomobject]@{PureArgumentContracts='PASS';DevicesOpened=0;PrivilegedProcesses=0;NativeProcesses=0}|ConvertTo-Json -Compress
