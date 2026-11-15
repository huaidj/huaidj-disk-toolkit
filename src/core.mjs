import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeError, inspectImage } from './images.mjs';
import { withStateTransaction, claimDeviceLock, releaseDeviceLock } from './locks.mjs';
import { normalizeNativeOptions } from './native-options.mjs';

const execFileAsync = promisify(execFile);
export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateRoot = path.join(projectRoot, 'state');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function config() {
  let settings;
  try { settings = JSON.parse((await readFile(path.join(projectRoot, 'config.json'), 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    settings = JSON.parse((await readFile(path.join(projectRoot, 'config.example.json'), 'utf8')).replace(/^\uFEFF/, ''));
  }
  const imageRoots = (settings.imageRoots ?? ['./images']).map(root => path.resolve(projectRoot, root));
  const selectedRoot = process.env.HUAIDJ_SELECTED_IMAGE_ROOT;
  if (selectedRoot && path.isAbsolute(selectedRoot) && !selectedRoot.startsWith('\\\\')) imageRoots.push(path.resolve(selectedRoot));
  return { planLifetimeSeconds: 900, ...settings, powershell: settings.powershell ?? 'pwsh', imageRoots };
}
async function readJson(filename) { return JSON.parse((await readFile(filename, 'utf8')).replace(/^\uFEFF/, '')); }
async function writeJson(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx' });
  await rename(temporary, filename);
}
function jobDirectory(id) {
  if (!UUID.test(id ?? '')) throw new BridgeError('INVALID_JOB_ID', 'Use the job or plan ID returned by this bridge.');
  return path.join(stateRoot, 'jobs', id);
}
function publicDevice(device) {
  const { number, model, size, busType, isBoot, isSystem, isReadOnly, identity, letters, eligible, partitionStyle } = device;
  const readEligible = busType?.toUpperCase() === 'USB' && !isBoot && !isSystem && !device.isOffline && device.descriptorBusType === 7 && Boolean(device.serial) && /^[a-f0-9]{64}$/.test(identity ?? '');
  return { number, model, size, busType, isBoot, isSystem, isReadOnly, identity, letters, eligible, readEligible, partitionStyle };
}
export function classifyLaunchFailure(error, operation) {
  const privilegedLaunch = ['StartEngine', 'StartJob', 'VerifyImage'].includes(operation);
  if (privilegedLaunch && !['ENOENT', 'EACCES', 'ENOTDIR', 'EINVAL'].includes(error.code))
    return new BridgeError('SUBMISSION_UNKNOWN', 'The privileged launch outcome is unknown. The USB reservation is retained; query this job and resolve any outstanding Windows prompt before another operation.');
  return new BridgeError('WINDOWS_BACKEND_FAILED', `The Windows backend did not complete (${error.code ?? 'unknown launch error'}). Check the configured PowerShell runtime and device access.`);
}
export async function windowsBackend(operation, args = [], script = 'windows-backend.ps1') {
  if (!['windows-backend.ps1', 'disk-backend.ps1'].includes(script)) throw new BridgeError('UNKNOWN_BACKEND', 'The selected fixed backend is not available.');
  if (process.platform !== 'win32') throw new BridgeError('WINDOWS_ADAPTER_REQUIRED', 'Physical disk operations in this release require Windows. Compatibility queries are available across platforms.');
  const settings = await config();
  try {
    const result = await execFileAsync(settings.powershell, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(projectRoot, 'src', script), '-Operation', operation, ...args
    ], { windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' });
    const response = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
    if (response.error) throw new BridgeError(response.code ?? response.error, String(response.message ?? response.error));
    return response;
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    if (error.stdout) {
      try { const parsed = JSON.parse(error.stdout.replace(/^\uFEFF/, '').trim()); if (parsed.error) throw new BridgeError(parsed.code ?? parsed.error, String(parsed.message ?? parsed.error)); }
      catch (parsedError) { if (parsedError instanceof BridgeError) throw parsedError; }
    }
    throw classifyLaunchFailure(error, operation);
  }
}
const backend = windowsBackend;

export async function bridgeStatus() {
  const settings = await config();
  let engineAvailable = false;
  try { engineAvailable = (await stat(path.join(projectRoot, 'bin', 'rufus-huaidj.exe'))).isFile(); } catch {}
  return {
    name: 'HuaiDJ Disk Toolkit', version: '0.1.0', transport: 'stdio', platform: process.platform, legacyMcpKey: 'huaidj-rufus',
    nativeEngineAvailable: engineAvailable,
    engine: 'Rufus native engine with a restricted background automation adapter',
    modes: ['dd', 'iso'], imageAliases: Object.keys(settings.imageAliases ?? {}),
    elevation: 'Windows UAC may require user interaction before physical USB writing.',
    limitations: ['Unknown Rufus warnings stop automation.', 'ISO mode is restricted to non-Windows bootable images; prompts for additional bootloader downloads stop automation.', 'USB writing does not install an operating system on an internal drive.']
  };
}
export async function listDevices() {
  const response = await backend('Devices');
  return { devices: (response.devices ?? []).map(publicDevice) };
}
export async function inspectDiskImage(image, expectedSha256) { return inspectImage(image, expectedSha256, await config(), projectRoot); }

export function requireEligibleDevice(device, identity, { write = true } = {}) {
  if (!device || device.busType?.toUpperCase() !== 'USB' || device.isBoot || device.isSystem || device.isOffline || !device.serial || !/^[a-f0-9]{64}$/.test(device.identity ?? '') ||
      (write ? device.isReadOnly || device.eligible !== true : device.descriptorBusType !== 7))
    throw new BridgeError('DEVICE_NOT_ELIGIBLE', 'The target must be an identified writable USB device containing no active system or boot volume.');
  if (identity && device.identity !== identity)
    throw new BridgeError('DEVICE_CHANGED', 'The USB identity changed. Prepare a new plan for the intended physical device.');
}
export async function prepareWrite({ deviceNumber, image, expectedSha256, mode = 'dd', nativeOptions = {} }) {
  if (!Number.isInteger(deviceNumber) || deviceNumber < 0 || !['dd', 'iso'].includes(mode))
    throw new BridgeError('INVALID_REQUEST', 'Supply a physical disk number and dd or iso mode.');
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256 ?? ''))
    throw new BridgeError('SHA256_REQUIRED', 'A complete expected SHA-256 is required before preparing a destructive write.');
  const options = normalizeNativeOptions(nativeOptions, { mode, operation: 'image' });
  const inventory = await backend('Devices');
  const device = inventory.devices?.find(d => d.number === deviceNumber);
  requireEligibleDevice(device);
  const imageInfo = await inspectDiskImage(image, expectedSha256);
  if (device.size <= imageInfo.size) throw new BridgeError('USB_TOO_SMALL', 'The physical USB must be larger than the selected image.');
  if (mode === 'dd' && !imageInfo.rawWriteEligible)
    throw new BridgeError('RAW_IMAGE_REQUIRED', 'DD mode requires a partitioned/hybrid disk image. Use ISO mode for a supported non-hybrid ISO.');
  if (mode === 'iso' && !imageInfo.discImage)
    throw new BridgeError('ISO_REQUIRED', 'ISO mode requires an ISO9660 or UDF disc image.');
  const settings = await config();
  const id = randomUUID();
  const directory = jobDirectory(id);
  await mkdir(directory, { recursive: true });
  const plan = {
    id, createdUTC: new Date().toISOString(),
    expiresUTC: new Date(Date.now() + settings.planLifetimeSeconds * 1000).toISOString(),
    kind: 'native-image', device, image: imageInfo, mode, nativeOptions: options,
    confirmation: `ERASE:${device.number}:${device.size}`,
    state: 'prepared'
  };
  await writeJson(path.join(directory, 'plan.json'), plan);
  return {
    planId: id, expiresUTC: plan.expiresUTC, target: publicDevice(device),
    image: { path: imageInfo.path, sha256: imageInfo.sha256, size: imageInfo.size }, mode, nativeOptions: options,
    requiredConfirmation: plan.confirmation,
    effect: 'The entire selected USB, including all its partitions and files, will be overwritten. Internal operating-system partitions are not part of this operation.'
  };
}

export async function prepareNativeFormat({ deviceNumber, nativeOptions }) {
  if (!Number.isInteger(deviceNumber) || deviceNumber < 0 || deviceNumber > 255) throw new BridgeError('INVALID_DEVICE_NUMBER', 'Select a current physical USB device number.');
  const options = normalizeNativeOptions(nativeOptions, { operation: 'format' });
  const inventory = await backend('Devices');
  const device = inventory.devices?.find(d => d.number === deviceNumber);
  requireEligibleDevice(device);
  if (options.filesystem === 'fat32' && device.size > 32 * 1024 ** 3 && options.quickFormat !== true) throw new BridgeError('LARGE_FAT32_QUICK_REQUIRED', 'The native large-FAT32 path supports quick formatting only.');
  const id = randomUUID(), directory = jobDirectory(id), settings = await config();
  await mkdir(directory, { recursive: true });
  const plan = { id, kind: 'native-format', state: 'prepared', createdUTC: new Date().toISOString(), expiresUTC: new Date(Date.now() + settings.planLifetimeSeconds * 1000).toISOString(), device, nativeOptions: options, image: null, confirmation: `ERASE:${device.number}:${device.size}` };
  await writeJson(path.join(directory, 'plan.json'), plan);
  return { planId: id, expiresUTC: plan.expiresUTC, target: publicDevice(device), nativeOptions: options, requiredConfirmation: plan.confirmation, effect: 'The Rufus non-bootable formatter will erase and reinitialize the entire selected USB. No source ISO or synthetic image hash is used.' };
}

export async function startWrite({ planId, confirmation, confirmErase = false, dryRun = false }) {
  if (confirmErase !== true && !dryRun)
    throw new BridgeError('ERASE_NOT_CONFIRMED', 'Explicit confirmation is required to erase the selected USB.');
  const directory = jobDirectory(planId);
  let plan;
  try { plan = await readJson(path.join(directory, 'plan.json')); }
  catch { throw new BridgeError('PLAN_NOT_FOUND', 'Prepare a USB write plan first.'); }
  const reviewedPlanSnapshot = JSON.stringify(plan);
  if (plan.id !== planId || plan.state !== 'prepared') throw new BridgeError('PLAN_ALREADY_USED', 'This plan is not available for a new write.');
  if (plan.kind && !['native-image', 'native-format'].includes(plan.kind)) throw new BridgeError('WRONG_PLAN_KIND', 'Use the executor matching this disk operation plan.');
  if (!Number.isFinite(Date.parse(plan.expiresUTC)) || Date.now() > Date.parse(plan.expiresUTC)) throw new BridgeError('PLAN_EXPIRED', 'The plan expired. Prepare a new plan.');
  if (confirmation !== plan.confirmation) throw new BridgeError('CONFIRMATION_MISMATCH', 'The confirmation must match the prepared physical target exactly.');
  const inventory = await backend('Devices');
  const device = inventory.devices?.find(d => d.number === plan.device.number);
  requireEligibleDevice(device, plan.device.identity);
  if (device.size !== plan.device.size || device.serial !== plan.device.serial)
    throw new BridgeError('DEVICE_CHANGED', 'The physical USB no longer matches the plan.');
  const formatOnly = plan.kind === 'native-format';
  if (!formatOnly) await inspectDiskImage(plan.image.path, plan.image.sha256);
  const engineInfo = await bridgeStatus();
  if (!engineInfo.nativeEngineAvailable) throw new BridgeError('ENGINE_UNAVAILABLE', 'The verified native Rufus engine has not been built or installed. No write was started.');
  let claimed = false;
  try {
    await withStateTransaction(async () => {
      const currentPlan = await readJson(path.join(directory, 'plan.json'));
      if (currentPlan.id !== planId || currentPlan.state !== 'prepared')
        throw new BridgeError('PLAN_ALREADY_USED', 'This plan was already claimed by another operation.');
      if (JSON.stringify(currentPlan) !== reviewedPlanSnapshot)
        throw new BridgeError('PLAN_CHANGED', 'The plan changed during validation. Prepare a new plan.');
      await claimDeviceLock(device.identity, planId);
      claimed = true;
      plan.state = dryRun ? 'dry-run-starting' : 'starting';
      await writeJson(path.join(directory, 'plan.json'), plan);
    });
    const statusPath = path.join(directory, 'status.json');
    const request = {
      deviceNumber: device.number, size: device.size, serial: device.serial, identity: device.identity,
      operation: formatOnly ? 'format' : 'image', nativeOptions: plan.nativeOptions, statusPath,
      confirm: plan.confirmation, dryRun: Boolean(dryRun)
    };
    if (!formatOnly) Object.assign(request, { imagePath: plan.image.path, imageSHA256: plan.image.sha256, mode: plan.mode });
    const requestPath = path.join(directory, 'request.json');
    await writeJson(requestPath, request);
    const result = await backend('StartEngine', ['-RequestPath', requestPath]);
    plan.state = dryRun ? 'dry-run-running' : 'running';
    plan.pid = result.pid;
    plan.startedUTC = new Date().toISOString();
    await writeJson(path.join(directory, 'plan.json'), plan);
    return { jobId: planId, started: true, dryRun, pid: result.pid, target: publicDevice(device), message: 'Poll usb_write_status for the native result. A started process is not a completed write.' };
  } catch (error) {
    if (claimed) {
      plan.state = error.code === 'SUBMISSION_UNKNOWN' ? 'submission-unknown' : 'start-failed';
      plan.error = { code: error.code ?? 'START_FAILED', message: error.message };
      await writeJson(path.join(directory, 'plan.json'), plan).catch(() => {});
      if (error.code !== 'SUBMISSION_UNKNOWN') await releaseDeviceLock(device.identity, planId);
    }
    throw error;
  }
}

export async function jobStatus(jobId) {
  const directory = jobDirectory(jobId);
  let plan;
  try { plan = await readJson(path.join(directory, 'plan.json')); }
  catch { throw new BridgeError('JOB_NOT_FOUND', 'The job ID is not known to this bridge.'); }
  let native = null;
  try { native = await readJson(path.join(directory, 'status.json')); } catch {}
  if (native?.final === true) await releaseDeviceLock(plan.device.identity, jobId);
  return {
    jobId, state: native?.final ? (native.success ? 'completed' : 'failed') : plan.state,
    target: publicDevice(plan.device), dryRun: plan.state.startsWith('dry-run'),
    result: native, error: plan.error ?? null,
    engineReportedSuccess: native?.final === true && native?.success === true
  };
}
