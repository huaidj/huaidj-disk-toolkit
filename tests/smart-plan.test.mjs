import test from 'node:test';
import assert from 'node:assert/strict';
import { smartData, smartPlanFromData, smartMediaPlan, matchEquipmentNames } from '../src/smart-plan.mjs';
const data = await smartData();
const usb = { number: 99, identity: 'a'.repeat(64), model: 'Test USB', serial: 'DO-NOT-EXPOSE', size: 64000000000, busType: 'USB', isBoot: false, isSystem: false, isReadOnly: false, eligible: true, partitionStyle: 'MBR' };

test('smart DJ match uses shared filesystem, two libraries and manufacturer guidance without claiming a player test', () => {
  const result = smartPlanFromData(data, { models: ['cdj-3000','cdj-3000x'] }, usb, 'win32');
  assert.equal(result.recommendation.filesystem, 'fat32');
  assert.equal(result.recommendation.partitionStyle, 'mbr');
  assert.ok(result.recommendation.libraryFormats.includes('deviceLibrary'));
  assert.ok(result.recommendation.libraryFormats.includes('oneLibrary'));
  assert.equal(result.confidence, 'conditional');
  assert.equal(result.canPrepare, true);
  assert.ok(!Object.hasOwn(result.target,'serial'));
  assert.ok(result.warnings.some(row => row.code === 'FAT32_FILE_LIMIT_UNCONFIRMED'));
});
test('large-file requirement blocks unsafe FAT32 fallback and becomes exFAT only after versions are known', () => {
  const options = { models: ['cdj-3000','cdj-3000x'], fileSizeClass: 'over-fat32' };
  assert.equal(smartPlanFromData(data, options, usb,'win32').canPrepare, false);
  const ready = smartPlanFromData(data, { ...options, firmwareVersions:{'cdj-3000':'1.20'},rekordboxVersion:'7.2.13' }, usb,'win32');
  assert.equal(ready.recommendation.filesystem,'exfat');
  assert.equal(ready.canPrepare,true);
  assert.equal(ready.inputs.largestFileBytes,null);
});
test('model-specific PRIME 4 rule overrides generic OS GPT advice at large capacity', () => {
  const result = smartPlanFromData(data,{models:['prime-4'],fileSizeClass:'within-fat32',rekordboxVersion:'7.2.13'},{...usb,size:1500000000000,partitionStyle:'RAW'},'win32');
  assert.equal(result.recommendation.filesystem,'exfat');
  assert.equal(result.recommendation.partitionStyle,'mbr');
});
test('unknown SC6000 partition support does not become a hardware GPT preset from generic OS guidance', () => {
  const result=smartPlanFromData(data,{models:['sc6000-prime']},{...usb,partitionStyle:'RAW'},'win32');
  assert.equal(result.recommendation.partitionStyle,null);
  assert.equal(result.canPrepare,false);
});
test('readonly target and over-2TiB MBR remain non-executable', () => {
  assert.equal(smartPlanFromData(data,{purpose:'shared-data'},{...usb,isReadOnly:true},'win32').canPrepare,false);
  const result=smartPlanFromData(data,{models:['prime-4'],partitionScheme:'mbr'},{...usb,size:4000000000000},'win32');
  assert.equal(result.canPrepare,false);
  assert.ok(result.missing.some(row=>row.code==='MBR_CAPACITY_LIMIT'));
});
test('Mac-only reference recommendation does not pretend this Windows adapter can format APFS', () => {
  const result=smartPlanFromData(data,{purpose:'mac-data'},usb,'win32');
  assert.equal(result.recommendation.filesystem,'apfs');
  assert.equal(result.canPrepare,false);
});
test('device-name matching keeps CDJ-3000X distinct and never guesses a player from a SanDisk drive', () => {
  const devices=matchEquipmentNames(data.dj.models,['Pioneer DJ CDJ-3000X Audio','SanDisk Ultra USB']);
  assert.deepEqual(devices.map(row=>row.modelId),['cdj-3000x']);
  assert.equal(devices[0].firmware,null);
  assert.equal(devices[0].requiresConfirmation,true);
});
test('contradictory file-size evidence is rejected and missing USB stays a preview', () => {
  assert.throws(()=>smartPlanFromData(data,{purpose:'shared-data',largestFileBytes:10,fileSizeClass:'over-fat32'},usb,'win32'),error=>error.code==='FILE_SIZE_INPUT_CONFLICT');
  assert.equal(smartPlanFromData(data,{purpose:'shared-data'},null,'win32').canPrepare,false);
});
test('cached UI preview is explicitly labelled and never needs a physical-device probe', async () => {
  const result=await smartMediaPlan({purpose:'shared-data',targetSnapshot:usb});
  assert.equal(result.targetObservation,'caller-preview-snapshot');
  assert.equal(result.target.number,usb.number);
  assert.ok(!Object.hasOwn(result.target,'serial'));
  await assert.rejects(smartMediaPlan({purpose:'shared-data',deviceNumber:12,targetSnapshot:usb}),error=>error.code==='PREVIEW_TARGET_MISMATCH');
});
