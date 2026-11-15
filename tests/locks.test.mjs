import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, lstat, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStateLocks } from '../src/locks.mjs';

const run = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const moduleUrl = new URL('../src/locks.mjs', import.meta.url).href;
const stateBase = path.join(projectRoot, 'state');
const identityA = 'a'.repeat(64);
const identityB = 'b'.repeat(64);

async function present(filename) {
  try { return await lstat(filename); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function fixture() {
  const stateRoot = path.join(stateBase, `lock-tests-${randomUUID()}`);
  const manager = createStateLocks({ stateRoot });
  return {
    stateRoot, manager,
    async cleanup({ ownEmptyGuard = false } = {}) {
      const relative = path.relative(stateBase, stateRoot);
      assert.match(relative, /^lock-tests-[a-f0-9-]{36}$/);
      // Only this test's own known files and empty directories are removed.
      for (const identity of [identityA, identityB]) {
        const directory = path.join(stateRoot, 'locks', identity);
        const filename = path.join(directory, 'owner.json');
        if (await present(filename)) await unlink(filename);
        if (await present(directory)) await rmdir(directory);
      }
      const lockRoot = path.join(stateRoot, 'locks');
      if (await present(lockRoot)) await rmdir(lockRoot);
      if (ownEmptyGuard) {
        const guard = path.join(stateRoot, 'transaction-lock');
        if (await present(guard)) await rmdir(guard);
      }
      if (await present(stateRoot)) await rmdir(stateRoot);
    }
  };
}

test('independent Node processes cannot claim the same USB concurrently', async () => {
  const f = fixture();
  const jobIds = [randomUUID(), randomUUID()];
  const script = `
    import { createStateLocks } from ${JSON.stringify(moduleUrl)};
    const [stateRoot, identity, jobId] = process.argv.slice(1);
    try {
      await createStateLocks({ stateRoot }).claimDeviceLock(identity, jobId);
      console.log(JSON.stringify({ ok: true, jobId }));
    } catch (error) { console.log(JSON.stringify({ ok: false, code: error.code })); }
  `;
  try {
    const results = await Promise.all(jobIds.map(jobId => run(process.execPath,
      ['--input-type=module', '-e', script, f.stateRoot, identityA, jobId],
      { windowsHide: true, timeout: 15000 })));
    const outcomes = results.map(result => JSON.parse(result.stdout));
    assert.equal(outcomes.filter(result => result.ok).length, 1);
    assert.equal(outcomes.filter(result => result.code === 'USB_BUSY').length, 1);
    const winner = outcomes.find(result => result.ok);
    const owner = JSON.parse(await readFile(path.join(f.stateRoot, 'locks', identityA, 'owner.json'), 'utf8'));
    assert.equal(owner.jobId, winner.jobId);
    assert.equal((await f.manager.releaseDeviceLock(identityA, winner.jobId)).released, true);
  } finally { await f.cleanup(); }
});

test('an old job release cannot remove a newer owner', async () => {
  const f = fixture();
  const oldJob = randomUUID();
  const newJob = randomUUID();
  try {
    await f.manager.claimDeviceLock(identityA, oldJob);
    assert.equal((await f.manager.releaseDeviceLock(identityA, oldJob)).released, true);
    await f.manager.claimDeviceLock(identityA, newJob);
    const ownerFile = path.join(f.stateRoot, 'locks', identityA, 'owner.json');
    const before = await readFile(ownerFile, 'utf8');
    const result = await f.manager.releaseDeviceLock(identityA, oldJob);
    assert.equal(result.released, false);
    assert.equal(result.reason, 'owner-mismatch');
    assert.equal(await readFile(ownerFile, 'utf8'), before);
    assert.equal((await f.manager.releaseDeviceLock(identityA, newJob)).released, true);
  } finally { await f.cleanup(); }
});

test('concurrent claims for different USB identities both succeed', async () => {
  const f = fixture();
  const jobA = randomUUID();
  const jobB = randomUUID();
  try {
    const results = await Promise.all([
      f.manager.claimDeviceLock(identityA, jobA),
      f.manager.claimDeviceLock(identityB, jobB)
    ]);
    assert.equal(results.filter(result => result.claimed).length, 2);
    await Promise.all([
      f.manager.releaseDeviceLock(identityA, jobA),
      f.manager.releaseDeviceLock(identityB, jobB)
    ]);
  } finally { await f.cleanup(); }
});

test('explicit transaction can call claim and release without nested deadlock', async () => {
  const f = fixture();
  const job = randomUUID();
  try {
    await f.manager.withStateTransaction(async () => {
      assert.equal((await f.manager.claimDeviceLock(identityA, job)).claimed, true);
      assert.equal((await f.manager.releaseDeviceLock(identityA, job)).released, true);
    });
    assert.equal(await present(path.join(f.stateRoot, 'transaction-lock')), null);
  } finally { await f.cleanup(); }
});

test('a pre-existing transaction guard is bounded and never automatically deleted', async () => {
  const f = fixture();
  const guard = path.join(f.stateRoot, 'transaction-lock');
  await mkdir(guard, { recursive: true });
  try {
    const manager = createStateLocks({ stateRoot: f.stateRoot, waitMs: 80 });
    const start = performance.now();
    await assert.rejects(manager.claimDeviceLock(identityA, randomUUID()), { code: 'STATE_BUSY' });
    assert.ok(performance.now() - start < 1000);
    assert.ok((await lstat(guard)).isDirectory());
  } finally { await f.cleanup({ ownEmptyGuard: true }); }
});

test('invalid identities, job IDs, and roots cannot escape project state', async () => {
  const f = fixture();
  await assert.rejects(f.manager.claimDeviceLock('../escape', randomUUID()), { code: 'INVALID_DEVICE_IDENTITY' });
  await assert.rejects(f.manager.releaseDeviceLock(identityA, '../escape'), { code: 'INVALID_JOB_ID' });
  assert.throws(() => createStateLocks({ stateRoot: projectRoot }), { code: 'INVALID_LOCK_PATH' });
  assert.throws(() => createStateLocks({ stateRoot: f.stateRoot, waitMs: 5001 }), { code: 'INVALID_LOCK_TIMEOUT' });
  assert.equal(await present(f.stateRoot), null);
});
