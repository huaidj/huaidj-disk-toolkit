import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, realpath, readdir, mkdir, open, readFile, writeFile, rename, statfs } from 'node:fs/promises';
import { BridgeError, isWithin } from './images.mjs';
import { claimDeviceLock, releaseDeviceLock } from './locks.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateRoot = path.join(projectRoot, 'state');
const fixtureRoot = path.join(stateRoot, 'test-fixtures');
const META = 'PIONEER/rekordbox';
const ANALYSIS = 'PIONEER/USBANLZ';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/i;
const SNAPSHOT_SUMMARY_LIMIT = 64 * 1024;
const SNAPSHOT_LIST_MANIFEST_LIMIT = 4 * 1024 * 1024;
const declaredVersion = value => value === null || (typeof value === 'string' && value.length <= 64 && /^\d+(?:\.\d+){0,3}(?:[-+][a-z0-9._-]+)?$/i.test(value));
const utcInstant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));
const run = promisify(execFile);
const sources = [
  'https://rekordbox.com/en/support/faq/library-7/',
  'https://rekordbox.com/en/support/faq/rekordbox7/',
  'https://rekordbox.com/en/support/faq/devicelibraryplus-6/',
  'https://alphatheta.com/en/information/important-notice-for-customers-using-usb-devices-with-our-dj-equipment/',
  'https://rekordbox.com/en/2026/03/important-notice-regarding-rekordbox-v7212/',
  'https://rekordbox.com/en/2026/03/rekordbox-v7213-release-information/'
];
const candidates = [
  ['export.pdb', 'traditional-candidate'], ['exportExt.pdb', 'traditional-companion-candidate'],
  ['exportLibrary.db', 'new-library-candidate'], ['exportLibrary.db-wal', 'sqlite-sidecar-candidate'],
  ['exportLibrary.db-shm', 'sqlite-sidecar-candidate'], ['exportLibrary.db-journal', 'sqlite-sidecar-candidate']
];
const fail = (code, message) => { throw new BridgeError(code, message); };
const digest = value => createHash('sha256').update(value).digest('hex');
const identityKey = identity => JSON.stringify({ kind: identity.kind, identity: identity.identity, volumeIdentity: identity.volumeIdentity ?? null, rootFingerprint: identity.rootFingerprint });
const contentKey = entries => digest(JSON.stringify(entries.map(e => [e.path, e.type, e.type === 'file' ? e.stat?.size ?? e.size : null, e.sha256 ?? null])));
const equalPath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const stamp = info => ({ size: info.size.toString(), mtimeNs: info.mtimeNs.toString(), ctimeNs: info.ctimeNs.toString(), ino: info.ino.toString(), dev: info.dev.toString() });
const equalStat = (a, b) => JSON.stringify(stamp(a)) === JSON.stringify(stamp(b));
async function present(filename) { try { return await lstat(filename, { bigint: true }); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
function cleanRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes(':') || /[\u0000-\u001f]/.test(value) || value.split('/').some(s => !s || s === '.' || s === '..'))
    fail('INVALID_METADATA_PATH', 'Metadata manifest paths must be safe relative paths.');
  if (!value.startsWith(`${META}/`) && value !== META && !value.startsWith(`${ANALYSIS}/`) && value !== ANALYSIS)
    fail('METADATA_SCOPE_REQUIRED', 'Only the fixed exported-library metadata roots are allowed.');
  if (/^master\.db(?:$|[.-])/i.test(path.posix.basename(value)))
    fail('MAIN_DATABASE_FORBIDDEN', 'Desktop master databases are outside this export-only workflow.');
  return value;
}
async function plainNode(filename, boundary, { allowMissing = false } = {}) {
  const info = await present(filename);
  if (!info && allowMissing) return null;
  if (!info || info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()) || (info.isFile() && info.nlink > 1n))
    fail('UNSAFE_METADATA_NODE', 'Metadata must contain ordinary directories and single-link regular files.');
  const actual = await realpath(filename);
  if (!isWithin(actual, boundary)) fail('METADATA_ESCAPES_ROOT', 'A metadata path resolves outside its approved root.');
  return info;
}
async function safeDirectoryChain(directory, { create = false, allowMissing = false } = {}) {
  const resolved = path.resolve(directory);
  if (!isWithin(resolved, stateRoot)) fail('STATE_SCOPE_REQUIRED', 'Snapshot and plan state must remain in this project state directory.');
  let current = projectRoot;
  const actualProject = await realpath(projectRoot);
  if (!equalPath(actualProject, projectRoot)) fail('STATE_LINK_FORBIDDEN', 'The project state cannot use an unverified linked root.');
  for (const part of path.relative(projectRoot, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (create) { try { await mkdir(current); } catch (e) { if (e.code !== 'EEXIST') throw e; } }
    const info = await present(current);
    if (!info && allowMissing && !create) return null;
    if (!info || !info.isDirectory() || info.isSymbolicLink() || !equalPath(await realpath(current), current))
      fail('STATE_LINK_FORBIDDEN', 'State directories must be ordinary local project directories.');
  }
  return resolved;
}
async function atomicJson(filename, value, exclusive = false) {
  if (exclusive && await present(filename)) fail('STATE_ALREADY_EXISTS', 'An existing snapshot or record cannot be overwritten.');
  const temp = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(temp, filename);
}
async function hashFile(filename, boundary) {
  const before = await plainNode(filename, boundary);
  if (!before.isFile()) fail('REGULAR_FILE_REQUIRED', 'A regular metadata file is required.');
  const handle = await open(filename, 'r');
  const hash = createHash('sha256');
  try {
    const opened = await handle.stat({ bigint: true });
    if (!equalStat(before, opened)) fail('SOURCE_CHANGED', 'Metadata changed while opening a file.');
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); }
    if (!equalStat(opened, await handle.stat({ bigint: true }))) fail('SOURCE_CHANGED', 'Metadata changed while hashing a file.');
  } finally { await handle.close(); }
  const after = await plainNode(filename, boundary);
  if (!equalStat(before, after)) fail('SOURCE_CHANGED', 'Metadata changed during file verification.');
  return { sha256: hash.digest('hex'), info: after };
}
async function copyVerified(source, destination, boundary, destinationBoundary) {
  const before = await plainNode(source, boundary);
  await plainNode(path.dirname(destination), destinationBoundary);
  const input = await open(source, 'r');
  let output;
  const hash = createHash('sha256');
  try {
    if (!equalStat(before, await input.stat({ bigint: true }))) fail('SOURCE_CHANGED', 'Metadata changed before copying.');
    output = await open(destination, 'wx', 0o600);
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) { const result = await output.write(buffer, written, bytesRead - written, null); if (!result.bytesWritten) fail('SHORT_METADATA_WRITE', 'A metadata copy made no progress.'); written += result.bytesWritten; }
    }
    await output.sync();
    if (!equalStat(before, await input.stat({ bigint: true }))) fail('SOURCE_CHANGED', 'Metadata changed while copying.');
  } finally { await input.close(); if (output) await output.close(); }
  if (!equalStat(before, await plainNode(source, boundary))) fail('SOURCE_CHANGED', 'A source file changed after copying.');
  return hash.digest('hex');
}
async function defaultProcessProbe() {
  try {
    if (process.platform === 'win32') {
      const { config } = await import('./core.mjs');
      const settings = await config();
      const result = await run(settings.powershell, ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; $p=@(Get-Process -Name 'rekordbox*' -ErrorAction Stop); @{running=($p.Count -gt 0);count=$p.Count}|ConvertTo-Json -Compress"], { windowsHide: true, timeout: 15000, encoding: 'utf8', maxBuffer: 65536 });
      return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
    }
    const result = await run('ps', ['-axo', 'comm='], { timeout: 15000, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
    const count = result.stdout.split(/\r?\n/).filter(name => /^rekordbox/i.test(path.basename(name.trim()))).length;
    return { running: count > 0, count };
  } catch { fail('REKORDBOX_PROCESS_STATE_UNKNOWN', 'The local rekordbox process state could not be verified. No mutation is allowed.'); }
}
async function defaultUsbIdentity(root) {
  if (process.platform !== 'win32' || !/^[a-z]:\\$/i.test(root)) return { kind: 'local-folder', identity: digest(root), rootFingerprint: digest(root) };
  const { windowsBackend, requireEligibleDevice, config } = await import('./core.mjs');
  const inventory = await windowsBackend('Devices');
  const matches = inventory.devices?.filter(d => d.letters?.some(letter => letter.toUpperCase() === root[0].toUpperCase())) ?? [];
  if (matches.length !== 1) fail('MEDIA_IDENTITY_UNKNOWN', 'The exact media root cannot be mapped to one physical USB.');
  const device = matches[0];
  requireEligibleDevice(device);
  const settings = await config();
  const command = `$v=Get-Volume -DriveLetter '${root[0].toUpperCase()}' -ErrorAction Stop; @{id=[string]$v.UniqueId;path=[string]$v.Path}|ConvertTo-Json -Compress`;
  let volume;
  try { const result = await run(settings.powershell, ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 15000, encoding: 'utf8', maxBuffer: 65536 }); volume = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim()); }
  catch { fail('VOLUME_IDENTITY_UNKNOWN', 'The target volume identity could not be verified without elevation.'); }
  const volumePrefix = '\\\\?\\Volume{';
  if (!volume.id || !volume.path?.startsWith(volumePrefix) || !volume.path.endsWith('}\\') || !UUID.test(volume.path.slice(volumePrefix.length, -2)))
    fail('VOLUME_IDENTITY_UNKNOWN', 'A stable local Windows volume path is required for restoration.');
  return { kind: 'windows-usb', identity: device.identity, volumeIdentity: digest(volume.id), deviceNumber: device.number, size: device.size, rootFingerprint: digest(volume.id), ioRoot: volume.path };
}

/** Test dependencies are trusted local code; they are never CLI/MCP request fields. */
export function createExportLibraryManager({ processProbe = defaultProcessProbe, snapshotRoot = path.join(stateRoot, 'snapshots'), testHooks = {} } = {}) {
  snapshotRoot = path.resolve(snapshotRoot);
  if (!isWithin(snapshotRoot, path.join(stateRoot, 'snapshots'))) fail('SNAPSHOT_SCOPE_REQUIRED', 'Snapshots must stay in the project snapshot directory.');
  const previewRoot = path.join(stateRoot, 'export-restore-previews');
  const journalsRoot = path.join(stateRoot, 'export-restore-jobs');

  async function stopped() {
    const result = await processProbe();
    if (!result || typeof result.running !== 'boolean') fail('REKORDBOX_PROCESS_STATE_UNKNOWN', 'The local rekordbox process state is unknown.');
    if (result.running) fail('REKORDBOX_RUNNING', 'Close all local rekordbox versions and helpers before snapshot or restoration.');
  }
  async function bind(rootPath, restore = false) {
    if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath) || rootPath.startsWith('\\\\') || rootPath.includes('\0'))
      fail('LOCAL_MEDIA_ROOT_REQUIRED', 'Supply an absolute local media-root directory.');
    const root = path.resolve(rootPath);
    const info = await present(root);
    if (!info || !info.isDirectory() || info.isSymbolicLink()) fail('UNSAFE_MEDIA_ROOT', 'The media root must be an ordinary local directory.');
    const canonicalRoot = await realpath(root);
    if (!equalPath(root, canonicalRoot)) fail('LINKED_MEDIA_ROOT', 'The media root itself cannot use a junction or symbolic-link alias.');
    const fixture = isWithin(canonicalRoot, fixtureRoot) && !equalPath(canonicalRoot, fixtureRoot);
    if (!fixture) {
      const homes = [...new Set([process.env.USERPROFILE, process.env.HOME].filter(Boolean))];
      const activeLibraries = [
        ...[process.env.APPDATA, process.env.LOCALAPPDATA].filter(Boolean).map(base => path.join(base, 'Pioneer', 'rekordbox')),
        ...homes.flatMap(home => [path.join(home, 'Library', 'Pioneer', 'rekordbox'), path.join(home, 'Library', 'Application Support', 'Pioneer', 'rekordbox'), path.join(home, 'AppData', 'Roaming', 'Pioneer', 'rekordbox')])
      ];
      const protectedDirectories = [process.env.SystemRoot, process.env.ProgramFiles, process.env.ProgramData, process.env.APPDATA, process.env.LOCALAPPDATA].filter(Boolean);
      for (const protectedRoot of [...protectedDirectories, ...activeLibraries]) {
        const canonical = await realpath(protectedRoot).catch(() => path.resolve(protectedRoot));
        const metadataRoot = path.join(canonicalRoot, ...META.split('/'));
        if (isWithin(canonicalRoot, canonical) || isWithin(metadataRoot, canonical))
          fail('PROTECTED_ROOT', 'System, app-data and active desktop-library roots are outside this export-only workflow.');
      }
    }
    if (isWithin(canonicalRoot, snapshotRoot) || isWithin(snapshotRoot, canonicalRoot))
      fail('SNAPSHOT_SOURCE_OVERLAP', 'The snapshot destination must not overlap the media source.');
    const identity = fixture ? { kind: 'fixture', identity: digest(canonicalRoot), rootFingerprint: digest(canonicalRoot) } : await defaultUsbIdentity(canonicalRoot);
    if (restore && !['fixture', 'windows-usb'].includes(identity.kind)) fail('RESTORE_MEDIA_IDENTITY_REQUIRED', 'Restore requires an identified USB volume or an owned project test fixture.');
    const ioRoot = identity.ioRoot ?? canonicalRoot;
    if (identity.ioRoot && !equalPath(await realpath(ioRoot), canonicalRoot)) fail('VOLUME_IDENTITY_CHANGED', 'The stable volume path does not resolve to the selected root.');
    const publicIdentity = { ...identity }; delete publicIdentity.ioRoot;
    return { canonicalRoot, ioRoot, publicIdentity, alias: identity.kind === 'fixture' ? 'test-media' : identity.kind === 'windows-usb' ? `usb-${identity.identity.slice(0, 12)}` : 'local-export-copy' };
  }
  async function rebind(rootPath, media, restore = false) {
    const current = await bind(rootPath, restore);
    if (identityKey(current.publicIdentity) !== identityKey(media.publicIdentity)) fail('MEDIA_IDENTITY_CHANGED', 'The selected media identity changed. Prepare a new operation.');
    return current;
  }
  async function tree(media, roots, hashes = false) {
    const entries = [];
    const seen = new Set();
    async function visit(rel) {
      cleanRelative(rel);
      const folded = rel.toLowerCase();
      if (seen.has(folded)) fail('AMBIGUOUS_METADATA_CASE', 'Metadata paths collide under a case-insensitive comparison.');
      seen.add(folded);
      const abs = path.join(media.ioRoot, ...rel.split('/'));
      const info = await plainNode(abs, media.canonicalRoot);
      const entry = { path: rel, type: info.isDirectory() ? 'directory' : 'file', stat: stamp(info) };
      if (hashes && info.isFile()) entry.sha256 = (await hashFile(abs, media.canonicalRoot)).sha256;
      entries.push(entry);
      if (entries.length > 500000) fail('METADATA_TREE_TOO_LARGE', 'The metadata tree exceeds the bounded snapshot limit; no partial snapshot is complete.');
      if (info.isDirectory()) for (const child of (await readdir(abs)).sort()) await visit(`${rel}/${child}`);
    }
    for (const rel of roots) {
      // Check each fixed ancestor, including PIONEER, before following the child.
      const pioneer = await plainNode(path.join(media.ioRoot, 'PIONEER'), media.canonicalRoot, { allowMissing: true });
      if (!pioneer) continue;
      if (!pioneer.isDirectory()) fail('METADATA_DIRECTORY_REQUIRED', 'PIONEER must be an ordinary directory.');
      if (await plainNode(path.join(media.ioRoot, ...rel.split('/')), media.canonicalRoot, { allowMissing: true })) await visit(rel);
    }
    return entries.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  }
  const fingerprint = entries => digest(JSON.stringify(entries));
  async function freeSpace() {
    let current = snapshotRoot;
    while (!await present(current)) current = path.dirname(current);
    const actual = await realpath(current);
    if (!isWithin(actual, projectRoot)) fail('STATE_LINK_FORBIDDEN', 'The snapshot storage parent resolves outside the project.');
    try { const s = await statfs(current, { bigint: true }); return (s.bavail * s.bsize).toString(); } catch { return 'unknown'; }
  }
  async function previewInternal(rootPath, includeAnalysis = false) {
    if (typeof includeAnalysis !== 'boolean') fail('INVALID_ANALYSIS_OPTION', 'includeAnalysis must be a boolean.');
    const media = await bind(rootPath);
    const roots = includeAnalysis ? [META, ANALYSIS] : [META];
    const entries = await tree(media, roots);
    const files = entries.filter(e => e.type === 'file');
    const bytes = files.reduce((n, e) => n + BigInt(e.stat.size), 0n);
    return { media, roots, entries, result: { mediaAlias: media.alias, mediaIdentity: media.publicIdentity, metadataRoots: roots, fileCount: files.length, directoryCount: entries.length - files.length, bytes: bytes.toString(), snapshotFreeBytes: await freeSpace(), includeAnalysis, musicIncluded: false, treeFingerprint: fingerprint(entries), note: 'Only export metadata is counted. Contents music files are neither scanned nor included.' } };
  }
  async function locked(media, jobId, fn) {
    await claimDeviceLock(media.publicIdentity.identity, jobId);
    try { return await fn(); } finally { await releaseDeviceLock(media.publicIdentity.identity, jobId); }
  }
  async function inspectExportLibrary({ rootPath, hashDatabases = false } = {}) {
    if (typeof hashDatabases !== 'boolean') fail('INVALID_HASH_OPTION', 'hashDatabases must be a boolean.');
    const media = await bind(rootPath);
    const entries = await tree(media, [META]);
    const files = new Map(entries.filter(e => e.type === 'file').map(e => [e.path, e]));
    const databases = [];
    for (const [name, role] of candidates) {
      const rel = `${META}/${name}`;
      const entry = files.get(rel);
      const result = { candidate: name, role, present: Boolean(entry), size: entry?.stat.size ?? null, sha256: null };
      if (entry && hashDatabases) result.sha256 = (await hashFile(path.join(media.ioRoot, ...rel.split('/')), media.canonicalRoot)).sha256;
      databases.push(result);
    }
    const markerCount = [...files.keys()].filter(name => /(?:brokendb|broken|corrupt|damaged)/i.test(path.posix.basename(name))).length;
    return { mediaAlias: media.alias, mediaIdentity: media.publicIdentity, metadataDirectoryPresent: entries.some(e => e.path === META), databases,
      presenceEvidence: { traditionalDeviceLibraryCandidate: databases[0].present, newerLibraryCandidate: databases[2].present, completeLibraryValidated: false },
      markerIndicators: { count: markerCount, action: markerCount ? 'Preserve and review; marker names alone do not prove corruption.' : 'No matching marker names were observed.' },
      corruptionVsMismatchUnknown: true, repaired: false,
      notes: ['Candidate filenames indicate presence only; they do not validate database contents or establish complete OneLibrary compatibility.', 'Desktop master databases are never opened. No SQLCipher keys or database modification are used.', 'A library-format mismatch, a version-specific export defect and corruption require different diagnoses.'], sourceURLs: sources };
  }
  async function previewExportSnapshot({ rootPath, includeAnalysis = false } = {}) { return (await previewInternal(rootPath, includeAnalysis)).result; }
  async function createExportSnapshot({ rootPath, exporterVersion, includeAnalysis = false } = {}) {
    if (exporterVersion !== undefined && (typeof exporterVersion !== 'string' || !/^\d+(?:\.\d+){0,3}(?:[-+][a-z0-9._-]+)?$/i.test(exporterVersion) || exporterVersion.length > 64))
      fail('INVALID_DECLARED_EXPORTER_VERSION', 'Use a version identifier or omit the user-declared exporter version.');
    await stopped();
    const preview = await previewInternal(rootPath, includeAnalysis);
    if (!preview.entries.some(e => e.type === 'file' && e.path.startsWith(`${META}/`))) fail('NO_EXPORT_METADATA', 'No exported metadata files were found to snapshot.');
    if (preview.result.snapshotFreeBytes !== 'unknown' && BigInt(preview.result.snapshotFreeBytes) < BigInt(preview.result.bytes) + 1024n * 1024n)
      fail('SNAPSHOT_SPACE_INSUFFICIENT', 'The snapshot volume has insufficient available space.');
    const snapshotId = randomUUID();
    return locked(preview.media, snapshotId, async () => {
      await stopped(); await rebind(rootPath, preview.media);
      await safeDirectoryChain(snapshotRoot, { create: true });
      const directory = path.join(snapshotRoot, snapshotId);
      await mkdir(directory); await mkdir(path.join(directory, 'data'));
      const base = { schemaVersion: 1, snapshotId, status: 'incomplete', createdUTC: new Date().toISOString(), metadataRoots: preview.roots, includeAnalysis, musicIncluded: false,
        sourceIdentity: preview.media.publicIdentity, exporterVersionDeclared: exporterVersion ?? null, exporterVersionEvidence: 'user-declared-only', sourceTreeBefore: preview.entries, sourceURLs: sources };
      await atomicJson(path.join(directory, 'incomplete.json'), base, true);
      try {
        const entries = [];
        for (const e of preview.entries) {
          const dest = path.join(directory, 'data', ...e.path.split('/'));
          if (e.type === 'directory') await mkdir(dest, { recursive: true });
          else {
            await plainNode(path.dirname(path.join(preview.media.ioRoot, ...e.path.split('/'))), preview.media.canonicalRoot);
            const sha256 = await copyVerified(path.join(preview.media.ioRoot, ...e.path.split('/')), dest, preview.media.canonicalRoot, directory);
            const copied = await hashFile(dest, directory);
            if (copied.sha256 !== sha256) fail('SNAPSHOT_COPY_MISMATCH', 'Snapshot read-back hash does not match the copied metadata.');
            entries.push({ path: e.path, type: e.type, size: e.stat.size, sha256, sourceStat: e.stat });
            await testHooks.afterCopyFile?.({ snapshotId, copiedCount: entries.length });
            continue;
          }
          entries.push({ path: e.path, type: e.type, sourceStat: e.stat });
        }
        await stopped(); await rebind(rootPath, preview.media);
        const after = await tree(preview.media, preview.roots, true);
        const noHashes = after.map(({ sha256, ...e }) => e);
        if (fingerprint(noHashes) !== fingerprint(preview.entries)) fail('SOURCE_CHANGED', 'The source metadata tree changed during snapshot creation.');
        for (const e of entries.filter(e => e.type === 'file')) if (after.find(x => x.path === e.path)?.sha256 !== e.sha256)
          fail('SOURCE_CHANGED', 'Source metadata bytes changed during snapshot creation.');
        const manifest = { ...base, status: 'complete', completedUTC: new Date().toISOString(), entries, sourceTreeAfter: noHashes };
        await atomicJson(path.join(directory, 'manifest.json'), manifest, true);
        const snapshotIdentity = digest(await readFile(path.join(directory, 'manifest.json')));
        await atomicJson(path.join(directory, 'summary.json'), { schemaVersion: 1, snapshotId, status: 'complete', summaryOnly: true, createdUTC: manifest.createdUTC, completedUTC: manifest.completedUTC,
          exporterVersionDeclared: exporterVersion ?? null, includeAnalysis, musicIncluded: false, fileCount: entries.filter(e => e.type === 'file').length, bytes: preview.result.bytes, manifestSHA256: snapshotIdentity }, true);
        return { snapshotId, snapshotIdentity, status: 'complete', fileCount: entries.filter(e => e.type === 'file').length, bytes: preview.result.bytes, includeAnalysis, musicIncluded: false, exporterVersionDeclared: exporterVersion ?? null,
          manifest: path.relative(projectRoot, path.join(directory, 'manifest.json')).split(path.sep).join('/'), sourceURLs: sources };
      } catch (e) {
        await atomicJson(path.join(directory, 'failure.json'), { status: 'incomplete', snapshotId, errorCode: e.code ?? 'EXPORT_IO_FAILED', failedUTC: new Date().toISOString(), preserved: true }).catch(() => {});
        const error = new BridgeError(e.code ?? 'EXPORT_SNAPSHOT_FAILED', 'Snapshot was not completed. Its incomplete evidence was preserved; source metadata was not changed.');
        error.snapshotId = snapshotId; throw error;
      }
    });
  }
  async function listExportSnapshots() {
    const snapshots = [];
    const root = await safeDirectoryChain(snapshotRoot, { allowMissing: true });
    const result = () => ({ status: 'ok', summaryOnly: true, snapshots, note: 'History summaries do not verify backup contents or database integrity. Restore preview verifies the complete snapshot before restoration.' });
    if (!root) return result();
    const children = await readdir(root, { withFileTypes: true });
    if (children.length > 10000) fail('SNAPSHOT_HISTORY_TOO_LARGE', 'The snapshot history exceeds the bounded listing limit.');
    async function boundedJson(filename, directory, limit) {
      const before = await plainNode(filename, directory);
      if (!before.isFile()) fail('INVALID_SNAPSHOT_INDEX', 'Snapshot history records must be ordinary files.');
      if (before.size > BigInt(limit)) fail('SNAPSHOT_INDEX_TOO_LARGE', 'This older snapshot requires review before a bounded history summary can be shown.');
      const handle = await open(filename, 'r');
      try {
        if (!equalStat(before, await handle.stat({ bigint: true }))) fail('SNAPSHOT_INDEX_CHANGED', 'A snapshot history record changed while opening.');
        const bytes = Buffer.alloc(limit + 1); let length = 0;
        for (;;) { const read = await handle.read(bytes, length, bytes.length - length, null); length += read.bytesRead; if (!read.bytesRead || length === bytes.length) break; }
        if (length > limit) fail('SNAPSHOT_INDEX_TOO_LARGE', 'This older snapshot requires review before a bounded history summary can be shown.');
        if (!equalStat(before, await handle.stat({ bigint: true })) || !equalStat(before, await plainNode(filename, directory))) fail('SNAPSHOT_INDEX_CHANGED', 'A snapshot history record changed while reading.');
        try { return JSON.parse(bytes.subarray(0, length).toString('utf8')); } catch { fail('INVALID_SNAPSHOT_INDEX', 'A snapshot history record is not valid JSON.'); }
      } finally { await handle.close(); }
    }
    function publicFields(record, snapshotId, complete) {
      if (record.schemaVersion !== 1 || record.snapshotId !== snapshotId || record.musicIncluded !== false || typeof record.includeAnalysis !== 'boolean' || !utcInstant(record.createdUTC) || !declaredVersion(record.exporterVersionDeclared) || (complete && !utcInstant(record.completedUTC)))
        fail('INVALID_SNAPSHOT_INDEX', 'A snapshot history record has invalid identifying or summary fields.');
      return { createdUTC: record.createdUTC, completedUTC: complete ? record.completedUTC : null, exporterVersionDeclared: record.exporterVersionDeclared, includeAnalysis: record.includeAnalysis };
    }
    for (const child of children.filter(entry => UUID.test(entry.name))) {
      const snapshotId = child.name;
      const row = { snapshotId, createdUTC: null, completedUTC: null, exporterVersionDeclared: null, includeAnalysis: null, musicIncluded: false, fileCount: null, bytes: null, status: 'needs-review', summaryOnly: true, indexSource: 'unavailable' };
      try {
        const directory = await safeDirectoryChain(path.join(root, snapshotId));
        const summaryFile = path.join(directory, 'summary.json'), manifestFile = path.join(directory, 'manifest.json');
        if (await present(summaryFile)) {
          const summary = await boundedJson(summaryFile, directory, SNAPSHOT_SUMMARY_LIMIT);
          const fields = publicFields(summary, snapshotId, true);
          if (summary.status !== 'complete' || summary.summaryOnly !== true || !HASH.test(summary.manifestSHA256 ?? '') || !Number.isSafeInteger(summary.fileCount) || summary.fileCount < 1 || summary.fileCount > 500000 || typeof summary.bytes !== 'string' || !/^\d{1,20}$/.test(summary.bytes))
            fail('INVALID_SNAPSHOT_INDEX', 'A snapshot history summary has invalid counts or manifest identity.');
          const manifestInfo = await plainNode(manifestFile, directory);
          if (!manifestInfo.isFile()) fail('INVALID_SNAPSHOT_INDEX', 'The summarized snapshot has no ordinary manifest file.');
          Object.assign(row, fields, { fileCount: summary.fileCount, bytes: summary.bytes, status: 'complete-summary', indexSource: 'summary' });
        } else if (await present(manifestFile)) {
          const manifest = await boundedJson(manifestFile, directory, SNAPSHOT_LIST_MANIFEST_LIMIT);
          const fields = publicFields(manifest, snapshotId, true);
          if (manifest.status !== 'complete' || !Array.isArray(manifest.entries) || manifest.entries.length > 500000 || !Array.isArray(manifest.metadataRoots) || !manifest.metadataRoots.includes(META) || manifest.metadataRoots.some(rel => ![META, ANALYSIS].includes(rel)))
            fail('INVALID_SNAPSHOT_INDEX', 'An older snapshot manifest has invalid metadata summary fields.');
          let fileCount = 0, bytes = 0n; const seen = new Set();
          for (const entry of manifest.entries) {
            cleanRelative(entry.path);
            if (seen.has(entry.path.toLowerCase())) fail('INVALID_SNAPSHOT_INDEX', 'An older snapshot manifest contains duplicate metadata entries.');
            seen.add(entry.path.toLowerCase());
            if (entry.type === 'file' && HASH.test(entry.sha256 ?? '') && typeof entry.size === 'string' && /^\d{1,20}$/.test(entry.size)) { fileCount++; bytes += BigInt(entry.size); }
            else if (entry.type !== 'directory') fail('INVALID_SNAPSHOT_INDEX', 'An older snapshot manifest contains invalid metadata entries.');
          }
          if (!fileCount) fail('INVALID_SNAPSHOT_INDEX', 'An older snapshot has no exported metadata files.');
          Object.assign(row, fields, { fileCount, bytes: bytes.toString(), status: 'complete-summary', indexSource: 'manifest-fallback' });
        } else if (await present(path.join(directory, 'incomplete.json'))) {
          const incomplete = await boundedJson(path.join(directory, 'incomplete.json'), directory, SNAPSHOT_LIST_MANIFEST_LIMIT);
          const fields = publicFields(incomplete, snapshotId, false);
          if (incomplete.status !== 'incomplete') fail('INVALID_SNAPSHOT_INDEX', 'An incomplete snapshot record has invalid status.');
          Object.assign(row, fields, { status: 'incomplete', indexSource: 'incomplete-record' });
        } else row.issueCode = 'SNAPSHOT_RECORD_UNAVAILABLE';
      } catch (e) {
        row.status = ['SNAPSHOT_INDEX_TOO_LARGE', 'SNAPSHOT_INDEX_CHANGED'].includes(e.code) ? 'needs-review' : 'invalid';
        row.issueCode = e instanceof BridgeError ? e.code : 'SNAPSHOT_INDEX_UNAVAILABLE';
      }
      snapshots.push(row);
    }
    snapshots.sort((a, b) => (b.createdUTC ?? '').localeCompare(a.createdUTC ?? '') || a.snapshotId.localeCompare(b.snapshotId));
    return result();
  }
  async function loadSnapshot(snapshotId) {
    if (!UUID.test(snapshotId ?? '')) fail('INVALID_SNAPSHOT_ID', 'Supply a snapshot UUID returned by this toolkit.');
    const directory = await safeDirectoryChain(path.join(snapshotRoot, snapshotId));
    const filename = path.join(directory, 'manifest.json');
    const manifestInfo = await plainNode(filename, directory);
    if (!manifestInfo.isFile() || manifestInfo.size > 256n * 1024n * 1024n) fail('INVALID_SNAPSHOT_MANIFEST', 'The snapshot manifest is invalid or exceeds the bounded limit.');
    const bytes = await readFile(filename);
    let manifest; try { manifest = JSON.parse(bytes.toString('utf8')); } catch { fail('INVALID_SNAPSHOT_MANIFEST', 'The snapshot manifest is not valid JSON.'); }
    if (manifest.schemaVersion !== 1 || manifest.snapshotId !== snapshotId || manifest.status !== 'complete' || manifest.musicIncluded !== false || !Array.isArray(manifest.entries) || manifest.entries.length > 500000 || !Array.isArray(manifest.metadataRoots) || !manifest.metadataRoots.includes(META) || !HASH.test(manifest.sourceIdentity?.identity ?? '') || !HASH.test(manifest.sourceIdentity?.rootFingerprint ?? ''))
      fail('INCOMPLETE_SNAPSHOT', 'Only a complete, export-only snapshot can be restored.');
    if (!manifest.entries.some(e => e.type === 'file' && e.path?.startsWith(`${META}/`))) fail('INCOMPLETE_SNAPSHOT', 'An empty or analysis-only snapshot cannot replace exported metadata.');
    if (manifest.metadataRoots.some(rel => ![META, ANALYSIS].includes(rel))) fail('METADATA_SCOPE_REQUIRED', 'The snapshot contains an unexpected root.');
    const seen = new Set();
    for (const e of manifest.entries) {
      cleanRelative(e.path);
      if (seen.has(e.path.toLowerCase())) fail('INVALID_SNAPSHOT_MANIFEST', 'Snapshot paths are duplicated.'); seen.add(e.path.toLowerCase());
      const absolute = path.join(directory, 'data', ...e.path.split('/'));
      const info = await plainNode(absolute, directory);
      if (e.type === 'directory') { if (!info.isDirectory()) fail('SNAPSHOT_TAMPERED', 'A snapshot directory changed type.'); }
      else if (e.type === 'file' && HASH.test(e.sha256 ?? '') && info.isFile()) {
        if (info.size.toString() !== e.size || (await hashFile(absolute, directory)).sha256 !== e.sha256) fail('SNAPSHOT_TAMPERED', 'Snapshot metadata does not match its recorded size and hash.');
      } else fail('INVALID_SNAPSHOT_MANIFEST', 'The snapshot contains an invalid entry.');
    }
    const dataRoot = path.join(directory, 'data');
    await plainNode(dataRoot, directory);
    const actual = await tree({ ioRoot: dataRoot, canonicalRoot: await realpath(dataRoot) }, manifest.metadataRoots);
    if (JSON.stringify(actual.map(e => [e.path, e.type])) !== JSON.stringify(manifest.entries.map(e => [e.path, e.type]).sort((a, b) => a[0].localeCompare(b[0], 'en'))))
      fail('SNAPSHOT_TAMPERED', 'The snapshot tree has missing or unexpected metadata nodes.');
    return { directory, manifest, snapshotIdentity: digest(bytes) };
  }
  async function previewRestore({ snapshotId, rootPath } = {}) {
    await stopped();
    const snapshot = await loadSnapshot(snapshotId);
    const media = await bind(rootPath, true);
    if (identityKey(snapshot.manifest.sourceIdentity) !== identityKey(media.publicIdentity)) fail('RESTORE_TARGET_MISMATCH', 'This snapshot is bound to different media. Cross-media restoration is not enabled.');
    const targetEntries = await tree(media, [META], true);
    const previewId = randomUUID();
    const plan = { schemaVersion: 1, previewId, snapshotId, snapshotIdentity: snapshot.snapshotIdentity, targetIdentity: media.publicIdentity, targetTreeFingerprint: fingerprint(targetEntries), targetContentFingerprint: contentKey(targetEntries), expiresUTC: new Date(Date.now() + 10 * 60 * 1000).toISOString() };
    await safeDirectoryChain(previewRoot, { create: true }); await atomicJson(path.join(previewRoot, `${previewId}.json`), plan, true);
    return { previewId, snapshotId, snapshotIdentity: snapshot.snapshotIdentity, requiredConfirmation: `RESTORE:${snapshotId}`, expiresUTC: plan.expiresUTC, mediaAlias: media.alias,
      metadataRoot: META, fileCount: snapshot.manifest.entries.filter(e => e.type === 'file' && e.path.startsWith(`${META}/`)).length,
      exporterVersionDeclared: snapshot.manifest.exporterVersionDeclared, musicIncluded: false, analysisRestored: false,
      effect: 'Move existing exported metadata into a new quarantine on the same media, then restore PIONEER/rekordbox only. Music, analysis and desktop master databases are not restored.', sourceURLs: sources };
  }
  async function restoreExportSnapshot({ snapshotId, rootPath, confirmation, confirmRestore = false, expectedSnapshotIdentity, previewId } = {}) {
    if (confirmRestore !== true || confirmation !== `RESTORE:${snapshotId}`) fail('RESTORE_NOT_CONFIRMED', 'Explicit restore confirmation and the exact preview confirmation are required.');
    if (!UUID.test(previewId ?? '') || !HASH.test(expectedSnapshotIdentity ?? '')) fail('RESTORE_PREVIEW_REQUIRED', 'Supply the preview ID and expected snapshot identity returned by previewRestore.');
    await stopped();
    await safeDirectoryChain(previewRoot);
    const previewFile = path.join(previewRoot, `${previewId}.json`);
    await plainNode(previewFile, previewRoot);
    let plan; try { plan = JSON.parse(await readFile(previewFile, 'utf8')); } catch { fail('INVALID_RESTORE_PREVIEW', 'The restore preview could not be read.'); }
    if (plan.previewId !== previewId || plan.snapshotId !== snapshotId || plan.snapshotIdentity !== expectedSnapshotIdentity || !Number.isFinite(Date.parse(plan.expiresUTC)) || Date.now() > Date.parse(plan.expiresUTC)) fail('RESTORE_PREVIEW_CHANGED', 'The restore preview is expired or does not match the expected snapshot.');
    const snapshot = await loadSnapshot(snapshotId);
    if (snapshot.snapshotIdentity !== expectedSnapshotIdentity) fail('SNAPSHOT_TAMPERED', 'The snapshot manifest changed after review.');
    const media = await bind(rootPath, true);
    if (identityKey(media.publicIdentity) !== identityKey(plan.targetIdentity) || identityKey(media.publicIdentity) !== identityKey(snapshot.manifest.sourceIdentity)) fail('RESTORE_TARGET_MISMATCH', 'The target media identity does not match the reviewed snapshot and plan.');
    const operationId = randomUUID();
    return locked(media, operationId, async () => {
      await stopped(); await rebind(rootPath, media, true);
      if (fingerprint(await tree(media, [META], true)) !== plan.targetTreeFingerprint) fail('RESTORE_TARGET_CHANGED', 'Target metadata changed after the restore preview. Preview it again.');
      await safeDirectoryChain(journalsRoot, { create: true });
      const journalFile = path.join(journalsRoot, `${operationId}.json`);
      const relativeStage = `PIONEER/.HuaiDJ-restore-staging/${operationId}`;
      const relativeQuarantine = `PIONEER/.HuaiDJ-restore-quarantine/${operationId}`;
      const stage = path.join(media.ioRoot, ...relativeStage.split('/'));
      const quarantine = path.join(media.ioRoot, ...relativeQuarantine.split('/'));
      const metadata = path.join(media.ioRoot, ...META.split('/'));
      const journal = { schemaVersion: 1, operationId, snapshotId, snapshotIdentity: expectedSnapshotIdentity, targetIdentity: media.publicIdentity, metadataRoot: META, quarantine: relativeQuarantine, staging: relativeStage, state: 'preparing', createdUTC: new Date().toISOString() };
      await atomicJson(journalFile, journal, true);
      let movedOriginal = false, installed = false;
      async function record(state) { journal.state = state; journal.updatedUTC = new Date().toISOString(); await atomicJson(journalFile, journal); }
      async function controlledDirectory(relative) {
        let current = media.ioRoot;
        for (const part of relative.split('/')) { current = path.join(current, part); try { await mkdir(current); } catch (e) { if (e.code !== 'EEXIST') throw e; } const info = await plainNode(current, media.canonicalRoot); if (!info.isDirectory()) fail('RESTORE_SCOPE_CHANGED', 'A controlled restore directory changed type.'); }
      }
      try {
        if (await present(stage) || await present(quarantine)) fail('RESTORE_STATE_ALREADY_EXISTS', 'A restore state directory already exists and was preserved.');
        await controlledDirectory(relativeStage); await controlledDirectory(relativeQuarantine);
        await atomicJson(path.join(stage, 'owner.json'), { operationId, purpose: 'export-metadata-stage' }, true);
        await atomicJson(path.join(quarantine, 'owner.json'), { operationId, purpose: 'export-metadata-rollback' }, true);
        const stagedMetadata = path.join(stage, 'rekordbox'); await mkdir(stagedMetadata);
        const rows = snapshot.manifest.entries.filter(e => e.path.startsWith(`${META}/`));
        for (const e of rows) {
          const relative = e.path.slice(META.length + 1); const dest = path.join(stagedMetadata, ...relative.split('/'));
          if (e.type === 'directory') await mkdir(dest, { recursive: true });
          else {
            if (await copyVerified(path.join(snapshot.directory, 'data', ...e.path.split('/')), dest, snapshot.directory, media.canonicalRoot) !== e.sha256)
              fail('SNAPSHOT_TAMPERED', 'A snapshot file changed while preparing restoration.');
            if ((await hashFile(dest, media.canonicalRoot)).sha256 !== e.sha256) fail('RESTORE_STAGE_VERIFY_FAILED', 'Staged metadata failed read-back verification before quarantine.');
          }
        }
        await stopped(); await rebind(rootPath, media, true);
        if (fingerprint(await tree(media, [META], true)) !== plan.targetTreeFingerprint) fail('RESTORE_TARGET_CHANGED', 'Target metadata changed while staging restoration.');
        await testHooks.beforeQuarantine?.({ operationId });
        await stopped(); await rebind(rootPath, media, true);
        if (fingerprint(await tree(media, [META], true)) !== plan.targetTreeFingerprint) fail('RESTORE_TARGET_CHANGED', 'Target metadata changed immediately before quarantine.');
        if (await present(metadata)) { await rename(metadata, path.join(quarantine, 'rekordbox')); movedOriginal = true; }
        await record('original-quarantined');
        await testHooks.afterQuarantine?.({ operationId });
        await stopped(); await rebind(rootPath, media, true);
        if (await present(metadata)) fail('RESTORE_TARGET_CHANGED', 'New metadata appeared after quarantine; it was preserved.');
        await rename(stagedMetadata, metadata); installed = true;
        await record('restored-verifying');
        const restored = await tree(media, [META], true);
        const expected = snapshot.manifest.entries.filter(e => e.path === META || e.path.startsWith(`${META}/`));
        if (JSON.stringify(restored.map(e => [e.path, e.type, e.sha256 ?? null])) !== JSON.stringify(expected.map(e => [e.path, e.type, e.sha256 ?? null]))) fail('RESTORE_VERIFY_FAILED', 'Restored metadata does not match the verified snapshot.');
        await stopped(); await rebind(rootPath, media, true);
        await record('complete');
        return { operationId, snapshotId, snapshotIdentity: expectedSnapshotIdentity, status: 'complete', metadataRoot: META, originalMetadataPreserved: movedOriginal, quarantine: relativeQuarantine,
          rollbackAvailable: movedOriginal, musicModified: false, analysisRestored: false, note: 'Metadata bytes were restored and verified. Database repair and DJ-hardware readability were not established.' };
      } catch (e) {
        journal.errorCode = e.code ?? 'EXPORT_RESTORE_FAILED';
        let rolledBack = false;
        if (movedOriginal) {
          try {
            await stopped(); await rebind(rootPath, media, true);
            if (installed && await present(metadata)) await rename(metadata, path.join(quarantine, 'failed-restored-rekordbox'));
            if (await present(metadata)) fail('ROLLBACK_TARGET_OCCUPIED', 'Unexpected target metadata was preserved; rollback requires local review.');
            await rename(path.join(quarantine, 'rekordbox'), metadata);
            rolledBack = contentKey(await tree(media, [META], true)) === plan.targetContentFingerprint;
          } catch { /* Preserve quarantine and journal; never delete or overwrite an unexpected node. */ }
        }
        journal.rolledBack = rolledBack;
        await record(rolledBack ? 'failed-rolled-back' : movedOriginal ? 'recovery-required' : 'failed-before-quarantine').catch(() => {});
        const error = new BridgeError(rolledBack ? 'RESTORE_FAILED_ROLLED_BACK' : movedOriginal ? 'RESTORE_RECOVERY_REQUIRED' : e.code ?? 'EXPORT_RESTORE_FAILED', rolledBack ? 'Restoration failed and original exported metadata was restored. Staging and quarantine evidence remain.' : 'Restoration did not complete. Existing metadata, staging and quarantine evidence were preserved for local review.');
        error.operationId = operationId; throw error;
      }
    });
  }
  const guarded = fn => async args => { try { return await fn(args); } catch (e) { if (e instanceof BridgeError) throw e; throw new BridgeError('EXPORT_IO_FAILED', 'An export-metadata filesystem operation failed. Existing data and operation evidence were preserved.'); } };
  return Object.fromEntries(Object.entries({ inspectExportLibrary, previewExportSnapshot, createExportSnapshot, listExportSnapshots, previewRestore, restoreExportSnapshot }).map(([key, fn]) => [key, guarded(fn)]));
}

const manager = createExportLibraryManager();
export const inspectExportLibrary = manager.inspectExportLibrary;
export const previewExportSnapshot = manager.previewExportSnapshot;
export const createExportSnapshot = manager.createExportSnapshot;
export const listExportSnapshots = manager.listExportSnapshots;
export const previewRestore = manager.previewRestore;
export const restoreExportSnapshot = manager.restoreExportSnapshot;
