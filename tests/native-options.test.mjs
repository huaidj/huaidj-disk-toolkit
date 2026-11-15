import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNativeOptions } from '../src/native-options.mjs';
import { inspectImage } from '../src/images.mjs';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

test('DD cannot silently accept filesystem or quick-format overrides', () => {
  assert.equal(normalizeNativeOptions({}, { mode: 'dd' }).quickFormat, null);
  for (const options of [{ filesystem: 'ntfs' }, { partitionScheme: 'gpt' }, { volumeLabel: 'DJUSB' }, { quickFormat: true }])
    assert.throws(() => normalizeNativeOptions(options, { mode: 'dd' }), error => error.code === 'DD_OPTIONS_INAPPLICABLE');
});
test('native format-only requires an explicit filesystem and validates label/cluster bounds', () => {
  assert.throws(() => normalizeNativeOptions({}, { operation: 'format' }), error => error.code === 'FILESYSTEM_REQUIRED');
  assert.throws(() => normalizeNativeOptions({ filesystem: 'fat32', targetSystem: 'uefi' }, { operation: 'format' }), error => error.code === 'NON_BOOTABLE_FORMAT_REQUIRED');
  assert.throws(() => normalizeNativeOptions({ filesystem: 'fat32', volumeLabel: 'A'.repeat(12) }, { operation: 'format' }), error => error.code === 'INVALID_LABEL');
  assert.throws(() => normalizeNativeOptions({ clusterSize: 1536 }), error => error.code === 'INVALID_CLUSTER_SIZE');
  assert.equal(normalizeNativeOptions({ filesystem: 'fat32', clusterSize: 32768, volumeLabel: 'DJUSB' }, { operation: 'format' }).quickFormat, true);
});
test('UDF-only Windows disc recognition does not rely on an ISO9660 primary descriptor', async () => {
  const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'state', 'test-fixtures', `udf-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const imagePath = path.join(directory, 'udf-only.iso');
  try {
    const bytes = Buffer.alloc(1024 * 1024);
    bytes.write('BEA01', 16 * 2048 + 1, 'ascii'); bytes.write('NSR02', 17 * 2048 + 1, 'ascii'); bytes.write('TEA01', 18 * 2048 + 1, 'ascii');
    await writeFile(imagePath, bytes);
    const result = await inspectImage(imagePath, undefined, { imageRoots: [directory] }, directory);
    assert.equal(result.iso9660, false);
    assert.equal(result.udf, true);
    assert.equal(result.discImage, true);
    assert.equal(result.rawWriteEligible, false);
  } finally {
    // The resolved, freshly created fixture remains within this project's test scope.
    const approvedRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'state', 'test-fixtures');
    if (!directory.startsWith(`${approvedRoot}${path.sep}`)) throw new Error('Fixture cleanup escaped its approved scope');
    await rm(directory, { recursive: true, force: true });
  }
});
