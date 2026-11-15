import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendFromData, versionAdviceFromData, checkAudioFromModel } from '../src/compatibility.mjs';

const platforms = { filesystems: [
  { id: 'fat32', maxFileBytes: 4294967295, windows: { write: true }, macos: { write: true } },
  { id: 'exfat', windows: { write: true }, macos: { write: true } },
  { id: 'hfsPlus', windows: { write: false }, macos: { write: true } },
  { id: 'ntfs', windows: { write: true }, macos: { write: false } }
] };
const gear = { models: [
  { id: 'legacy', model: 'Legacy test player', filesystemSupport: { fat32: true, exfat: false, hfsPlus: true }, libraryTypes: { deviceLibrary: true, oneLibrary: false }, partitionScheme: { mbr: true } },
  { id: 'modern', model: 'Modern test player', filesystemSupport: { fat32: true, exfat: true, hfsPlus: 'unknown' }, libraryTypes: { deviceLibrary: false, oneLibrary: true }, partitionScheme: { mbr: 'unknown' } }
] };

test('mixed equipment selects a shared filesystem and preserves two library requirements', () => {
  const result = recommendFromData(platforms, gear, { models: ['legacy', 'modern'] });
  assert.equal(result.recommendedFilesystem, 'fat32');
  assert.match(result.exportRecommendation, /both Device Library and OneLibrary/);
  assert.match(result.partitionRecommendation, /evidence is incomplete/);
});
test('large individual files do not silently become compatible with legacy gear', () => {
  assert.equal(recommendFromData(platforms, gear, { models: ['legacy'], largestFileBytes: 4294967296 }).recommendedFilesystem, null);
  assert.equal(recommendFromData(platforms, gear, { models: ['modern'], largestFileBytes: 4294967296 }).recommendedFilesystem, 'exfat');
  assert.equal(recommendFromData(platforms, gear, { models: ['modern'], largestFileBytes: 4294967295 }).recommendedFilesystem, 'fat32');
});
test('unknown equipment is not guessed to support a filesystem', () => {
  assert.throws(() => recommendFromData(platforms, gear, { models: ['not-a-model'] }), error => error.code === 'MODEL_NOT_FOUND');
});
test('rekordbox known-bad versions are distinct from unverified later versions', () => {
  const data = { notices: [{ affectedVersion: '7.2.12', fixedVersion: '7.2.13', scope: 'usb-export' }, { id: 'general', scope: 'usb-export' }] };
  assert.equal(versionAdviceFromData(data, '7.2.12').versionStatus, 'known-affected');
  assert.equal(versionAdviceFromData(data, '7.2.13').versionStatus, 'no-matching-advisory-in-this-dataset');
  assert.equal(versionAdviceFromData(data, undefined).versionStatus, 'version-not-provided');
  assert.equal(versionAdviceFromData(data, undefined).knownDefects.length, 0);
  assert.equal(versionAdviceFromData(data, undefined).potentiallyRelevantDefects.length, 1);
  assert.equal(versionAdviceFromData(data, '7').versionStatus, 'incomplete-version');
  assert.equal(versionAdviceFromData(data, '7').potentiallyRelevantDefects.length, 1);
  assert.equal(versionAdviceFromData(data, '6').potentiallyRelevantDefects.length, 0);
});
test('a firmware-dependent filesystem is not recommended without both version conditions', () => {
  const conditional = { models: [{ ...gear.models[1], firmwareConditions: [{ feature: 'exFAT', minimumFirmware: '1.20', exportSoftware: { name: 'rekordbox', minimum: '6.6.2' } }] }] };
  const options = { models: ['modern'], largestFileBytes: 4294967296 };
  assert.equal(recommendFromData(platforms, conditional, options).recommendedFilesystem, null);
  assert.equal(recommendFromData(platforms, conditional, { ...options, firmwareVersions: { modern: '1.20' }, rekordboxVersion: '6.6.2' }).recommendedFilesystem, 'exfat');
  assert.equal(recommendFromData(platforms, conditional, { ...options, firmwareVersions: { modern: '1.19' }, rekordboxVersion: '7.2.13' }).recommendedFilesystem, null);
});
test('audio checks preserve incomplete rate evidence and ambiguous containers', () => {
  const model = { model: 'test', audioFormats: [{ format: 'wav', sampleRatesHz: [44100, 48000], sampleRateListExhaustive: false, bits: [16, 24] }], firmwareConditions: [] };
  assert.equal(checkAudioFromModel(model, { format: 'wav', sampleRateHz: 32000 }).status, 'conditional-or-unconfirmed');
  assert.equal(checkAudioFromModel(model, { format: 'wav', sampleRateHz: 48000, bitDepth: 24 }).status, 'documented-support');
  assert.equal(checkAudioFromModel(model, { format: 'wav', bitDepth: 32 }).status, 'unsupported');
  assert.throws(() => checkAudioFromModel(model, { format: 'm4a' }), error => error.code === 'AMBIGUOUS_AUDIO_CONTAINER');
});
