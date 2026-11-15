import { BridgeError } from './images.mjs';

const keys = new Set(['filesystem', 'partitionScheme', 'targetSystem', 'clusterSize', 'volumeLabel', 'quickFormat']);
export function normalizeNativeOptions(input = {}, { mode = 'iso', operation = 'image' } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.has(key))) throw new BridgeError('INVALID_NATIVE_OPTIONS', 'Use the documented native format options only.');
  const result = { filesystem: 'auto', partitionScheme: 'auto', targetSystem: 'auto', clusterSize: 'auto', volumeLabel: null, quickFormat: operation === 'image' && mode === 'dd' ? null : true, ...input };
  if (!['auto', 'fat32', 'ntfs', 'exfat'].includes(result.filesystem) || !['auto', 'mbr', 'gpt'].includes(result.partitionScheme) || !['auto', 'bios', 'uefi'].includes(result.targetSystem)) throw new BridgeError('INVALID_NATIVE_OPTIONS', 'Select a documented filesystem, partition scheme and target system.');
  if (result.clusterSize !== 'auto' && (!Number.isInteger(result.clusterSize) || result.clusterSize < 512 || result.clusterSize > 2097152 || (result.clusterSize & (result.clusterSize - 1)) !== 0)) throw new BridgeError('INVALID_CLUSTER_SIZE', 'Cluster size must be auto or a power of two between 512 bytes and 2 MiB; the native engine additionally checks actual filesystem support.');
  if (result.volumeLabel !== null && (typeof result.volumeLabel !== 'string' || Buffer.byteLength(result.volumeLabel, 'utf8') > 63 || /[\u0000-\u001f\\/:*?"<>|]/.test(result.volumeLabel))) throw new BridgeError('INVALID_LABEL', 'The volume label contains unsupported characters or exceeds the native byte limit.');
  if (result.filesystem === 'fat32' && result.volumeLabel !== null && (result.volumeLabel.length > 11 || /[^\x20-\x7e]/.test(result.volumeLabel))) throw new BridgeError('INVALID_LABEL', 'FAT32 labels require at most 11 printable ASCII characters in this native adapter.');
  if (result.filesystem === 'exfat' && result.volumeLabel !== null && result.volumeLabel.length > 15) throw new BridgeError('INVALID_LABEL', 'exFAT labels are limited to 15 UTF-16 code units in this adapter.');
  if (result.volumeLabel !== null && result.volumeLabel.length > 32) throw new BridgeError('INVALID_LABEL', 'The volume label exceeds 32 UTF-16 code units.');
  if (operation === 'format') {
    if (result.filesystem === 'auto') throw new BridgeError('FILESYSTEM_REQUIRED', 'Native format-only plans require an explicit filesystem.');
    if (result.targetSystem !== 'auto') throw new BridgeError('NON_BOOTABLE_FORMAT_REQUIRED', 'Format-only operation uses a non-bootable target.');
  }
  if (operation === 'image' && mode === 'dd') {
    if (result.filesystem !== 'auto' || result.partitionScheme !== 'auto' || result.targetSystem !== 'auto' || result.clusterSize !== 'auto' || result.volumeLabel !== null || input.quickFormat !== undefined)
      throw new BridgeError('DD_OPTIONS_INAPPLICABLE', 'DD uses the image-defined disk layout; filesystem, label, quick-format and partition overrides do not apply.');
  } else if (typeof result.quickFormat !== 'boolean') throw new BridgeError('INVALID_QUICK_FORMAT', 'quickFormat must be a boolean.');
  return result;
}
