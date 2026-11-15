import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, lstat, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { BridgeError } from './images.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultStateRoot = path.join(projectRoot, 'state');
const IDENTITY = /^[a-f0-9]{64}$/i;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function fail(code, message) { throw new BridgeError(code, message); }

function scopedRoot(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value))
    fail('INVALID_LOCK_PATH', 'The lock state root must be an absolute local project state path.');
  const resolved = path.resolve(value);
  const relative = path.relative(defaultStateRoot, resolved);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`))
    fail('INVALID_LOCK_PATH', 'Lock files must remain inside this project state directory.');
  if (relative.split(path.sep).some(part => part && !/^[a-zA-Z0-9._-]+$/.test(part)))
    fail('INVALID_LOCK_PATH', 'The lock state path contains unsupported path components.');
  return resolved;
}

function identifiers(identity, jobId) {
  if (typeof identity !== 'string' || !IDENTITY.test(identity))
    fail('INVALID_DEVICE_IDENTITY', 'A complete SHA-256 USB identity is required.');
  if (typeof jobId !== 'string' || !UUID.test(jobId))
    fail('INVALID_JOB_ID', 'A valid bridge job UUID is required.');
  return { identity: identity.toLowerCase(), jobId: jobId.toLowerCase() };
}

async function safeStat(filename) {
  try { return await lstat(filename); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function requireDirectory(filename) {
  const info = await lstat(filename);
  if (!info.isDirectory() || info.isSymbolicLink())
    fail('INVALID_LOCK_PATH', 'Lock state directories must be ordinary local directories.');
  return info;
}

async function ensureDirectoryChain(filename) {
  const relative = path.relative(projectRoot, filename);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`))
    fail('INVALID_LOCK_PATH', 'Lock state must remain inside the project directory.');
  await requireDirectory(projectRoot);
  let current = projectRoot;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try { await mkdir(current); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await requireDirectory(current);
  }
}

/**
 * Build a lock manager for this project's state directory or one test subdirectory.
 * The short transaction guard is never reclaimed automatically after a crash.
 */
export function createStateLocks({ stateRoot = defaultStateRoot, waitMs = 5000 } = {}) {
  const root = scopedRoot(stateRoot);
  if (!Number.isInteger(waitMs) || waitMs < 1 || waitMs > 5000)
    fail('INVALID_LOCK_TIMEOUT', 'The transaction wait must be between 1 and 5000 milliseconds.');
  const transactionPath = path.join(root, 'transaction-lock');
  const locksRoot = path.join(root, 'locks');
  const contexts = new AsyncLocalStorage();

  async function withStateTransaction(fn) {
    if (typeof fn !== 'function') fail('INVALID_TRANSACTION', 'A transaction callback is required.');
    const inherited = contexts.getStore();
    if (inherited?.active) return fn();
    await ensureDirectoryChain(root);
    const deadline = performance.now() + waitMs;
    let ownedStat;
    while (!ownedStat) {
      try {
        await mkdir(transactionPath);
        ownedStat = await requireDirectory(transactionPath);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await requireDirectory(transactionPath);
        const remaining = deadline - performance.now();
        if (remaining <= 0)
          fail('STATE_BUSY', 'Another state transaction is active. Retry after it finishes; stale guards require manual inspection.');
        await delay(Math.min(25, remaining));
      }
    }
    const context = { active: true };
    let result;
    let callbackError;
    try { result = await contexts.run(context, fn); }
    catch (error) { callbackError = error; }
    finally {
      context.active = false;
      try {
        const current = await safeStat(transactionPath);
        if (!current || !current.isDirectory() || current.isSymbolicLink() ||
            current.dev !== ownedStat.dev || current.ino !== ownedStat.ino)
          fail('LOCK_GUARD_CHANGED', 'The transaction guard changed ownership. It was left for inspection.');
        // Only this transaction's still-empty guard is removed. Never recurse.
        await rmdir(transactionPath);
      } catch (cleanupError) {
        if (!callbackError) callbackError = cleanupError;
        else callbackError.cleanupError = cleanupError;
      }
    }
    if (callbackError) throw callbackError;
    return result;
  }

  async function readOwner(directory) {
    const directoryInfo = await safeStat(directory);
    if (!directoryInfo) return null;
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
      fail('INVALID_LOCK_PATH', 'The USB lock path is not an ordinary directory.');
    const filename = path.join(directory, 'owner.json');
    const info = await safeStat(filename);
    if (!info || !info.isFile() || info.isSymbolicLink() || info.size > 8192)
      fail('LOCK_STATE_INVALID', 'The USB lock has no valid owner record. Inspect it without deleting active locks.');
    let owner;
    try { owner = JSON.parse(await readFile(filename, 'utf8')); }
    catch { fail('LOCK_STATE_INVALID', 'The USB lock owner record is malformed.'); }
    if (!owner || typeof owner.jobId !== 'string' || !UUID.test(owner.jobId) ||
        typeof owner.identity !== 'string' || !IDENTITY.test(owner.identity) ||
        owner.identity.toLowerCase() !== path.basename(directory).toLowerCase())
      fail('LOCK_STATE_INVALID', 'The USB lock owner record does not match the physical identity.');
    return { ...owner, jobId: owner.jobId.toLowerCase(), identity: owner.identity.toLowerCase() };
  }

  async function claimDeviceLock(identity, jobId) {
    const ids = identifiers(identity, jobId);
    return withStateTransaction(async () => {
      await ensureDirectoryChain(locksRoot);
      const directory = path.join(locksRoot, ids.identity);
      if (await safeStat(directory)) {
        await readOwner(directory);
        fail('USB_BUSY', 'Another write job owns this physical USB. Check that job before starting a new one.');
      }
      await mkdir(directory);
      const owner = { ...ids, createdUTC: new Date().toISOString(), ownerPID: process.pid };
      // Exclusive creation: an incomplete record remains closed to future claims.
      await writeFile(path.join(directory, 'owner.json'), JSON.stringify(owner, null, 2), { flag: 'wx' });
      return { claimed: true, ...ids, lockPath: directory };
    });
  }

  async function releaseDeviceLock(identity, jobId) {
    const ids = identifiers(identity, jobId);
    return withStateTransaction(async () => {
      await ensureDirectoryChain(locksRoot);
      const directory = path.join(locksRoot, ids.identity);
      const owner = await readOwner(directory);
      if (!owner) return { released: false, reason: 'absent', ...ids };
      if (owner.jobId !== ids.jobId)
        return { released: false, reason: 'owner-mismatch', ...ids };
      await unlink(path.join(directory, 'owner.json'));
      // Unknown files are retained and make rmdir fail; no recursive cleanup.
      await rmdir(directory);
      return { released: true, ...ids };
    });
  }

  return { withStateTransaction, claimDeviceLock, releaseDeviceLock, stateRoot: root };
}

const locks = createStateLocks();
export const withStateTransaction = locks.withStateTransaction;
export const claimDeviceLock = locks.claimDeviceLock;
export const releaseDeviceLock = locks.releaseDeviceLock;
