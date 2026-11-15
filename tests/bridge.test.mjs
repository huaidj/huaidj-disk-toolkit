import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectImage, sha256File, isWithin } from '../src/images.mjs';
import { requireEligibleDevice, startWrite, jobStatus } from '../src/core.mjs';

test('USB eligibility rejects internal, boot, readonly, missing serial and invalid identity', () => {
  const good = { busType: 'USB', eligible: true, serial: 'test-serial', identity: 'a'.repeat(64), isBoot: false, isSystem: false, isReadOnly: false };
  assert.doesNotThrow(() => requireEligibleDevice(good));
  for (const change of [{ busType: 'NVMe' }, { isBoot: true }, { isSystem: true }, { isReadOnly: true }, { serial: '' }, { identity: '../../escape' }, { eligible: 'true' }]) {
    assert.throws(() => requireEligibleDevice({ ...good, ...change }), error => error.code === 'DEVICE_NOT_ELIGIBLE');
  }
  assert.throws(() => requireEligibleDevice(good, 'b'.repeat(64)), error => error.code === 'DEVICE_CHANGED');
});

test('no authorization and forged job paths are rejected before backend launch', async () => {
  await assert.rejects(startWrite({ planId: '../outside', confirmation: 'ERASE', confirmErase: false }), error => error.code === 'ERASE_NOT_CONFIRMED');
  await assert.rejects(startWrite({ planId: '../outside', confirmation: 'ERASE', confirmErase: true }), error => error.code === 'INVALID_JOB_ID');
  await assert.rejects(jobStatus('../outside'), error => error.code === 'INVALID_JOB_ID');
});

test('image inspection distinguishes a pure ISO from a partitioned hybrid and rejects mismatch/root escape', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'huaidj-rufus-test-'));
  try {
    const allowed = path.join(directory, 'allowed');
    await mkdir(allowed);
    const imagePath = path.join(allowed, 'test.iso');
    const bytes = Buffer.alloc(1024 * 1024);
    bytes.write('CD001', 32769, 'ascii');
    await writeFile(imagePath, bytes);
    const settings = { imageRoots: [allowed], imageAliases: { test: imagePath } };
    const pure = await inspectImage('test', undefined, settings, directory);
    assert.equal(pure.iso9660, true);
    assert.equal(pure.rawWriteEligible, false);
    await assert.rejects(inspectImage('test', '0'.repeat(64), settings, directory), error => error.code === 'CHECKSUM_MISMATCH');
    bytes[510] = 0x55; bytes[511] = 0xaa; bytes[450] = 0x83; bytes.writeUInt32LE(100, 458);
    await writeFile(imagePath, bytes);
    const expected = await sha256File(imagePath);
    const hybrid = await inspectImage('test', expected, settings, directory);
    assert.equal(hybrid.rawWriteEligible, true);
    assert.equal(hybrid.expectedHashMatched, true);
    await assert.rejects(inspectImage(imagePath, expected, { imageRoots: [path.join(directory, 'other')] }, directory), error => error.code === 'IMAGE_OUTSIDE_ROOTS');
    const wrongType = path.join(allowed, 'test.txt');
    await writeFile(wrongType, bytes);
    await assert.rejects(inspectImage(wrongType, undefined, settings, directory), error => error.code === 'IMAGE_TYPE_NOT_SUPPORTED');
    assert.equal(isWithin(path.join(directory, 'allowed-sibling'), allowed), false);
  } finally {
    const temporaryRoot = await import('node:fs/promises').then(fs => fs.realpath(os.tmpdir()));
    if (!isWithin(directory, temporaryRoot)) throw new Error('Refusing cleanup outside the temporary workspace');
    await rm(directory, { recursive: true, force: true });
  }
});
