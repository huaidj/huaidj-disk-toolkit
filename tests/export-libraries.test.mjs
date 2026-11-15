import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, readdir, lstat, symlink, rename } from 'node:fs/promises';
import { createExportLibraryManager, listExportSnapshots } from '../src/export-libraries.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testRoot = path.join(projectRoot, 'state', 'test-fixtures');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const run = promisify(execFile);
const exists = filename => lstat(filename).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; });
const json = filename => readFile(filename, 'utf8').then(JSON.parse);

async function fixture(options = {}) {
  const id = randomUUID();
  const base = path.join(testRoot, `export-${id}`);
  const rootPath = path.join(base, 'media');
  const metadata = path.join(rootPath, 'PIONEER', 'rekordbox');
  const snapshotRoot = path.join(projectRoot, 'state', 'snapshots', `export-tests-${id}`);
  await mkdir(path.join(metadata, 'empty'), { recursive: true });
  await mkdir(path.join(rootPath, 'PIONEER', 'USBANLZ'), { recursive: true });
  await mkdir(path.join(rootPath, 'Contents'), { recursive: true });
  const input = { 'export.pdb': 'traditional-v6-fixture', 'exportLibrary.db': 'new-library-fixture', 'exportLibrary.db-wal': 'wal-fixture', 'exportLibrary.db-shm': 'shm-fixture', 'exportLibrary.db-journal': 'journal-fixture' };
  for (const [name, value] of Object.entries(input)) await writeFile(path.join(metadata, name), value);
  await writeFile(path.join(rootPath, 'PIONEER', 'USBANLZ', 'fixture.DAT'), 'analysis-original');
  await writeFile(path.join(rootPath, 'Contents', 'music-original.aiff'), 'music-must-not-be-read-or-restored');
  const manager = createExportLibraryManager({ snapshotRoot, processProbe: async () => ({ running: false }), ...options });
  // Only newly created F:-project fixture bytes are used. Test evidence is retained; no user files or real USB are inspected.
  return { base, rootPath, metadata, snapshotRoot, manager, input };
}
async function restoreArgs(f, snapshot) {
  const preview = await f.manager.previewRestore({ rootPath: f.rootPath, snapshotId: snapshot.snapshotId });
  return { rootPath: f.rootPath, snapshotId: snapshot.snapshotId, previewId: preview.previewId, expectedSnapshotIdentity: preview.snapshotIdentity, confirmation: preview.requiredConfirmation, confirmRestore: true };
}

test('inspection reports filename evidence and markers without declaring a valid or corrupt library', async () => {
  const f = await fixture();
  await writeFile(path.join(f.metadata, 'export.pdb.brokendb'), 'preserved-marker');
  const result = await f.manager.inspectExportLibrary({ rootPath: f.rootPath, hashDatabases: true });
  assert.equal(result.presenceEvidence.traditionalDeviceLibraryCandidate, true);
  assert.equal(result.presenceEvidence.newerLibraryCandidate, true);
  assert.equal(result.presenceEvidence.completeLibraryValidated, false);
  assert.equal(result.corruptionVsMismatchUnknown, true);
  assert.equal(result.markerIndicators.count, 1);
  assert.equal(result.databases.find(d => d.candidate === 'export.pdb').sha256, sha(f.input['export.pdb']));
  assert.equal(result.repaired, false);
  assert.equal(JSON.stringify(result).includes(f.rootPath), false);
  assert.equal(await readFile(path.join(f.metadata, 'export.pdb.brokendb'), 'utf8'), 'preserved-marker');
});

test('snapshot preview counts only metadata, optionally analysis, and creates no snapshot directory', async () => {
  const f = await fixture();
  const preview = await f.manager.previewExportSnapshot({ rootPath: f.rootPath });
  assert.equal(preview.fileCount, 5);
  assert.equal(preview.musicIncluded, false);
  assert.equal(await exists(f.snapshotRoot), false);
  const withAnalysis = await f.manager.previewExportSnapshot({ rootPath: f.rootPath, includeAnalysis: true });
  assert.equal(withAnalysis.fileCount, 6);
  assert.equal(BigInt(withAnalysis.bytes) > BigInt(preview.bytes), true);
  assert.equal(await exists(f.snapshotRoot), false);
});

