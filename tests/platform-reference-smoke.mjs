// GPL-3.0-or-later. Reference/stdio smoke only: no disk, GUI or setup calls.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);
const { values } = parseArgs({ options: {
  ready: { type: 'string' }, manifest: { type: 'string' }, 'install-root': { type: 'string' },
  output: { type: 'string' }, node: { type: 'string' }, cli: { type: 'string' }
}, strict: true, allowPositionals: false });
const jsonFile = async filename => JSON.parse((await readFile(filename, 'utf8')).replace(/^\uFEFF/, ''));
let node = values.node ?? process.execPath;
let cli = values.cli ?? path.join(root, 'src', 'cli.mjs');
let release = null;
if (values.ready) {
  assert.ok(values.manifest && values['install-root'], 'Installed-runtime validation requires its manifest and owned install root');
  const ready = await jsonFile(values.ready);
  const manifest = await jsonFile(values.manifest);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.version, '0.1.0');
  assert.equal(ready.configurationApplied, false);
  assert.equal(ready.systemPATHModified, false);
  assert.equal(ready.elevationRequested, false);
  assert.equal(ready.physicalDiskAdapter, 'Windows-only');
  assert.equal(manifest.repository, 'yutianyu111602-glitch/huaidj-disk-toolkit');
  assert.equal(manifest.tag, 'v0.1.0');
  assert.equal(manifest.version, '0.1.0');
  node = ready.nodePath;
  cli = ready.cliPath;
  assert.ok(path.isAbsolute(node) && path.isAbsolute(cli) && path.isAbsolute(ready.toolkitRoot));
  assert.ok((await stat(node)).isFile());
  assert.ok((await stat(cli)).isFile());
  const ownedRoot = await realpath(values['install-root']);
  const toolkitRoot = await realpath(ready.toolkitRoot);
  const relative = path.relative(ownedRoot, toolkitRoot);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Installed core must stay in its owned runtime root');
  assert.equal(await realpath(cli), await realpath(path.join(toolkitRoot, 'src', 'cli.mjs')));
  const receipt = await jsonFile(path.join(toolkitRoot, '..', 'install-receipt.json'));
  const source = manifest.assets.find(asset => asset.name === 'source');
  assert.ok(source && /^[a-f0-9]{64}$/i.test(source.sha256));
  assert.equal(receipt.status, 'complete');
  assert.equal(receipt.packageSHA256.toLowerCase(), source.sha256.toLowerCase());
  release = { repository: manifest.repository, tag: manifest.tag, version: manifest.version, sourceAsset: source.file, sourceSha256: source.sha256, configurationApplied: false };
}
const cwd = path.resolve(path.dirname(cli), '..');
const run = async args => (await execute(node, [cli, ...args], { cwd, timeout: 30000, maxBuffer: 1024 * 1024 })).stdout;
const version = (await execute(node, ['--version'], { timeout: 10000 })).stdout.trim();
assert.ok(Number(version.replace(/^v/, '').split('.')[0]) >= 22);
assert.match(await run(['--help']), /HuaiDJ Disk Toolkit/);
const formats = JSON.parse(await run(['formats', '--platform', 'macos']));
assert.equal(formats.queriedPlatform, 'macos');
assert.ok(formats.filesystems.some(row => row.id === 'fat32'));
const models = JSON.parse(await run(['dj-models', '--query', 'CDJ']));
assert.ok(models.models.some(model => model.id === 'cdj-3000'));
const recommendation = JSON.parse(await run(['dj-recommend', '--models', 'cdj-3000,cdj-3000x', '--platforms', 'windows,macos']));
assert.equal(typeof recommendation, 'object');

const client = new Client({ name: 'huaidj-reference-platform-validation', version: '0.1.0' }, { capabilities: {} });
const transport = new StdioClientTransport({ command: node, args: [cli, 'mcp'], cwd, stderr: 'pipe' });
let stderrBytes = 0;
transport.stderr?.on('data', data => { stderrBytes += Buffer.byteLength(data); });
let server, toolCount;
try {
  await client.connect(transport);
  server = client.getServerVersion();
  const discovered = await client.listTools();
  toolCount = discovered.tools.length;
  assert.equal(toolCount, 28);
  assert.equal(discovered.tools.find(tool => tool.name === 'dj_model_compatibility')?.annotations?.readOnlyHint, true);
  const response = await client.callTool({ name: 'dj_model_compatibility', arguments: { model: 'cdj-3000' } });
  assert.notEqual(response.isError, true);
  const text = response.content.find(item => item.type === 'text')?.text;
  assert.equal(JSON.parse(text).id, 'cdj-3000');
} finally {
  await client.close();
}
const result = {
  timestampUTC: new Date().toISOString(), platform: process.platform, nodeVersion: version,
  runtime: release ? 'installed-fixed-release' : 'working-tree-reference-smoke', release,
  cliHelp: 'PASS', cliMacosFormats: 'PASS', cliDjModels: 'PASS', cliDjRecommendation: 'PASS',
  mcpInitialize: 'PASS', mcpDiscovery: 'PASS', toolCount, mcpReadOnlyModelCall: 'PASS', server,
  nativeEngineExecuted: false, physicalDiskCalls: false, guiCalls: false, clientOrSkillRegistration: false,
  scope: 'Reference/query/stdio only; no native macOS/Linux writer claim.', stderrBytes
};
if (values.output) await writeFile(values.output, JSON.stringify(result, null, 2) + '\n');
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
