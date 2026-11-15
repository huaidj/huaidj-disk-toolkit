import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config, windowsBackend } from './core.mjs';
import { BridgeError } from './images.mjs';
import { recommendFromData, versionAdviceFromData } from './compatibility.mjs';

const run = promisify(execFile);
const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const norm = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const item = (code, message, level = 'warning') => ({ code, message, level });
async function json(name, fallback) {
  try { return JSON.parse((await readFile(path.join(directory, name), 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT' && fallback) return fallback; throw error; }
}
export async function smartData() {
  const [platforms, dj, advisories, guidance] = await Promise.all([
    json('platform-filesystems.json'), json('dj-compatibility.json'), json('rekordbox-advisories.json'), json('media-format-guidance.json', { rules: [], sources: [] })
  ]);
  return { platforms, dj, advisories, guidance };
}
function sameMaker(a, b) {
  const aa = norm(a), bb = norm(b);
  if (!aa || !bb) return false;
  const alpha = value => value.includes('alphatheta') || value.includes('pioneerdj');
  return aa === bb || (alpha(aa) && alpha(bb)) || (aa.includes('denon') && bb.includes('denon'));
}
function matchesRule(rule, model) {
  if (rule.scope === 'os-general') return false;
  return rule.modelIds?.includes(model.id) || (!rule.modelIds?.length && sameMaker(rule.maker, model.maker));
}
function canonicalFilesystem(value) {
  return ({ fat32: 'fat32', exfat: 'exfat', ntfs: 'ntfs', apfs: 'apfs', hfsplus: 'hfsPlus' })[norm(value)] ?? null;
}
function sourcesFor(data, urls) {
  const rows = [...(Array.isArray(data.dj.sources) ? data.dj.sources : Object.values(data.dj.sources)), ...(data.guidance.sources ?? [])];
  return [...new Set(urls)].map(url => {
    const row = rows.find(entry => entry.url === url);
    return row ? { id: row.id, title: row.title, url: row.url, kind: row.kind } : { id: null, title: new URL(url).hostname, url, kind: 'official-reference' };
  });
}

export function smartPlanFromData(data, options, target = null, hostPlatform = process.platform) {
  const { purpose = 'dj', models = [], hostPlatforms = ['windows', 'macos'], firmwareVersions = {}, rekordboxVersion, largestFileBytes = null, fileSizeClass = 'unknown', partitionScheme = 'auto' } = options;
  if (!['dj', 'shared-data', 'windows-data', 'mac-data'].includes(purpose)) throw new BridgeError('INVALID_PURPOSE', 'Select DJ, shared data, Windows data or Mac data.');
  if (!['unknown', 'within-fat32', 'over-fat32'].includes(fileSizeClass) || !['auto', 'mbr', 'gpt'].includes(partitionScheme)) throw new BridgeError('INVALID_SMART_INPUT', 'Select a documented file-size class and partition scheme.');
  if (largestFileBytes !== null && (!Number.isSafeInteger(largestFileBytes) || largestFileBytes < 0)) throw new BridgeError('INVALID_FILE_SIZE', 'Exact file size must be a nonnegative integer, or unknown.');
  if (!Array.isArray(models) || models.length > 32 || !Array.isArray(hostPlatforms) || !hostPlatforms.length || hostPlatforms.some(platform => !['windows','macos'].includes(platform))) throw new BridgeError('INVALID_SMART_INPUT', 'Supply bounded model IDs and documented preparation platforms.');
  if (largestFileBytes !== null && ((fileSizeClass === 'within-fat32' && largestFileBytes > 4294967295) || (fileSizeClass === 'over-fat32' && largestFileBytes <= 4294967295))) throw new BridgeError('FILE_SIZE_INPUT_CONFLICT', 'The measured file size and stated file-size class disagree.');
  const missing = [], warnings = [], reasons = [], urls = [];
  let filesystem = null, layout = null, layoutEvidence = 'unknown', libraryFormats = [], compatible = null;
  const evaluatedSize = largestFileBytes ?? (fileSizeClass === 'over-fat32' ? 4294967296 : 0);
  const selected = models.map(id => {
    const model = data.dj.models.find(row => norm(row.id) === norm(id) || norm(row.model) === norm(id));
    if (!model) throw new BridgeError('MODEL_NOT_FOUND', 'Choose an exact researched model.');
    return model;
  });

  if (purpose === 'dj') {
    if (!selected.length) missing.push(item('SELECT_DJ_MODEL', 'Select or confirm the DJ equipment used at the destination.', 'required'));
    else {
      compatible = recommendFromData(data.platforms, data.dj, { models, hostPlatforms, firmwareVersions, rekordboxVersion, largestFileBytes: evaluatedSize });
      filesystem = compatible.recommendedFilesystem;
      urls.push(...compatible.sourceURLs);
      libraryFormats = [...new Set(compatible.libraryRequirements.flatMap(row => row.supportedTypes).map(name => name === 'deviceLibraryPlus' ? 'oneLibrary' : name))];
      if (libraryFormats.includes('engineDj') && libraryFormats.some(name => name !== 'engineDj')) warnings.push(item('MULTIPLE_LIBRARY_ECOSYSTEMS', 'The selected equipment spans Engine DJ and rekordbox library ecosystems. A shared filesystem does not produce both software libraries.'));
      if (libraryFormats.includes('deviceLibrary') && libraryFormats.includes('oneLibrary')) reasons.push(item('DUAL_LIBRARY_REQUIRED', 'The selected equipment needs both traditional Device Library and OneLibrary exports.', 'info'));
      if (selected.some(model => Object.values(model.libraryTypes ?? {}).every(value => value !== true))) warnings.push(item('LIBRARY_SUPPORT_UNCONFIRMED', 'At least one selected model has incomplete library-type evidence.'));
      if (!filesystem) missing.push(item('NO_CONFIRMED_SHARED_FILESYSTEM', 'No filesystem is currently confirmed across the selected equipment, host platforms and file-size conditions. Check firmware and exporter versions or change the file requirement.', 'required'));
      const advisory = versionAdviceFromData(data.advisories, rekordboxVersion, 'usb-export');
      if (['incomplete-version', 'version-not-provided'].includes(advisory.versionStatus)) warnings.push(item('FULL_REKORDBOX_VERSION_NEEDED', 'A complete rekordbox release is needed to assess version-specific USB-export defects.'));
      if (advisory.knownDefects.length) warnings.push(item('KNOWN_EXPORT_DEFECT', 'The stated rekordbox release has a documented USB-export defect. Formatting does not repair that software defect.'));
      if (advisory.potentiallyRelevantDefects.length) warnings.push(item('POTENTIAL_EXPORT_ADVISORY', 'There are potentially relevant export advisories; the incomplete version does not prove this USB is affected.'));
      const applicable = (data.guidance.rules ?? []).filter(rule => !rule.excludeFromHardwareAutoSelect && selected.some(model => matchesRule(rule, model)));
      const preferredFilesystems = applicable.filter(rule => typeof rule.recommendation?.filesystem === 'string' &&
        (!rule.recommendation.minCapacityBytes || (target && target.size >= Number(rule.recommendation.minCapacityBytes))));
      for (const rule of preferredFilesystems.sort((a, b) => (a.scope === 'model-specific' ? 0 : 1) - (b.scope === 'model-specific' ? 0 : 1))) {
        const candidate = canonicalFilesystem(rule.recommendation.filesystem);
        if (compatible.candidates.some(row => row.filesystem === candidate && row.eligible)) {
          filesystem = candidate; reasons.push(item('MANUFACTURER_MEDIA_PREFERENCE', 'A manufacturer preparation guideline prefers this confirmed filesystem for the selected capacity/use.', 'info')); urls.push(...rule.sourceURLs); break;
        }
      }
      const layoutRules = applicable.filter(rule => ['mbr', 'gpt'].includes(String(rule.recommendation?.partitionScheme).toLowerCase()));
      for (const candidate of ['mbr', 'gpt']) {
        if (selected.some(model => model.partitionScheme?.[candidate] === false)) continue;
        const covered = selected.every(model => model.partitionScheme?.[candidate] === true || layoutRules.some(rule => matchesRule(rule, model) && rule.recommendation.partitionScheme.toLowerCase() === candidate));
        if (covered) {
          layout = candidate;
          const chosen = layoutRules.filter(rule => rule.recommendation.partitionScheme.toLowerCase() === candidate);
          layoutEvidence = selected.every(model => model.partitionScheme?.[candidate] === true || chosen.some(rule => rule.scope === 'model-specific' && matchesRule(rule, model))) ? 'model-specific' : 'manufacturer-general';
          urls.push(...chosen.flatMap(rule => rule.sourceURLs)); break;
        }
      }
      if (!layout && target && ['MBR', 'GPT'].includes(target.partitionStyle)) {
        const existing = target.partitionStyle.toLowerCase();
        if (!selected.some(model => model.partitionScheme?.[existing] === false)) {
          layout = existing; layoutEvidence = 'existing-layout-unconfirmed';
          warnings.push(item('EXISTING_LAYOUT_NOT_CERTIFIED', 'The existing partition-table type can be retained, but this is not model-specific playback certification.'));
        }
      }
    }
  } else {
    filesystem = purpose === 'windows-data' ? 'ntfs' : purpose === 'mac-data' ? 'apfs' : 'exfat';
    layout = target && ['MBR', 'GPT'].includes(target.partitionStyle) ? target.partitionStyle.toLowerCase() : 'gpt';
    layoutEvidence = 'os-data-profile';
    reasons.push(item('NATIVE_OS_DATA_PROFILE', 'The filesystem follows the selected computer data-sharing use, not a DJ-player guarantee.', 'info'));
    urls.push(...Object.values(data.platforms.sources));
  }
  if (partitionScheme !== 'auto') {
    layout = partitionScheme; layoutEvidence = 'operator-selected';
    if (purpose === 'dj' && selected.some(model => model.partitionScheme?.[layout] === false)) missing.push(item('PARTITION_SCHEME_CONFLICT', 'The selected partition scheme is explicitly excluded for at least one selected DJ model.', 'required'));
    else reasons.push(item('OPERATOR_PARTITION_CHOICE', 'The operator explicitly selected this partition-table type.', 'info'));
  }
  if (!layout && selected.length) missing.push(item('PARTITION_CHOICE_NEEDED', 'Partition-scheme evidence is incomplete. Review the device guidance or explicitly choose the layout.', 'required'));
  if (layout === 'mbr' && target?.size > 2 * 1024 ** 4) missing.push(item('MBR_CAPACITY_LIMIT', 'The enabled formatter does not automatically truncate a device larger than 2 TiB to MBR.', 'required'));
  if (filesystem === 'fat32' && largestFileBytes === null && fileSizeClass === 'unknown') warnings.push(item('FAT32_FILE_LIMIT_UNCONFIRMED', 'FAT32 permits at most 4,294,967,295 bytes per file; the largest file has not been checked.'));
  if (layoutEvidence === 'manufacturer-general') warnings.push(item('GENERAL_GUIDANCE_NOT_PLAYER_TEST', 'The layout follows a manufacturer preparation guideline, not physical acceptance on each selected player.'));
  if (!target) missing.push(item('SELECT_PHYSICAL_USB', 'Select the exact physical USB before preparing a write.', 'required'));
  else if (!target.eligible || target.isReadOnly || target.isBoot || target.isSystem) missing.push(item('USB_NOT_WRITABLE', 'The selected physical device is not an eligible writable non-system USB.', 'required'));
  const executable = hostPlatform === 'win32' && ['fat32', 'ntfs', 'exfat'].includes(filesystem);
  if (filesystem && !executable) missing.push(item('FORMAT_ADAPTER_UNAVAILABLE', 'This host adapter cannot create the recommended filesystem. Choose a compatible host or another intentional use profile.', 'required'));
  const canPrepare = Boolean(target && filesystem && layout && executable && !missing.some(row => row.level === 'required'));
  const safeTarget = target ? Object.fromEntries(Object.entries(target).filter(([key]) => !['serial', 'descriptorError'].includes(key))) : null;
  return {
    target: safeTarget,
    inputs: { purpose, modelIds: selected.map(model => model.id), firmware: firmwareVersions, platforms: hostPlatforms, largestFileBytes, fileSizeClass, rekordboxVersion: rekordboxVersion ?? null, partitionScheme },
    recommendation: { filesystem, partitionStyle: layout, partitionEvidence: layoutEvidence, libraryFormats,
      nativeOptions: filesystem && ['fat32', 'ntfs', 'exfat'].includes(filesystem) ? { filesystem, partitionScheme: layout ?? 'auto', targetSystem: 'auto', clusterSize: 'auto', volumeLabel: purpose === 'dj' ? 'DJUSB' : 'USB', quickFormat: true } : null },
    missing, warnings, reasons, sources: sourcesFor(data, urls), canPrepare,
    confidence: missing.some(row => row.level === 'required') ? 'needs-input' : warnings.length ? 'conditional' : 'documented-match',
    note: 'This is a fast local rule-based recommendation with source evidence. It does not format a drive, create a rekordbox export, or certify physical playback.'
  };
}

export async function smartMediaPlan(options) {
  const data = await smartData();
  let target = null;
  let targetObservation = 'no-device-selected';
  if (options.targetSnapshot !== undefined) {
    const snapshot = options.targetSnapshot;
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || !Number.isInteger(snapshot.number) || snapshot.number < 0 || snapshot.number > 255 || !Number.isSafeInteger(snapshot.size) || snapshot.size <= 0 || !/^[a-f0-9]{64}$/i.test(snapshot.identity ?? '') || typeof snapshot.eligible !== 'boolean' || typeof snapshot.isReadOnly !== 'boolean' || typeof snapshot.isBoot !== 'boolean' || typeof snapshot.isSystem !== 'boolean') throw new BridgeError('INVALID_PREVIEW_TARGET', 'The cached preview target must be a complete inventory row.');
    if (options.deviceNumber !== undefined && options.deviceNumber !== snapshot.number) throw new BridgeError('PREVIEW_TARGET_MISMATCH', 'The cached preview target differs from the selected device number.');
    const fields = ['number','model','size','identity','busType','partitionStyle','isReadOnly','isBoot','isSystem','isOffline','eligible','letters','readEligible'];
    target = Object.fromEntries(fields.filter(key => Object.hasOwn(snapshot,key)).map(key => [key,snapshot[key]]));
    targetObservation = 'caller-preview-snapshot';
  } else if (options.deviceNumber !== undefined) {
    if (!Number.isInteger(options.deviceNumber) || options.deviceNumber < 0 || options.deviceNumber > 255) throw new BridgeError('INVALID_DEVICE_NUMBER', 'Use a current physical device number.');
    const inventory = await windowsBackend('Devices');
    target = inventory.devices.find(device => device.number === options.deviceNumber) ?? null;
    if (!target) throw new BridgeError('DEVICE_NOT_FOUND', 'The selected physical device is no longer present.');
    targetObservation = 'fresh-inventory';
  }
  return { ...smartPlanFromData(data, options, target), targetObservation, executionNote: 'A cached recommendation never authorizes a write; the prepare and execute paths revalidate the physical device independently.' };
}

export function matchEquipmentNames(models, names) {
  const found = new Map();
  for (const name of names) {
    const text = norm(name);
    const matches = models.filter(model => text.includes(norm(model.model))).sort((a, b) => norm(b.model).length - norm(a.model).length);
    if (matches[0]) found.set(matches[0].id, { modelId: matches[0].id, model: matches[0].model, firmware: null, requiresConfirmation: true, evidence: 'Operating-system device-name match; confirm the actual model and firmware.' });
  }
  return [...found.values()];
}
export async function detectDjEquipment() {
  if (process.platform !== 'win32') return { status: 'unsupported', devices: [], unknown: [], note: 'Automatic device-name matching is implemented on Windows; manual catalog selection remains available.' };
  const settings = await config(), data = await smartData();
  try {
    const result = await run(settings.powershell, ['-NoProfile', '-NonInteractive', '-Command', "$items=@(Get-PnpDevice -PresentOnly -ErrorAction Stop | Where-Object {$_.FriendlyName -match 'CDJ|XDJ|OMNIS|OPUS|SC6000|PRIME'} | ForEach-Object {[string]$_.FriendlyName}); ConvertTo-Json -InputObject $items -Compress"], { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 });
    const names = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
    const devices = matchEquipmentNames(data.dj.models, Array.isArray(names) ? names : [names]);
    return { status: devices.length ? 'detected' : 'not-detected', devices, unknown: [], note: 'Only matching catalog model names are returned. USB drive branding is never used to infer the destination player.' };
  } catch { return { status: 'unavailable', devices: [], unknown: [], note: 'Automatic device-name discovery is unavailable. Select the destination equipment manually.' }; }
}