test('versioned snapshots preserve complete sidecars and do not overwrite earlier snapshots or copy music', async () => {
  const f = await fixture();
  const first = await f.manager.createExportSnapshot({ rootPath: f.rootPath, exporterVersion: '6.8.7', includeAnalysis: true });
  await writeFile(path.join(f.metadata, 'export.pdb'), 'traditional-v7-fixture');
  const second = await f.manager.createExportSnapshot({ rootPath: f.rootPath, exporterVersion: '7.2.13' });
  assert.notEqual(first.snapshotId, second.snapshotId);
  const manifest = await json(path.join(f.snapshotRoot, first.snapshotId, 'manifest.json'));
  assert.equal(manifest.exporterVersionDeclared, '6.8.7');
  assert.equal(manifest.exporterVersionEvidence, 'user-declared-only');
  assert.equal(manifest.entries.some(e => e.path.endsWith('-wal')), true);
  assert.equal(manifest.entries.some(e => e.path.endsWith('-shm')), true);
  assert.equal(manifest.entries.some(e => e.path.endsWith('-journal')), true);
  assert.equal(manifest.entries.some(e => e.path === 'PIONEER/rekordbox/empty'), true);
  assert.equal(manifest.entries.some(e => e.path.startsWith('Contents/')), false);
  assert.equal(await readFile(path.join(f.snapshotRoot, first.snapshotId, 'data', 'PIONEER', 'rekordbox', 'export.pdb'), 'utf8'), 'traditional-v6-fixture');
  assert.equal(await readFile(path.join(f.snapshotRoot, second.snapshotId, 'data', 'PIONEER', 'rekordbox', 'export.pdb'), 'utf8'), 'traditional-v7-fixture');
});

test('running or unverified rekordbox blocks snapshot mutation', async () => {
  const f = await fixture({ processProbe: async () => ({ running: true }) });
  await assert.rejects(f.manager.createExportSnapshot({ rootPath: f.rootPath }), { code: 'REKORDBOX_RUNNING' });
  assert.equal(await exists(f.snapshotRoot), false);
  const unknown = createExportLibraryManager({ snapshotRoot: f.snapshotRoot, processProbe: async () => ({}) });
  await assert.rejects(unknown.createExportSnapshot({ rootPath: f.rootPath }), { code: 'REKORDBOX_PROCESS_STATE_UNKNOWN' });
});

test('source changes during copy leave an incomplete snapshot and preserve the changed source', async () => {
  let f, changed = false;
  f = await fixture({ testHooks: { afterCopyFile: async () => { if (!changed) { changed = true; await writeFile(path.join(f.metadata, 'export.pdb'), 'external-writer-new-value'); } } } });
  let caught;
  try { await f.manager.createExportSnapshot({ rootPath: f.rootPath }); } catch (e) { caught = e; }
  assert.equal(caught?.code, 'SOURCE_CHANGED');
  assert.match(caught.snapshotId, /^[a-f0-9-]{36}$/);
  assert.equal(await exists(path.join(f.snapshotRoot, caught.snapshotId, 'manifest.json')), false);
  assert.equal((await json(path.join(f.snapshotRoot, caught.snapshotId, 'failure.json'))).status, 'incomplete');
  assert.equal(await readFile(path.join(f.metadata, 'export.pdb'), 'utf8'), 'external-writer-new-value');
});

