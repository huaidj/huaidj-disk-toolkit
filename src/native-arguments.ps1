# SPDX-License-Identifier: GPL-3.0-or-later
# Pure argument construction; no process, filesystem or device operation occurs here.
function Get-HuaiDJNativeArguments {
    param(
        [Parameter(Mandatory)][ValidateSet('image','format')][string]$NativeOperation,
        [Parameter(Mandatory)]$Request,
        [Parameter(Mandatory)]$Options,
        [Parameter(Mandatory)][string]$StatusFile,
        [string]$ImagePath
    )
    $number = [int]$Request.deviceNumber
    $size = [uint64]$Request.size
    $arguments = @('--huaidj-operation', $NativeOperation,
        '--huaidj-device', $number.ToString([Globalization.CultureInfo]::InvariantCulture),
        '--huaidj-status', $StatusFile, '--huaidj-confirm', [string]$Request.confirm,
        '--huaidj-size', $size.ToString([Globalization.CultureInfo]::InvariantCulture),
        '--huaidj-serial', [string]$Request.serial)
    if ($NativeOperation -eq 'image') {
        $arguments += @('--huaidj-image', $ImagePath, '--huaidj-mode', [string]$Request.mode,
            '--huaidj-sha256', ([string]$Request.imageSHA256).ToLowerInvariant())
    }
    foreach ($mapping in @(@('filesystem','--huaidj-filesystem'), @('partitionScheme','--huaidj-partition-scheme'), @('targetSystem','--huaidj-target-system'), @('clusterSize','--huaidj-cluster-size'))) {
        if ([string]$Options[$mapping[0]] -cne 'auto') { $arguments += @($mapping[1], [string]$Options[$mapping[0]]) }
    }
    if ($null -ne $Options.volumeLabel) { $arguments += @('--huaidj-volume-label', [string]$Options.volumeLabel) }
    if ($null -ne $Options.quickFormat) { $arguments += @('--huaidj-quick-format', ([string]$Options.quickFormat).ToLowerInvariant()) }
    if ($Request.dryRun) { $arguments += '--huaidj-dry-run' }
    return $arguments
}
