import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { djCompatibility, recommendDjMedia, checkDjAudio, rekordboxVersionAdvice } from '../src/compatibility.mjs';

test('manufacturer reference rows retain provenance and explicit unknowns', async () => {
  const data = JSON.parse(await readFile(new URL('../src/data/dj-compatibility.json', import.meta.url), 'utf8'));
  const sourceIds = new Set(Array.isArray(data.sources) ? data.sources.map(source => source.id) : Object.keys(data.sources));
  const ids = new Set();
  const domains = ['alphatheta.com', 'rekordbox.com', 'pioneerdj.com', 'pioneer-support.zendesk.com', 'denondj.com', 'support.denondj.com', 'enginedj.com', 'cdn.inmusicbrands.com', 'inmusicbrands.com'];
  const checkSourceIds = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'sourceIds') for (const id of entry) assert.ok(sourceIds.has(id), `Missing source ${id}`);
      else checkSourceIds(entry);
    }
  };
  for (const model of data.models) {
    assert.ok(!ids.has(model.id)); ids.add(model.id);
    for (const status of Object.values(model.filesystemSupport)) assert.ok(status === true || status === false || status === 'unknown');
    for (const source of model.sourceURLs) {
      const hostname = new URL(source).hostname;
      assert.ok(domains.some(domain => hostname === domain || hostname.endsWith(`.${domain}`)), `Unexpected source domain ${hostname}`);
    }
    checkSourceIds(model);
  }
});

test('real mixed-generation player reference preserves library and firmware differences', async () => {
  const oldPlayer = await djCompatibility('cdj-3000');
  const newPlayer = await djCompatibility('cdj-3000x');
  assert.equal(oldPlayer.libraryTypes.deviceLibrary, true);
  assert.equal(oldPlayer.libraryTypes.oneLibrary, false);
  assert.equal(newPlayer.libraryTypes.oneLibrary, true);
  const options = { models: ['cdj-3000', 'cdj-3000x'], largestFileBytes: 5_000_000_000 };
  assert.equal((await recommendDjMedia(options)).recommendedFilesystem, null);
  assert.equal((await recommendDjMedia({ ...options, firmwareVersions: { 'cdj-3000': '1.20' }, rekordboxVersion: '6.6.2' })).recommendedFilesystem, 'exfat');
  assert.equal((await checkDjAudio({ model: 'cdj-3000', format: 'wav', sampleRateHz: 96000, bitDepth: 24 })).status, 'documented-support');
});

test('unknown actual rekordbox release remains unknown with visible potentially relevant defects', async () => {
  const result = await rekordboxVersionAdvice('7');
  assert.equal(result.versionStatus, 'incomplete-version');
  assert.equal(result.knownDefects.length, 0);
  assert.ok(result.potentiallyRelevantDefects.some(notice => notice.affectedVersion === '7.2.12'));
});