test('junctions out of metadata and a desktop master filename fail before snapshotting', async () => {
  const f = await fixture();
  const outside = path.join(f.base, 'outside');
  await mkdir(outside); await writeFile(path.join(outside, 'private-fixture'), 'never-copy');
  await symlink(outside, path.join(f.metadata, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.manager.createExportSnapshot({ rootPath: f.rootPath }), { code: 'UNSAFE_METADATA_NODE' });
  assert.equal(await exists(f.snapshotRoot), false);
  const master = await fixture();
  await writeFile(path.join(master.metadata, 'master.db'), 'not-an-export-database');
  await assert.rejects(master.manager.inspectExportLibrary({ rootPath: master.rootPath, hashDatabases: true }), { code: 'MAIN_DATABASE_FORBIDDEN' });
});

test('backup tampering, added nodes and traversal manifests fail before restore touches the target', async () => {
  const f = await fixture();
  const snapshot = await f.manager.createExportSnapshot({ rootPath: f.rootPath });
  const saved = path.join(f.snapshotRoot, snapshot.snapshotId, 'data', 'PIONEER', 'rekordbox', 'export.pdb');
  await writeFile(saved, 'tampered');
  await assert.rejects(f.manager.previewRestore({ rootPath: f.rootPath, snapshotId: snapshot.snapshotId }), { code: 'SNAPSHOT_TAMPERED' });
  assert.equal(await readFile(path.join(f.metadata, 'export.pdb'), 'utf8'), f.input['export.pdb']);
  const second = await f.manager.createExportSnapshot({ rootPath: f.rootPath });
  await writeFile(path.join(f.snapshotRoot, second.snapshotId, 'data', 'PIONEER', 'rekordbox', 'unexpected'), 'unexpected');
  await assert.rejects(f.manager.previewRestore({ rootPath: f.rootPath, snapshotId: second.snapshotId }), { code: 'SNAPSHOT_TAMPERED' });
  const third = await f.manager.createExportSnapshot({ rootPath: f.rootPath });
  const manifestFile = path.join(f.snapshotRoot, third.snapshotId, 'manifest.json');
  const manifest = await json(manifestFile); manifest.entries[0].path = 'PIONEER/rekordbox/../../Contents/music.aiff';
  await writeFile(manifestFile, JSON.stringify(manifest));
  await assert.rejects(f.manager.previewRestore({ rootPath: f.rootPath, snapshotId: third.snapshotId }), { code: 'INVALID_METADATA_PATH' });
});

test('controlled fixture restore preserves original metadata in quarantine and leaves music and analysis unchanged', async () => {
  const f = await fixture();
  const snapshot = await f.manager.createExportSnapshot({ rootPath: f.rootPath, exporterVersion: '6.8.7', includeAnalysis: true });
  await writeFile(path.join(f.metadata, 'export.pdb'), 'newer-metadata-to-quarantine');
  await writeFile(path.join(f.metadata, 'extra-journal'), 'preserve-extra-current-file');
  const analysis = path.join(f.rootPath, 'PIONEER', 'USBANLZ', 'fixture.DAT');
  await writeFile(analysis, 'analysis-edited-after-snapshot');
  const args = await restoreArgs(f, snapshot);
  await assert.rejects(f.manager.restoreExportSnapshot({ ...args, confirmRestore: false }), { code: 'RESTORE_NOT_CONFIRMED' });
  const result = await f.manager.restoreExportSnapshot(args);
  assert.equal(result.status, 'complete'); assert.equal(result.originalMetadataPreserved, true);
  assert.equal(await readFile(path.join(f.metadata, 'export.pdb'), 'utf8'), 'traditional-v6-fixture');
  const quarantined = path.join(f.rootPath, ...result.quarantine.split('/'), 'rekordbox');
  assert.equal(await readFile(path.join(quarantined, 'export.pdb'), 'utf8'), 'newer-metadata-to-quarantine');
  assert.equal(await readFile(path.join(quarantined, 'extra-journal'), 'utf8'), 'preserve-extra-current-file');
  assert.equal(await readFile(analysis, 'utf8'), 'analysis-edited-after-snapshot');
  assert.equal(await readFile(path.join(f.rootPath, 'Contents', 'music-original.aiff'), 'utf8'), 'music-must-not-be-read-or-restored');
  assert.equal(result.musicModified, false); assert.equal(result.analysisRestored, false);
});

test('an injected failure after quarantine rolls original metadata back without deleting evidence', async () => {
  const f = await fixture({ testHooks: { afterQuarantine: async () => { throw new Error('injected fixture failure'); } } });
  const snapshot = await f.manager.createExportSnapshot({ rootPath: f.rootPath });
  await writeFile(path.join(f.metadata, 'export.pdb'), 'current-original-must-return');
  const args = await restoreArgs(f, snapshot);
  let caught;
  try { await f.manager.restoreExportSnapshot(args); } catch (e) { caught = e; }
  assert.equal(caught?.code, 'RESTORE_FAILED_ROLLED_BACK');
  assert.equal(await readFile(path.join(f.metadata, 'export.pdb'), 'utf8'), 'current-original-must-return');
  const journal = await json(path.join(projectRoot, 'state', 'export-restore-jobs', `${caught.operationId}.json`));
  assert.equal(journal.state, 'failed-rolled-back');
  assert.equal(await exists(path.join(f.rootPath, 'PIONEER', '.HuaiDJ-restore-staging', caught.operationId, 'rekordbox', 'export.pdb')), true);
});

test('stale target previews, wrong snapshot identity and different fixture media are rejected', async () => {
  const f = await fixture();
  const snapshot = await f.manager.createExportSnapshot({ rootPath: f.rootPath });
  const args = await restoreArgs(f, snapshot);
  await assert.rejects(f.manager.restoreExportSnapshot({ ...args, expectedSnapshotIdentity: '0'.repeat(64) }), { code: 'RESTORE_PREVIEW_CHANGED' });
  await writeFile(path.join(f.metadata, 'export.pdb'), 'changed-after-preview');
  await assert.rejects(f.manager.restoreExportSnapshot(args), { code: 'RESTORE_TARGET_CHANGED' });
  const other = await fixture();
  await assert.rejects(other.manager.previewRestore({ rootPath: other.rootPath, snapshotId: snapshot.snapshotId }), { code: 'STATE_LINK_FORBIDDEN' });
  await assert.rejects(f.manager.previewRestore({ rootPath: other.rootPath, snapshotId: snapshot.snapshotId }), { code: 'RESTORE_TARGET_MISMATCH' });
});

test('rekordbox starting after preview blocks restore before target mutation', async () => {
  let running = false;
  const f = await fixture({ processProbe: async () => ({ running }) });
  const snapshot = await f.manager.createExportSnapshot({ rootPath: f.rootPath });
  const args = await restoreArgs(f, snapshot);
  running = true;
  await assert.rejects(f.manager.restoreExportSnapshot(args), { code: 'REKORDBOX_RUNNING' });
  assert.equal(await readFile(path.join(f.metadata, 'export.pdb'), 'utf8'), f.input['export.pdb']);
});

test('a home ancestor does not block an ordinary project-owned fixture in an isolated process', async () => {
  const f = await fixture();
  const copiedRoot = path.join(projectRoot, 'work', `export-copy-home-${randomUUID()}`);
  await mkdir(path.join(copiedRoot, 'PIONEER', 'rekordbox'), { recursive: true });
  await writeFile(path.join(copiedRoot, 'PIONEER', 'rekordbox', 'export.pdb'), 'manually-copied-export-fixture');
  const moduleUrl = new URL('../src/export-libraries.mjs', import.meta.url).href;
  const script = `
    import {createExportLibraryManager} from ${JSON.stringify(moduleUrl)};
    const manager=createExportLibraryManager({snapshotRoot:${JSON.stringify(f.snapshotRoot)},processProbe:async()=>({running:false})});
    const preview=await manager.previewExportSnapshot({rootPath:${JSON.stringify(f.rootPath)}});
    const snapshot=await manager.createExportSnapshot({rootPath:${JSON.stringify(f.rootPath)}});
    const inspected=await manager.inspectExportLibrary({rootPath:${JSON.stringify(copiedRoot)}});
    let restoreCode;
    try {await manager.previewRestore({snapshotId:snapshot.snapshotId,rootPath:${JSON.stringify(copiedRoot)}});}catch(e){restoreCode=e.code;}
    console.log(JSON.stringify({files:preview.fileCount,status:snapshot.status,copiedExport:inspected.presenceEvidence.traditionalDeviceLibraryCandidate,restoreCode}));
  `;
  const result = await run(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, HOME: path.dirname(projectRoot), USERPROFILE: path.dirname(projectRoot) },
    windowsHide: true, timeout: 15000, encoding: 'utf8'
  });
  assert.deepEqual(JSON.parse(result.stdout.trim()), { files: 5, status: 'complete', copiedExport: true, restoreCode: 'RESTORE_MEDIA_IDENTITY_REQUIRED' });
});

