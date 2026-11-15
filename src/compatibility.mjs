import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BridgeError } from './images.mjs';

const dataRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const allowedFiles = new Set(['platform-filesystems', 'rekordbox-advisories', 'dj-compatibility']);
async function load(name) {
  if (!allowedFiles.has(name)) throw new BridgeError('UNKNOWN_DATASET', 'The requested compatibility dataset is not available.');
  try { return JSON.parse((await readFile(path.join(dataRoot, `${name}.json`), 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new BridgeError('DATASET_NOT_READY', 'This compatibility dataset has not been installed yet.');
    throw error;
  }
}
const normalize = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const filesystemAlias = value => ({ hfs: 'hfsPlus', hfsplus: 'hfsPlus', macosextended: 'hfsPlus', msdos: 'fat32' })[normalize(value)] ?? normalize(value);

export async function platformFormats({ platform, filesystem } = {}) {
  const data = await load('platform-filesystems');
  if (platform && !['windows', 'macos'].includes(platform)) throw new BridgeError('UNKNOWN_PLATFORM', 'Select windows or macos for the documented native platform matrix.');
  const rows = data.filesystems.filter(row => !filesystem || normalize(row.id) === normalize(filesystemAlias(filesystem)));
  if (filesystem && rows.length === 0) throw new BridgeError('UNKNOWN_FILESYSTEM', 'The requested filesystem is not in the sourced matrix.');
  return { ...data, filesystems: rows.map(row => platform ? { id: row.id, name: row.name, maxFileBytes: row.maxFileBytes ?? null, support: row[platform], notes: row.notes, sources: row.sources } : row), queriedPlatform: platform ?? 'all' };
}

export async function listDjModels({ query = '' } = {}) {
  const data = await load('dj-compatibility');
  const term = normalize(query);
  return {
    asOfUTC: data.asOfUTC, scopeNotes: data.scopeNotes,
    models: data.models.filter(model => !term || normalize(`${model.maker} ${model.model}`).includes(term)).map(model => ({ id: model.id, model: model.model, maker: model.maker, category: model.category })),
    note: 'This is a bounded, sourced equipment catalog. An absent model is not an unsupported model.'
  };
}

export async function djCompatibility(modelName) {
  const data = await load('dj-compatibility');
  const matches = data.models.filter(model => normalize(model.id) === normalize(modelName) || normalize(model.model) === normalize(modelName));
  if (matches.length !== 1) throw new BridgeError('MODEL_NOT_FOUND', 'Select an exact model ID from list_dj_models.');
  return { asOfUTC: data.asOfUTC, ...matches[0], libraryDefinitions: data.libraryDefinitions, sources: data.sources, evidenceScope: 'Manufacturer documentation research; physical player acceptance is a separate test.' };
}

export function versionAdviceFromData(data, version, scope = 'usb-export') {
  if (version && !/^\d+(?:\.\d+){0,2}$/.test(version)) throw new BridgeError('INVALID_VERSION', 'Use a numeric rekordbox version. A major-only value is accepted as incomplete evidence.');
  if (!['usb-export', 'desktop-main-library', 'all'].includes(scope)) throw new BridgeError('INVALID_SCOPE', 'Select usb-export, desktop-main-library or all.');
  const scoped = data.notices.filter(notice => scope === 'all' || notice.scope === scope);
  const exact = scoped.filter(notice => typeof notice.affectedVersion === 'string' && notice.affectedVersion === version);
  const incomplete = Boolean(version && version.split('.').length < 3);
  const potential = !version || incomplete ? scoped.filter(notice => typeof notice.affectedVersion === 'string' && (!version || notice.affectedVersion.startsWith(`${version}.`))) : [];
  const general = data.notices.filter(notice => !notice.affectedVersion && (scope === 'all' || notice.scope === scope));
  return {
    asOfUTC: data.asOfUTC, version: version ?? 'unknown', scope,
    knownDefects: exact, potentiallyRelevantDefects: potential, generalGuidance: general,
    versionStatus: exact.length ? 'known-affected' : incomplete ? 'incomplete-version' : version ? 'no-matching-advisory-in-this-dataset' : 'version-not-provided',
    limitations: ['Absence of an advisory is not certification of a version.', 'The exporting rekordbox version cannot be reliably inferred from every USB library file.', 'A library-format mismatch is different from proven structural corruption.']
  };
}
export async function rekordboxVersionAdvice(version, scope = 'usb-export') { return versionAdviceFromData(await load('rekordbox-advisories'), version, scope); }

function atLeastVersion(actual, minimum) {
  const actualMatch = String(actual ?? '').trim().match(/^(?:(?:engine dj os|engine os)\s*)?v?(\d+(?:\.\d+){1,3})$/i);
  const got = actualMatch?.[1].split('.').map(Number);
  const required = String(minimum ?? '').match(/\d+(?:\.\d+){1,3}/)?.[0].split('.').map(Number);
  if (!got || !required) return false;
  for (let i = 0; i < Math.max(got.length, required.length); i++) {
    if ((got[i] ?? 0) > (required[i] ?? 0)) return true;
    if ((got[i] ?? 0) < (required[i] ?? 0)) return false;
  }
  return true;
}

export function recommendFromData(platformData, djData, { models, hostPlatforms = ['windows', 'macos'], largestFileBytes = 0, firmwareVersions = {}, rekordboxVersion }) {
  if (!Array.isArray(models) || !models.length || models.length > 32) throw new BridgeError('MODELS_REQUIRED', 'Select between one and 32 exact DJ model IDs.');
  if (!Array.isArray(hostPlatforms) || !hostPlatforms.length || hostPlatforms.some(p => !['windows', 'macos'].includes(p))) throw new BridgeError('UNKNOWN_PLATFORM', 'Select windows and/or macos.');
  if (!Number.isSafeInteger(largestFileBytes) || largestFileBytes < 0) throw new BridgeError('INVALID_FILE_SIZE', 'Supply the largest individual file size in bytes.');
  const selected = models.map(name => {
    const matches = djData.models.filter(model => normalize(model.id) === normalize(name) || normalize(model.model) === normalize(name));
    if (matches.length !== 1) throw new BridgeError('MODEL_NOT_FOUND', 'A selected model is absent or ambiguous. Use the exact equipment catalog ID.');
    return matches[0];
  });
  const candidates = ['fat32', 'exfat', 'hfsPlus', 'ntfs'].map(id => {
    const filesystem = platformData.filesystems.find(row => row.id === id);
    const reasons = [];
    if (!filesystem) reasons.push('Missing platform evidence.');
    if (filesystem?.maxFileBytes && largestFileBytes > filesystem.maxFileBytes) reasons.push('At least one file exceeds the filesystem per-file limit.');
    for (const platform of hostPlatforms) if (filesystem?.[platform]?.write !== true) reasons.push(`${platform} native write support is not confirmed.`);
    for (const model of selected) {
      if (model.filesystemSupport?.[id] !== true) reasons.push(`${model.model} support is ${model.filesystemSupport?.[id] === false ? 'unsupported' : 'unconfirmed'}.`);
      for (const condition of model.firmwareConditions ?? []) {
        const feature = normalize(condition.feature);
        if (!feature.includes(normalize(id)) && !(id === 'hfsPlus' && feature.includes('hfs'))) continue;
        const suppliedFirmware = firmwareVersions[model.id] ?? firmwareVersions[model.model];
        if (condition.minimumFirmware && !atLeastVersion(suppliedFirmware, condition.minimumFirmware)) reasons.push(`${model.model} needs confirmed firmware ${condition.minimumFirmware} or newer for this feature.`);
        if (condition.exportSoftware?.minimum && !atLeastVersion(rekordboxVersion, condition.exportSoftware.minimum)) reasons.push(`${model.model} needs confirmed ${condition.exportSoftware.name} ${condition.exportSoftware.minimum} or newer for this feature.`);
      }
    }
    return { filesystem: id, eligible: reasons.length === 0, reasons };
  });
  const libraryRequirements = selected.map(model => ({ model: model.model, supportedTypes: Object.entries(model.libraryTypes ?? {}).filter(([, status]) => status === true).map(([name]) => name) }));
  const requiresTraditional = libraryRequirements.some(row => row.supportedTypes.includes('deviceLibrary'));
  const requiresOneLibrary = libraryRequirements.some(row => row.supportedTypes.includes('oneLibrary') || row.supportedTypes.includes('deviceLibraryPlus'));
  const hasUnknownPartitioning = selected.some(model => model.partitionScheme?.mbr !== true && model.partitionScheme?.gpt !== true);
  return {
    researchedAsOfUTC: djData.asOfUTC, selectedModels: selected.map(model => model.model), hostPlatforms,
    recommendedFilesystem: candidates.find(row => row.eligible)?.filesystem ?? null,
    candidates, libraryRequirements,
    exportRecommendation: requiresTraditional && requiresOneLibrary ? 'Export and verify both Device Library and OneLibrary through an unaffected supported rekordbox version.' : requiresOneLibrary ? 'Export and verify OneLibrary for the selected equipment.' : requiresTraditional ? 'Export and verify the traditional Device Library for the selected equipment.' : 'Library requirements need model-specific confirmation.',
    partitionRecommendation: hasUnknownPartitioning ? 'Partition-scheme evidence is incomplete. Do not apply an automatic DJ partition preset.' : selected.every(model => model.partitionScheme?.mbr === true) ? 'MBR is confirmed for the selected models; honor their capacity and partition-count limits.' : 'Follow the individual model partition-scheme conditions.',
    sourceURLs: [...new Set(selected.flatMap(model => model.sourceURLs ?? []))],
    limitations: ['A filesystem recommendation does not certify audio codecs, database contents, USB hardware reliability or player firmware.', 'No disk is formatted by this query.']
  };
}
export async function recommendDjMedia(options) { return recommendFromData(await load('platform-filesystems'), await load('dj-compatibility'), options); }

export function checkAudioFromModel(model, { format, sampleRateHz, bitDepth }) {
  if (['m4a', 'mp4'].includes(normalize(format))) throw new BridgeError('AMBIGUOUS_AUDIO_CONTAINER', 'M4A/MP4 is a container. Supply the actual AAC or ALAC codec.');
  const aliases = { aif: 'aiff', wave: 'wav' };
  const codec = aliases[normalize(format)] ?? normalize(format);
  if (!codec) throw new BridgeError('AUDIO_FORMAT_REQUIRED', 'Supply the actual codec, not just an ambiguous container extension.');
  if ((sampleRateHz !== undefined && (!Number.isInteger(sampleRateHz) || sampleRateHz <= 0)) || (bitDepth !== undefined && (!Number.isInteger(bitDepth) || bitDepth <= 0))) throw new BridgeError('INVALID_AUDIO_PROPERTIES', 'Sample rate and bit depth must be positive integers.');
  const entry = model.audioFormats.find(row => normalize(row.format) === codec);
  if (!entry) return { model: model.model, codec, status: 'unknown', reasons: ['This codec has no reviewed positive row in the dataset.'], sourceURLs: model.sourceURLs };
  const checks = [];
  if (sampleRateHz !== undefined) {
    if (Array.isArray(entry.sampleRatesHz)) checks.push({ property: 'sampleRateHz', value: sampleRateHz, status: entry.sampleRatesHz.includes(sampleRateHz) ? 'supported' : entry.sampleRateListExhaustive === false ? 'unknown' : 'unsupported' });
    else if (entry.sampleRateRangeHz) {
      const [min, max] = Array.isArray(entry.sampleRateRangeHz) ? entry.sampleRateRangeHz : [entry.sampleRateRangeHz.min, entry.sampleRateRangeHz.max];
      checks.push({ property: 'sampleRateHz', value: sampleRateHz, status: sampleRateHz >= min && sampleRateHz <= max ? 'within-documented-range' : 'unsupported' });
    }
    else checks.push({ property: 'sampleRateHz', value: sampleRateHz, status: 'unknown' });
  }
  if (bitDepth !== undefined) {
    if (Array.isArray(entry.bits)) checks.push({ property: 'bitDepth', value: bitDepth, status: entry.bits.includes(bitDepth) ? 'supported' : 'unsupported' });
    else if (entry.bitDepthRange) {
      const [min, max] = Array.isArray(entry.bitDepthRange) ? entry.bitDepthRange : [entry.bitDepthRange.min, entry.bitDepthRange.max];
      checks.push({ property: 'bitDepth', value: bitDepth, status: bitDepth >= min && bitDepth <= max ? 'within-documented-range' : 'unsupported' });
    }
    else checks.push({ property: 'bitDepth', value: bitDepth, status: 'unknown' });
  }
  const codecConditions = (model.firmwareConditions ?? []).filter(condition => normalize(condition.feature).includes(codec));
  return { model: model.model, codec, status: checks.some(check => check.status === 'unsupported') ? 'unsupported' : checks.some(check => check.status !== 'supported') || codecConditions.length ? 'conditional-or-unconfirmed' : 'documented-support', checks, firmwareConditions: codecConditions, notes: entry.notes, sourceURLs: model.sourceURLs, evidenceScope: 'Documented codec/property compatibility only. Container variants, integer/float encoding, DRM, malformed audio and physical playback are not certified.' };
}
export async function checkDjAudio({ model, ...properties }) { return checkAudioFromModel(await djCompatibility(model), properties); }
