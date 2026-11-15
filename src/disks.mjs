import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { windowsBackend, projectRoot, config, requireEligibleDevice, inspectDiskImage } from './core.mjs';
import { withStateTransaction, claimDeviceLock, releaseDeviceLock } from './locks.mjs';
import { BridgeError } from './images.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const run = (operation, args = []) => windowsBackend(operation, args, 'disk-backend.ps1');
const directoryFor = id => {
  if (!UUID.test(id ?? '')) throw new BridgeError('INVALID_JOB_ID', 'Supply a toolkit plan ID.');
  return path.join(projectRoot, 'state', 'jobs', id);
};
async function readJson(filename) { return JSON.parse((await readFile(filename, 'utf8')).replace(/^\uFEFF/, '')); }
async function writeJson(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx' });
  await rename(temporary, filename);
}
const publicDevice = device => {
  const { number, model, size, identity, letters, busType, isBoot, isSystem, isReadOnly, eligible } = device;
  return { number, model, size, identity, letters, busType, isBoot, isSystem, isReadOnly, eligible };
};

export async function diskCapabilities() {
  if (process.platform !== 'win32') return { platform: process.platform, physicalDiskAdapter: 'unavailable', operations: [], note: 'This release implements Windows physical disk operations. The sourced compatibility database covers macOS and DJ equipment separately.' };
  return run('Capabilities');
}
export async function diskDetails(deviceNumber) {
  if (!Number.isInteger(deviceNumber) || deviceNumber < 0 || deviceNumber > 255) throw new BridgeError('INVALID_DEVICE_NUMBER', 'Supply a physical disk number from the inventory.');
  const response = await run('Details', ['-DeviceNumber', String(deviceNumber)]);
  // Hardware serials are used internally; expose stable fingerprints to clients instead.
  const hideSerials = object => {
    if (Array.isArray(object)) return object.map(hideSerials);
    if (object && typeof object === 'object') return Object.fromEntries(Object.entries(object).filter(([key]) => !['serial', 'label'].includes(key)).map(([key, value]) => [key, hideSerials(value)]));
    return object;
  };
  return hideSerials(response);
}

export async function prepareDiskOperation({ operation, deviceNumber, partitionNumber, filesystem, label = '', quick = true, partitionStyle = 'GPT', image, expectedSha256 }) {
  if (!['verify-image', 'format-volume', 'initialize-usb'].includes(operation)) throw new BridgeError('INVALID_OPERATION', 'Select verify-image, format-volume or initialize-usb.');
  if (!Number.isInteger(deviceNumber) || deviceNumber < 0 || deviceNumber > 255) throw new BridgeError('INVALID_DEVICE_NUMBER', 'Supply a physical disk number.');
  const inventory = await windowsBackend('Devices');
  const device = inventory.devices.find(item => item.number === deviceNumber);
  requireEligibleDevice(device, undefined, { write: operation !== 'verify-image' });
  const request = { operation, deviceNumber: device.number, size: device.size, serial: device.serial, identity: device.identity };
  if (operation === 'verify-image') {
    const inspected = await inspectDiskImage(image, expectedSha256);
    if (inspected.size > device.size) throw new BridgeError('USB_TOO_SMALL', 'The selected image is larger than the device.');
    request.imagePath = inspected.path;
    request.imageSHA256 = inspected.sha256;
    request.confirm = `VERIFY:${device.number}:${device.size}`;
  } else {
    if (!['FAT', 'FAT32', 'exFAT', 'NTFS', 'UDF'].includes(filesystem)) throw new BridgeError('FILESYSTEM_UNAVAILABLE', 'Select an available portable Windows filesystem; ReFS USB formatting is unsupported.');
    if (typeof label !== 'string' || label.length > 32 || /[\u0000-\u001f]/.test(label)) throw new BridgeError('INVALID_LABEL', 'Supply a valid filesystem label.');
    if (typeof quick !== 'boolean') throw new BridgeError('INVALID_REQUEST', 'quick must be a boolean.');
    request.filesystem = filesystem;
    request.label = label;
    request.quick = quick;
    request.confirm = `ERASE:${device.number}:${device.size}`;
    if (operation === 'format-volume') {
      if (!Number.isInteger(partitionNumber) || partitionNumber < 1) throw new BridgeError('PARTITION_REQUIRED', 'Choose the exact partition number from disk_details.');
      const details = await run('Details', ['-DeviceNumber', String(deviceNumber)]);
      const detailsDisk = details.devices?.find(item => item.number === deviceNumber) ?? details.disks?.find(item => item.number === deviceNumber) ?? details;
      const partition = detailsDisk.partitions?.find(item => item.number === partitionNumber || item.partitionNumber === partitionNumber);
      if (!partition) throw new BridgeError('PARTITION_NOT_FOUND', 'The exact partition was not found in the current disk details.');
      request.partitionNumber = partitionNumber;
      request.partitionOffset = partition.offset;
      request.partitionSize = partition.size;
    } else {
      if (!['GPT', 'MBR'].includes(partitionStyle)) throw new BridgeError('INVALID_PARTITION_STYLE', 'Select GPT or MBR.');
      request.partitionStyle = partitionStyle;
    }
  }
  const settings = await config();
  const id = randomUUID();
  const directory = directoryFor(id);
  await mkdir(directory, { recursive: true });
  request.statusPath = path.join(directory, 'status.json');
  const plan = { id, kind: 'disk-operation', state: 'prepared', createdUTC: new Date().toISOString(), expiresUTC: new Date(Date.now() + settings.planLifetimeSeconds * 1000).toISOString(), device, request };
  await writeJson(path.join(directory, 'plan.json'), plan);
  return { planId: id, operation, target: publicDevice(device), request: { ...request, serial: undefined, statusPath: undefined }, requiredConfirmation: request.confirm, expiresUTC: plan.expiresUTC, effect: operation === 'verify-image' ? 'Read the exact physical image prefix and compare SHA-256; no device write.' : operation === 'format-volume' ? 'Erase all files on the selected partition. Other partitions are not selected.' : 'Erase every partition and file on the selected USB and create the requested partition style and filesystem.' };
}