test('snapshot history reads an absent store without creating state or probing rekordbox', async () => {
  const f = await fixture({ processProbe: async () => { throw new Error('history must not inspect running applications'); } });
  assert.equal(typeof listExportSnapshots, 'function');
  const result = await f.manager.listExportSnapshots();
  assert.equal(result.status, 'ok');
  assert.equal(result.summaryOnly, true);
  assert.deepEqual(result.snapshots, []);
  assert.equal(await exists(f.snapshotRoot), false);
});

test('snapshot history lists tiny private-free version summaries without verifying backup contents', async () => {
  const f = await fixture();
  const snapshot = await f.manager.createExportSnapshot({ rootPath: f.rootPath, exporterVersion: '6.8.7', includeAnalysis: true });
  const directory = path.join(f.snapshotRoot, snapshot.snapshotId);
  const summaryFile = path.join(directory, 'summary.json');
  const summaryBytes = await readFile(summaryFile);
  const summary = JSON.parse(summaryBytes);
  assert.equal(summary.manifestSHA256, sha(await readFile(path.join(directory, 'manifest.json'))));
  assert.equal(summaryBytes.length < 2048, true);
  const reader = createExportLibraryManager({ snapshotRoot: f.snapshotRoot, processProbe: async () => { throw new Error('history process probe forbidden'); } });
  const result = await reader.listExportSnapshots();
  assert.equal(result.snapshots.length, 1);
  assert.deepEqual(result.snapshots[0], { snapshotId: snapshot.snapshotId, createdUTC: summary.createdUTC, completedUTC: summary.completedUTC, exporterVersionDeclared: '6.8.7', includeAnalysis: true, musicIncluded: false, fileCount: 6, bytes: snapshot.bytes, status: 'complete-summary', summaryOnly: true, indexSource: 'summary' });
  const publicText = JSON.stringify(result);
  for (const privateField of [f.rootPath, 'sourceIdentity', 'rootFingerprint', 'serial', 'sourceTreeBefore']) assert.equal(publicText.includes(privateField), false);
  // Only this owned fixture backup is changed, proving quick history is not a content verification or a restore approval.
  await writeFile(path.join(directory, 'data', 'PIONEER', 'rekordbox', 'export.pdb'), 'tampered-owned-fixture');
  assert.equal((await reader.listExportSnapshots()).snapshots[0].status, 'complete-summary');
  await assert.rejects(f.manager.previewRestore({ snapshotId: snapshot.snapshotId, rootPath: f.rootPath }), { code: 'SNAPSHOT_TAMPERED' });
  assert.deepEqual(await readFile(summaryFile), summaryBytes);
});

