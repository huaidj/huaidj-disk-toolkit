import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const actualProject = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = path.join(actualProject, 'state', 'test-fixtures', `native-client-${randomUUID()}`);
const identity = 'a'.repeat(64);
const baseDevice = {
  number: 4, model: 'Synthetic Native USB', size: 64 * 1024 ** 3, busType: 'USB', serial: 'native-test-serial',
  identity, descriptorBusType: 7, letters: ['X'], isBoot: false, isSystem: false, isOffline: false,
  isReadOnly: false, eligible: true
};
const selectedCase = process.env.HUAIDJ_NATIVE_CLIENT_CASE;
const caseNames = ['format', 'image', 'wrong-executor', 'cancel', 'timeout', 'target', 'plan-options', 'plan-mode'];
assert.ok(!selectedCase || caseNames.includes(selectedCase), 'Unknown isolated native-client test case.');
const records = [];

test('native client plans and async launches use an isolated mocked project', {
  skip: process.platform !== 'win32' ? 'Windows client-contract mocks require win32; no physical device is accessed.' :
    typeof nodeModule.registerHooks !== 'function' ? 'Loader hooks require Node 22.15 or newer.' : false
}, async t => {
  await mkdir(path.join(fixtureRoot, 'images'), { recursive: true });
  await mkdir(path.join(fixtureRoot, 'bin'), { recursive: true });
  // Only a stat fixture. The fake child-process adapter never executes this file.
  await writeFile(path.join(fixtureRoot, 'bin', 'rufus-huaidj.exe'), 'NOT AN EXECUTABLE: isolated native client fixture');
  const bytes = Buffer.alloc(1024 * 1024);
  bytes[510] = 0x55; bytes[511] = 0xaa; bytes[450] = 0x83; bytes.writeUInt32LE(100, 458);
  const image = path.join(fixtureRoot, 'images', 'hybrid.img');
  await writeFile(image, bytes);
  const digest = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path.join(fixtureRoot, 'config.json'), JSON.stringify({
    powershell: 'mock-powershell-never-executed', imageRoots: [path.join(fixtureRoot, 'images')],
    imageAliases: { hybrid: image }, planLifetimeSeconds: 900
  }));
  let device = { ...baseDevice };
  let startBehavior = 'success';
  let onNextInventory = null;
  const calls = [];
  const submissions = [];
  globalThis.__huaidjNativeClientMock = async (_command, args) => {
    const operation = args[args.indexOf('-Operation') + 1];
    calls.push(operation);
    if (operation === 'Devices') {
      if (onNextInventory) { const action = onNextInventory; onNextInventory = null; await action(); }
      return { stdout: JSON.stringify({ devices: [device] }), stderr: '' };
    }
    if (operation === 'StartEngine') {
      const requestPath = args[args.indexOf('-RequestPath') + 1];
      const request = JSON.parse(await readFile(requestPath, 'utf8'));
      submissions.push(request);
      if (startBehavior === 'cancel') {
        const error = new Error('Synthetic explicit cancellation');
        error.code = 1;
        error.stdout = JSON.stringify({ error: 'ELEVATION_CANCELLED', message: 'Administrator approval was cancelled.', started: false });
        throw error;
      }
      if (startBehavior === 'spawned-then-timeout') {
        await writeFile(path.join(path.dirname(requestPath), 'status.json'), JSON.stringify({
          phase: 'native-preflight', progress: 0, success: false, final: false, pid: 123456
        }));
        const error = new Error('Synthetic lost launcher response after worker start');
        error.code = 'ETIMEDOUT'; error.killed = true; error.signal = 'SIGTERM';
        throw error;
      }
      return { stdout: JSON.stringify({ started: true, pid: 123456 }), stderr: '' };
    }
    throw new Error(`Unexpected mocked operation ${operation}`);
  };
  const fakeChildModule = `
    import { promisify } from 'node:util';
    export function execFile() { throw new Error('The callback child-process path must never execute'); }
    execFile[promisify.custom] = (...args) => globalThis.__huaidjNativeClientMock(...args);
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
        const exported = parsed.pathname.endsWith('/src/core.mjs');
        const needle = exported ? /export const projectRoot = [^;]+;/ : /const projectRoot = [^;]+;/;
        assert.ok(needle.test(source));
        return { format: 'module', source: source.replace(needle, `${exported ? 'export ' : ''}const projectRoot = ${JSON.stringify(fixtureRoot)};`), shortCircuit: true };
      }
      return nextLoad(url, context);
    }
  });
  const directory = planId => path.join(fixtureRoot, 'state', 'jobs', planId);
  const loadPlan = async planId => JSON.parse(await readFile(path.join(directory(planId), 'plan.json'), 'utf8'));
  const savePlan = (planId, value) => writeFile(path.join(directory(planId), 'plan.json'), JSON.stringify(value));
  const reset = () => { device = { ...baseDevice }; startBehavior = 'success'; onNextInventory = null; };
  const skip = name => ({ skip: selectedCase && selectedCase !== name });
  try {
    const core = await import('../src/core.mjs');
    const disks = await import('../src/disks.mjs');
    const formatOptions = { filesystem: 'fat32', partitionScheme: 'gpt', clusterSize: 32768, volumeLabel: 'DJ TEST', quickFormat: true };
    const makeFormat = () => core.prepareNativeFormat({ deviceNumber: 4, nativeOptions: formatOptions });
    const makeImage = () => core.prepareWrite({ deviceNumber: 4, image: 'hybrid', expectedSha256: digest, mode: 'dd' });
    async function finishSynthetic(planId, success = true) {
      await writeFile(path.join(directory(planId), 'status.json'), JSON.stringify({ final: true, success, phase: success ? 'completed' : 'failed' }));
      return core.jobStatus(planId);
    }

    await t.test('format-only plan has null image and submits no fabricated image fields or mode', skip('format'), async () => {
      reset();
      const preview = await makeFormat();
      const plan = await loadPlan(preview.planId);
      assert.equal(plan.kind, 'native-format');
      assert.equal(plan.image, null);
      assert.equal(Object.hasOwn(plan, 'mode'), false);
      const started = await core.startWrite({ planId: preview.planId, confirmation: preview.requiredConfirmation, confirmErase: true });
      assert.equal(started.started, true);
      const request = submissions.at(-1);
      assert.equal(request.operation, 'format');
      for (const field of ['imagePath', 'imageSHA256', 'mode']) assert.equal(Object.hasOwn(request, field), false, field);
      assert.deepEqual(request.nativeOptions, { ...formatOptions, targetSystem: 'auto' });
      assert.equal((await finishSynthetic(preview.planId)).state, 'completed');
      records.push({ name: 'format-only request contract', passed: true });
    });

    await t.test('image plan submits its actual source digest and DD has no quick-format override', skip('image'), async () => {
      reset();
      const preview = await makeImage();
      const plan = await loadPlan(preview.planId);
      assert.equal(plan.kind, 'native-image');
      assert.equal(plan.image.sha256, digest);
      await core.startWrite({ planId: preview.planId, confirmation: preview.requiredConfirmation, confirmErase: true });
      const request = submissions.at(-1);
      assert.equal(request.operation, 'image');
      assert.equal(request.imagePath, image);
      assert.equal(request.imageSHA256, digest);
      assert.equal(request.mode, 'dd');
      assert.equal(request.nativeOptions.quickFormat, null);
      assert.equal(Object.hasOwn(request, 'quickFormat'), false);
      assert.deepEqual(request.nativeOptions, { filesystem: 'auto', partitionScheme: 'auto', targetSystem: 'auto', clusterSize: 'auto', volumeLabel: null, quickFormat: null });
      await finishSynthetic(preview.planId);
      const before = calls.length;
      await assert.rejects(core.prepareWrite({ deviceNumber: 4, image: 'hybrid', expectedSha256: digest, mode: 'dd', nativeOptions: { quickFormat: true } }), { code: 'DD_OPTIONS_INAPPLICABLE' });
      assert.equal(calls.length, before);
      records.push({ name: 'image and DD request contract', passed: true });
    });

    await t.test('disk-operation plans cannot use the native executor or contact its backend', skip('wrong-executor'), async () => {
      reset();
      const preview = await disks.prepareDiskOperation({ operation: 'initialize-usb', deviceNumber: 4, filesystem: 'exFAT' });
      const before = calls.length;
      await assert.rejects(core.startWrite({ planId: preview.planId, confirmation: preview.requiredConfirmation, confirmErase: true }), { code: 'WRONG_PLAN_KIND' });
      assert.equal(calls.length, before);
      records.push({ name: 'wrong executor refused before backend', passed: true });
    });

    await t.test('explicit native-launch cancellation releases its exact USB reservation', skip('cancel'), async () => {
      reset();
      const preview = await makeFormat(); startBehavior = 'cancel';
      await assert.rejects(core.startWrite({ planId: preview.planId, confirmation: preview.requiredConfirmation, confirmErase: true }), { code: 'ELEVATION_CANCELLED' });
      assert.equal((await loadPlan(preview.planId)).state, 'start-failed');
      await assert.rejects(stat(path.join(fixtureRoot, 'state', 'locks', identity)), { code: 'ENOENT' });
      records.push({ name: 'native cancellation releases reservation', passed: true });
    });

    await t.test('native StartEngine timeout retains submission-unknown reservation until a final result', skip('timeout'), async () => {
      reset();
      const preview = await makeFormat(); startBehavior = 'spawned-then-timeout';
      await assert.rejects(core.startWrite({ planId: preview.planId, confirmation: preview.requiredConfirmation, confirmErase: true }), { code: 'SUBMISSION_UNKNOWN' });
      assert.equal((await loadPlan(preview.planId)).state, 'submission-unknown');
      const owner = JSON.parse(await readFile(path.join(fixtureRoot, 'state', 'locks', identity, 'owner.json'), 'utf8'));
      assert.equal(owner.jobId, preview.planId);
      assert.equal((await core.jobStatus(preview.planId)).state, 'submission-unknown');
      await finishSynthetic(preview.planId, false);
      await assert.rejects(stat(path.join(fixtureRoot, 'state', 'locks', identity)), { code: 'ENOENT' });
      records.push({ name: 'native uncertain submission lifecycle', passed: true });
    });

    await t.test('changed physical identity refuses native submission before it claims a target', skip('target'), async () => {
      reset();
      const preview = await makeFormat();
      device = { ...baseDevice, identity: 'b'.repeat(64), serial: 'replacement-serial' };
      const before = submissions.length;
      await assert.rejects(core.startWrite({ planId: preview.planId, confirmation: preview.requiredConfirmation, confirmErase: true }), { code: 'DEVICE_CHANGED' });
      assert.equal(submissions.length, before);
      assert.equal((await loadPlan(preview.planId)).state, 'prepared');
      records.push({ name: 'changed target refused', passed: true });
    });

    await t.test('changed native options during validation are rejected and preserved', skip('plan-options'), async () => {
      reset();
      const preview = await makeFormat();
      onNextInventory = async () => {
        const changed = await loadPlan(preview.planId);
        changed.nativeOptions.volumeLabel = 'EDITED';
        await savePlan(preview.planId, changed);
      };
      const before = submissions.length;
      await assert.rejects(core.startWrite({ planId: preview.planId, confirmation: preview.requiredConfirmation, confirmErase: true }), { code: 'PLAN_CHANGED' });
      assert.equal(submissions.length, before);
      assert.equal((await loadPlan(preview.planId)).nativeOptions.volumeLabel, 'EDITED');
      records.push({ name: 'concurrent native-options plan edit refused', passed: true });
    });

    await t.test('changed image mode during validation is rejected instead of overwriting the newer plan', skip('plan-mode'), async () => {
      reset();
      const preview = await makeImage();
      onNextInventory = async () => {
        const changed = await loadPlan(preview.planId);
        changed.mode = 'iso';
        await savePlan(preview.planId, changed);
      };
      const before = submissions.length;
      try {
        await assert.rejects(core.startWrite({ planId: preview.planId, confirmation: preview.requiredConfirmation, confirmErase: true }), { code: 'PLAN_CHANGED' });
        assert.equal(submissions.length, before);
        assert.equal((await loadPlan(preview.planId)).mode, 'iso');
        records.push({ name: 'concurrent image-mode plan edit refused', passed: true });
      } finally {
        // End only a synthetic mock worker if this regression exposed a launch.
        if (submissions.length > before) await finishSynthetic(preview.planId, false);
      }
    });
  } finally {
    hook.deregister();
    delete globalThis.__huaidjNativeClientMock;
    await writeFile(path.join(fixtureRoot, 'test-records.json'), JSON.stringify({
      records, capturedRequests: submissions, noPowerShellExecuted: true, noNativeExecuted: true, noUac: true, noPhysicalDiskWrites: true
    }, null, 2));
  }
});