export async function startDiskOperation({ planId, confirmation, confirmErase = false }) {
  const directory = directoryFor(planId);
  const planPath = path.join(directory, 'plan.json');
  let plan;
  try { plan = await readJson(planPath); } catch { throw new BridgeError('PLAN_NOT_FOUND', 'Prepare the disk operation first.'); }
  const reviewedPlanSnapshot = JSON.stringify(plan);
  if (plan.kind !== 'disk-operation') throw new BridgeError('WRONG_PLAN_KIND', 'Use the operation matching this plan.');
  if (plan.state !== 'prepared') throw new BridgeError('PLAN_ALREADY_USED', 'This disk plan has already been used.');
  if (!Number.isFinite(Date.parse(plan.expiresUTC)) || Date.now() > Date.parse(plan.expiresUTC)) throw new BridgeError('PLAN_EXPIRED', 'Prepare a new unexpired disk plan.');
  if (confirmation !== plan.request.confirm) throw new BridgeError('CONFIRMATION_MISMATCH', 'Use the exact physical-device confirmation from the plan.');
  if (plan.request.operation !== 'verify-image' && confirmErase !== true) throw new BridgeError('ERASE_NOT_CONFIRMED', 'Explicit erase confirmation is required.');
  const inventory = await windowsBackend('Devices');
  const device = inventory.devices.find(item => item.number === plan.device.number);
  requireEligibleDevice(device, plan.device.identity, { write: plan.request.operation !== 'verify-image' });
  let claimed = false;
  try {
    await withStateTransaction(async () => {
      const current = await readJson(planPath);
      if (current.state !== 'prepared' || JSON.stringify(current) !== reviewedPlanSnapshot) throw new BridgeError('PLAN_CHANGED', 'The plan changed or was used during validation.');
      await claimDeviceLock(device.identity, planId);
      claimed = true;
      plan.state = 'starting';
      await writeJson(planPath, plan);
    });
    const requestPath = path.join(directory, 'disk-request.json');
    await writeJson(requestPath, plan.request);
    const started = await run('StartJob', ['-RequestPath', requestPath]);
    plan.state = 'running';
    plan.startedUTC = new Date().toISOString();
    plan.pid = started.pid;
    await writeJson(planPath, plan);
    return { jobId: planId, started: true, operation: plan.request.operation, pid: started.pid, target: publicDevice(device), message: 'Query the job result; process launch is not completion.' };
  } catch (error) {
    if (claimed) {
      plan.state = error.code === 'SUBMISSION_UNKNOWN' ? 'submission-unknown' : 'start-failed'; plan.error = { code: error.code ?? 'START_FAILED', message: error.message };
      await writeJson(planPath, plan).catch(() => {});
      if (error.code !== 'SUBMISSION_UNKNOWN') await releaseDeviceLock(device.identity, planId);
    }
    throw error;
  }
}

export async function verifyUsbImage(options) {
  const plan = await prepareDiskOperation({ ...options, operation: 'verify-image' });
  try { return await startDiskOperation({ planId: plan.planId, confirmation: plan.requiredConfirmation }); }
  catch (error) { error.jobId = plan.planId; throw error; }
}