test('snapshot history bounds legacy manifests and marks incomplete, malformed and linked entries without following them', async () => {
  const f = await fixture();
  const snapshot = await f.manager.createExportSnapshot({ rootPath: f.rootPath, exporterVersion: '7.2.13' });
  const directory = path.join(f.snapshotRoot, snapshot.snapshotId);
  await rename(path.join(directory, 'summary.json'), path.join(directory, 'retained-summary.json'));
  const ids = { large: randomUUID(), incomplete: randomUUID(), malformed: randomUUID(), linked: randomUUID() };
  for (const key of ['large', 'incomplete', 'malformed']) await mkdir(path.join(f.snapshotRoot, ids[key]));
  await writeFile(path.join(f.snapshotRoot, ids.large, 'manifest.json'), ' '.repeat(4 * 1024 * 1024 + 1));
  await writeFile(path.join(f.snapshotRoot, ids.incomplete, 'incomplete.json'), JSON.stringify({ schemaVersion: 1, snapshotId: ids.incomplete, status: 'incomplete', createdUTC: new Date().toISOString(), exporterVersionDeclared: null, includeAnalysis: false, musicIncluded: false }));
  await writeFile(path.join(f.snapshotRoot, ids.malformed, 'summary.json'), JSON.stringify({ sourceUserPaths: f.rootPath, serial: 'must-not-leak' }));
  await symlink(f.base, path.join(f.snapshotRoot, ids.linked), process.platform === 'win32' ? 'junction' : 'dir');
  await mkdir(path.join(f.snapshotRoot, 'non-uuid-ignored'));
  const result = await f.manager.listExportSnapshots();
  const byId = new Map(result.snapshots.map(row => [row.snapshotId, row]));
  assert.equal(byId.size, 5);
  assert.equal(byId.get(snapshot.snapshotId).indexSource, 'manifest-fallback');
  assert.equal(byId.get(snapshot.snapshotId).fileCount, 5);
  assert.equal(byId.get(snapshot.snapshotId).exporterVersionDeclared, '7.2.13');
  assert.equal(byId.get(ids.large).status, 'needs-review');
  assert.equal(byId.get(ids.large).issueCode, 'SNAPSHOT_INDEX_TOO_LARGE');
  assert.equal(byId.get(ids.incomplete).status, 'incomplete');
  assert.equal(byId.get(ids.malformed).status, 'invalid');
  assert.equal(byId.get(ids.linked).status, 'invalid');
  assert.equal(byId.get(ids.linked).issueCode, 'STATE_LINK_FORBIDDEN');
  assert.equal(JSON.stringify(result).includes(f.rootPath), false);
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
  assert.equal(await exists(path.join(directory, 'summary.json')), false);
});
