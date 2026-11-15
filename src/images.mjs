import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export class BridgeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function resolveImage(input, config, projectRoot) {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0'))
    throw new BridgeError('INVALID_IMAGE', 'Supply a local ISO/IMG path or configured image alias.');
  const requested = config.imageAliases?.[input] ?? input;
  if (/^[a-z]+:\/\//i.test(requested) || requested.startsWith('\\\\'))
    throw new BridgeError('LOCAL_IMAGE_REQUIRED', 'Network images are not supported. Download and verify a local image first.');
  let resolved;
  try { resolved = await realpath(path.resolve(projectRoot, requested)); }
  catch { throw new BridgeError('IMAGE_NOT_FOUND', 'The selected local image cannot be opened.'); }
  const allowedRoots = await Promise.all(config.imageRoots.map(root => realpath(root).catch(() => null)));
  if (!allowedRoots.some(root => root && isWithin(resolved, root)))
    throw new BridgeError('IMAGE_OUTSIDE_ROOTS', 'The selected image is outside the configured local image roots.');
  if (!['.iso', '.img'].includes(path.extname(resolved).toLowerCase()))
    throw new BridgeError('IMAGE_TYPE_NOT_SUPPORTED', 'Only .iso and .img files are accepted.');
  const info = await stat(resolved);
  if (!info.isFile() || info.size < 1024 * 1024)
    throw new BridgeError('INVALID_IMAGE', 'The image must be a regular disk-image file of at least 1 MiB.');
  return { path: resolved, info };
}

export async function sha256File(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

export async function inspectImage(input, expected, config, projectRoot) {
  if (expected !== undefined && !/^[a-f0-9]{64}$/i.test(expected))
    throw new BridgeError('INVALID_SHA256', 'Expected SHA-256 must contain exactly 64 hexadecimal characters.');
  const image = await resolveImage(input, config, projectRoot);
  const handle = await open(image.path, 'r');
  let header;
  try { header = Buffer.alloc(128 * 1024); await handle.read(header, 0, header.length, 0); }
  finally { await handle.close(); }
  const actual = await sha256File(image.path);
  const after = await stat(image.path);
  if (after.size !== image.info.size || after.mtimeMs !== image.info.mtimeMs)
    throw new BridgeError('IMAGE_CHANGED', 'The image changed during verification.');
  if (expected && actual !== expected.toLowerCase())
    throw new BridgeError('CHECKSUM_MISMATCH', 'The image does not match the supplied SHA-256.');
  const hasIso9660 = header.subarray(32769, 32774).toString('ascii') === 'CD001';
  const volumeDescriptors = Array.from({ length: 48 }, (_, i) => header.subarray((16 + i) * 2048 + 1, (16 + i) * 2048 + 6).toString('ascii'));
  const hasUdf = volumeDescriptors.includes('BEA01') && volumeDescriptors.some(id => id === 'NSR02' || id === 'NSR03');
  const hasBootSignature = header[510] === 0x55 && header[511] === 0xaa;
  const hasPartitionTable = hasBootSignature && [0, 1, 2, 3].some(i => {
    const offset = 446 + i * 16;
    return header[offset + 4] !== 0 && header.readUInt32LE(offset + 12) !== 0;
  });
  const hasGpt = header.subarray(512, 520).toString('ascii') === 'EFI PART';
  return {
    path: image.path, size: after.size, sha256: actual,
    expectedHashMatched: expected ? true : null,
    iso9660: hasIso9660, udf: hasUdf, discImage: hasIso9660 || hasUdf, partitionedImage: hasPartitionTable || hasGpt,
    rawWriteEligible: hasPartitionTable || hasGpt,
    note: 'A matching hash verifies bytes against the supplied value; it does not establish the publisher by itself.'
  };
}
