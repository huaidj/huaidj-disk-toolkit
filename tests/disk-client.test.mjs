import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const actualProject = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = path.join(actualProject, 'work', `disk-client-${randomUUID()}`);
const identity = 'a'.repeat(64);
const device = {
  number: 4, model: 'Synthetic USB', size: 32 * 1024 ** 3, busType: 'USB', serial: 'test-usb-serial',
  identity, letters: ['X'], descriptorBusType: 7, isBoot: false, isSystem: false, isOffline: false, isReadOnly: false,
  eligible: true, readEligible: true, eligibleReadOnly: true
};
const records = [];
// Narrow reruns avoid repeating already-passed mocked contracts during review.
const selectedCase = process.env.HUAIDJ_DISK_CLIENT_CASE;
assert.ok(!selectedCase || ['details', 'cancel', 'readonly', 'timeout'].includes(selectedCase), 'Unknown isolated disk-client test case.');

test('disk client contracts and asynchronous state stay inside an isolated mocked project', {
  skip: process.platform !== 'win32' ? 'These Windows client-contract mocks require win32; they never access physical devices.' :
    typeof nodeModule.registerHooks !== 'function' ? 'Synchronous loader hooks require Node 22.15 or newer.' : false
}, async t => {
  await mkdir(path.join(fixtureRoot, 'images'), { recursive: true });
  const image = path.join(fixtureRoot, 'images', 'sample.img');
  const imageBytes = Buffer.alloc(1024 * 1024);
  await writeFile(image, imageBytes);
  const digest = createHash('sha256').update(imageBytes).digest('hex');
  await writeFile(path.join(fixtureRoot, 'config.json'), JSON.stringify({
    powershell: 'mock-powershell-never-executed', imageRoots: [path.join(fixtureRoot, 'images')],
    imageAliases: { sample: image }, planLifetimeSeconds: 900
  }));
  let currentDevice = { ...device };
  let startBehavior = 'success';
  globalThis.__huaidjDiskClientMock = async (_command, args) => {
    const operation = args[args.indexOf('-Operation') + 1];
    if (operation === 'Devices') return { stdout: JSON.stringify({ devices: [currentDevice] }), stderr: '' };
    if (operation === 'Details') return { stdout: JSON.stringify({ disks: [{
      number: currentDevice.number, serial: currentDevice.serial, partitions: [{
        number: 3, offset: 1048576, size: 16 * 1024 ** 3,
        volume: { filesystem: 'NTFS', label: 'Private Label' }
      }]
    }] }), stderr: '' };
    if (operation === 'StartJob') {
      const requestPath = args[args.indexOf('-RequestPath') + 1];
      if (startBehavior === 'cancel') {
        const error = new Error('Synthetic cancellation');
        error.code = 1;
        error.stdout = JSON.stringify({ error: 'ELEVATION_CANCELLED', message: 'Administrator approval was cancelled.' });
        throw error;
      }
      if (startBehavior === 'spawned-then-timeout') {
        await writeFile(path.join(path.dirname(requestPath), 'status.json'), JSON.stringify({
          phase: 'validating-device', success: false, final: false, progress: 0, pid: 123456,
          message: 'Synthetic elevated worker has started before the response was lost.'
        }));
        const error = new Error('Synthetic launcher timeout after worker spawn');
        error.code = 'ETIMEDOUT'; error.killed = true; error.signal = 'SIGTERM';
        throw error;
      }
      return { stdout: JSON.stringify({ started: true, pid: 123456 }), stderr: '' };
    }
    throw new Error(`Unexpected mock operation ${operation}`);
  };
  const fakeChildModule = `
    import { promisify } from 'node:util';
    export function execFile() { throw new Error('Callback execFile is not used by these clients'); }
    execFile[promisify.custom] = (...args) => globalThis.__huaidjDiskClientMock(...args);
  `;
  const hook = nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'node:child_process' && context.parentURL?.includes('/src/core.mjs'))
        return { url: `data:text/javascript,${encodeURIComponent(fakeChildModule)}`, shortCircuit: true };
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      const parsed = new URL(url);
      if (parsed.protocol === 'file:' && ['/src/core.mjs', '/src/locks.mjs'].some(suffix => parsed.pathname.endsWith(suffix))) {
        const source = readFileSync(fileURLToPath(parsed), 'utf8');
        const needle = parsed.pathname.endsWith('/src/core.mjs') ? /export const projectRoot = [^;]+;/ : /const projectRoot = [^;]+;/;
        assert.ok(needle.test(source), 'The test fixture root seam must match exactly once.');
        return { format: 'module', source: source.replace(needle,
          `${parsed.pathname.endsWith('/src/core.mjs') ? 'export ' : ''}const projectRoot = ${JSON.stringify(fixtureRoot)};`), shortCircuit: true };
      }
      return nextLoad(url, context);
    }
  });
  try {
    const disks = await import('../src/disks.mjs');
    const core = await import('../src/core.mjs');

    await t.test('Details uses backend disks/partitions/number keys and redacts private serials/labels', { skip: selectedCase && selectedCase !== 'details' }, async () => {
      const details = await disks.diskDetails(4);
      assert.equal(details.disks[0].serial, undefined);
      assert.equal(details.disks[0].partitions[0].volume.label, undefined);
      const plan = await disks.prepareDiskOperation({ operation: 'format-volume', deviceNumber: 4, partitionNumber: 3, filesystem: 'FAT32' });
      const stored = JSON.parse(await readFile(path.join(fixtureRoot, 'state', 'jobs', plan.planId, 'plan.json'), 'utf8'));
      assert.equal(stored.request.partitionNumber, 3);
      assert.equal(stored.request.partitionOffset, 1048576);
      assert.equal(stored.request.partitionSize, 16 * 1024 ** 3);
      records.push({ name: 'details and partition contract', passed: true });
    });

    await t.test('a confirmed UAC cancellation releases the USB lock and records failure', { skip: selectedCase && selectedCase !== 'cancel' }, async () => {
      currentDevice = { ...device }; startBehavior = 'cancel';
      const plan = await disks.prepareDiskOperation({ operation: 'initialize-usb', deviceNumber: 4, filesystem: 'exFAT' });
      await assert.rejects(disks.startDiskOperation({ planId: plan.planId, confirmation: plan.requiredConfirmation, confirmErase: true }), { code: 'ELEVATION_CANCELLED' });
      await assert.rejects(stat(path.join(fixtureRoot, 'state', 'locks', identity)), { code: 'ENOENT' });
      const status = await core.jobStatus(plan.planId);
      assert.equal(status.state, 'start-failed');
      assert.equal(status.error.code, 'ELEVATION_CANCELLED');
      records.push({ name: 'known cancellation releases lock', passed: true });
    });

    await t.test('readonly USB supports verification while formatting stays refused', { skip: selectedCase && selectedCase !== 'readonly' }, async () => {
      currentDevice = { ...device, isReadOnly: true, eligible: false, eligibleReadOnly: true }; startBehavior = 'success';
      const plan = await disks.prepareDiskOperation({ operation: 'verify-image', deviceNumber: 4, image: 'sample', expectedSha256: digest });
      const started = await disks.startDiskOperation({ planId: plan.planId, confirmation: plan.requiredConfirmation });
      assert.equal(started.started, true);
      await assert.rejects(disks.prepareDiskOperation({ operation: 'initialize-usb', deviceNumber: 4, filesystem: 'exFAT' }), { code: 'DEVICE_NOT_ELIGIBLE' });
      // This is a synthetic worker: write its terminal status to exercise normal release.
      await writeFile(path.join(fixtureRoot, 'state', 'jobs', plan.planId, 'status.json'), JSON.stringify({ final: true, success: true, phase: 'verified' }));
      assert.equal((await core.jobStatus(plan.planId)).state, 'completed');
      records.push({ name: 'readonly verification eligibility', passed: true });
    });

    await t.test('a timeout after worker spawn keeps the target claimed and never reports definite start failure', { skip: selectedCase && selectedCase !== 'timeout' }, async () => {
      currentDevice = { ...device }; startBehavior = 'spawned-then-timeout';
      const plan = await disks.prepareDiskOperation({ operation: 'initialize-usb', deviceNumber: 4, filesystem: 'exFAT' });
      await assert.rejects(disks.startDiskOperation({ planId: plan.planId, confirmation: plan.requiredConfirmation, confirmErase: true }), { code: 'SUBMISSION_UNKNOWN' });
      const stored = JSON.parse(await readFile(path.join(fixtureRoot, 'state', 'jobs', plan.planId, 'plan.json'), 'utf8'));
      assert.equal(stored.state, 'submission-unknown', 'A spawned worker with a lost response has an unknown result.');
      const owner = JSON.parse(await readFile(path.join(fixtureRoot, 'state', 'locks', identity, 'owner.json'), 'utf8'));
      assert.equal(owner.jobId, plan.planId);
      const status = await core.jobStatus(plan.planId);
      assert.equal(status.state, 'submission-unknown');
      assert.equal(status.engineReportedSuccess, false);
      records.push({ name: 'uncertain start remains claimed', passed: true });
    });
  } finally {
    hook.deregister();
    delete globalThis.__huaidjDiskClientMock;
    // Evidence stays in a new F-drive work fixture; no existing user files are removed.
    await writeFile(path.join(fixtureRoot, 'test-records.json'), JSON.stringify({
      records, noPowerShellExecuted: true, noUac: true, noPhysicalDiskWrites: true
    }, null, 2));
  }
});
