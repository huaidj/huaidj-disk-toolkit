import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as jsonc from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { previewMcpSetup, applyMcpSetup, skillSetup } from '../src/setup.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(projectRoot, 'state', 'test-fixtures', `setup-${randomUUID()}`);
const serverName = 'huaidj-rufus';
const sha = value => createHash('sha256').update(value).digest('hex');
async function fixture(name, text) {
  const filename = path.join(fixtures, name);
  await mkdir(path.dirname(filename), { recursive: true });
  if (text !== undefined) await writeFile(filename, text);
  return filename;
}

test('MCP setup defaults to preview and rejects unknown clients or secret stores', async () => {
  const filename = path.join(fixtures, 'preview-only', 'settings.json');
  const preview = await applyMcpSetup({ client: 'gemini', configPath: filename });
  assert.equal(preview.applied, false);
  assert.equal(preview.status, 'ready');
  await assert.rejects(stat(path.dirname(filename)), { code: 'ENOENT' });
  assert.equal(preview.entry.command, process.execPath);
  assert.deepEqual(preview.entry.args, [path.join(projectRoot, 'src', 'cli.mjs'), 'mcp']);
  assert.equal(preview.entry.env, undefined);
  assert.equal(preview.entry.autoApprove, undefined);
  await assert.rejects(previewMcpSetup({ client: 'unknown-agent', configPath: filename }), { code: 'UNSUPPORTED_CLIENT' });
  await assert.rejects(previewMcpSetup({ client: 'gemini', configPath: path.join(fixtures, 'auth.json') }), { code: 'INVALID_CONFIG_PATH' });
});

test('Codex preserves original TOML bytes/comments and backs up before appending one section', async () => {
  const original = '# keep this comment\r\nmodel = "fixture-model"\r\n[mcp_servers.other]\r\ncommand = "other-tool"\r\nargs = []\r\n';
  const filename = await fixture('codex/config.toml', original);
  const preview = await previewMcpSetup({ client: 'codex', configPath: filename });
  const result = await applyMcpSetup({ client: 'codex', configPath: filename, apply: true, expectedSha256: preview.sha256Before });
  const actual = await readFile(filename, 'utf8');
  assert.ok(actual.startsWith(original));
  assert.equal(parseToml(actual).mcp_servers[serverName].command, process.execPath);
  assert.equal(await readFile(result.backupPath, 'utf8'), original);
  assert.equal(result.backupSHA256, sha(original));
  assert.equal(result.verifiedSHA256, sha(actual));
  const time = (await stat(filename)).mtimeMs;
  const repeated = await applyMcpSetup({ client: 'codex', configPath: filename, apply: true });
  assert.equal(repeated.status, 'unchanged');
  assert.equal((await stat(filename)).mtimeMs, time);
  assert.equal((await readdir(filename + '.huaidj-backups')).length, 1);
});

test('Codex inline-table shape is refused instead of reformatting an existing document', async () => {
  const original = 'mcp_servers = {}\n';
  const filename = await fixture('codex-inline/config.toml', original);
  await assert.rejects(applyMcpSetup({ client: 'codex', configPath: filename, apply: true }), { code: 'UNSUPPORTED_CONFIG_SHAPE' });
  assert.equal(await readFile(filename, 'utf8'), original);
});

test('VS Code JSONC minimal edits preserve comments, trailing commas, BOM and unrelated values', async () => {
  const original = '\uFEFF{\r\n  // keep this comment and exact value\r\n  "other": { "privateValue": "fixture-secret", },\r\n  "servers": {\r\n    "other": { "command": "existing", "args": [], },\r\n  },\r\n}\r\n';
  const filename = await fixture('vscode/mcp.json', original);
  const preview = await previewMcpSetup({ client: 'vscode', configPath: filename });
  assert.equal(JSON.stringify(preview).includes('fixture-secret'), false);
  const result = await applyMcpSetup({ client: 'vscode', configPath: filename, apply: true });
  const actual = await readFile(filename, 'utf8');
  assert.ok(actual.startsWith('\uFEFF'));
  assert.ok(actual.includes('// keep this comment and exact value\r\n'));
  assert.ok(actual.includes('"other": { "privateValue": "fixture-secret", },'));
  const parsed = jsonc.parse(actual.replace(/^\uFEFF/, ''));
  assert.equal(parsed.servers[serverName].type, 'stdio');
  assert.equal(parsed.servers.other.command, 'existing');
  assert.equal(await readFile(result.backupPath, 'utf8'), original);
});

for (const client of ['claude-code', 'claude-desktop', 'gemini']) {
  test(`${client} adds one stdio entry without changing other JSON fields or approving tools`, async () => {
    const original = '{\n  "privateState": "fixture-secret",\n  "mcpServers": { "other": { "command": "existing" } }\n}\n';
    const filename = await fixture(`${client}/settings.json`, original);
    const result = await applyMcpSetup({ client, configPath: filename, apply: true });
    const parsed = JSON.parse(await readFile(filename, 'utf8'));
    assert.equal(parsed.privateState, 'fixture-secret');
    assert.equal(parsed.mcpServers.other.command, 'existing');
    assert.equal(parsed.mcpServers[serverName].command, process.execPath);
    assert.equal(parsed.mcpServers[serverName].env, undefined);
    assert.equal(parsed.mcpServers[serverName].autoApprove, undefined);
    assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
  });
}

for (const [name, original, expectedPath] of [
  ['old', '{"mcp":{"other":{"type":"local","command":["existing"],"enabled":false}}}', ['mcp', serverName]],
  ['new', '{\n// keep v2 comment\n"mcp":{"servers":{"other":{"type":"local","command":["existing"]}}}}', ['mcp', 'servers', serverName]],
  ['empty-new', '{}', ['mcp', 'servers', serverName]]
]) {
  test(`OpenCode ${name} shape keeps its server location and existing fields`, async () => {
    const filename = await fixture(`opencode-${name}/opencode.jsonc`, original);
    const preview = await previewMcpSetup({ client: 'opencode', configPath: filename });
    assert.deepEqual(preview.entryPath, expectedPath);
    await applyMcpSetup({ client: 'opencode', configPath: filename, apply: true });
    const actual = await readFile(filename, 'utf8');
    const parsed = jsonc.parse(actual);
    const entry = expectedPath.reduce((value, key) => value[key], parsed);
    assert.deepEqual(entry.command, [process.execPath, path.join(projectRoot, 'src', 'cli.mjs'), 'mcp']);
    assert.equal(entry.enabled, undefined);
    assert.equal(entry.disabled, undefined);
    if (name === 'old') assert.equal(parsed.mcp.other.enabled, false);
    if (name === 'new') assert.ok(actual.includes('// keep v2 comment'));
  });
}

test('conflicting server, mixed OpenCode schema and duplicate JSON keys are refused without replacement', async () => {
  const conflict = JSON.stringify({ mcpServers: { [serverName]: { command: 'another-program', args: [] } } });
  const filename = await fixture('conflict/settings.json', conflict);
  await assert.rejects(applyMcpSetup({ client: 'gemini', configPath: filename, apply: true }), { code: 'MCP_SERVER_CONFLICT' });
  assert.equal(await readFile(filename, 'utf8'), conflict);
  const mixed = await fixture('mixed/opencode.json', '{"mcp":{"servers":{},"old":{"type":"local","command":["x"]}}}');
  await assert.rejects(previewMcpSetup({ client: 'opencode', configPath: mixed }), { code: 'UNSUPPORTED_CONFIG_SHAPE' });
  const duplicate = await fixture('duplicate/settings.json', '{"mcpServers":{},"mcpServers":{}}');
  await assert.rejects(previewMcpSetup({ client: 'gemini', configPath: duplicate }), { code: 'CONFIG_PARSE_FAILED' });
});

test('preview hash CAS preserves an intervening user edit', async () => {
  const filename = await fixture('cas/settings.json', '{"other":1}');
  const preview = await previewMcpSetup({ client: 'gemini', configPath: filename });
  const changed = '{"other":2,"userAdded":true}';
  await writeFile(filename, changed);
  await assert.rejects(applyMcpSetup({ client: 'gemini', configPath: filename, apply: true, expectedSha256: preview.sha256Before }), { code: 'CONFIG_CHANGED' });
  assert.equal(await readFile(filename, 'utf8'), changed);
  await assert.rejects(stat(filename + '.huaidj-backups'), { code: 'ENOENT' });
});

test('same entry point is idempotent and retains the user existing extra settings', async () => {
  const entry = { command: process.execPath, args: [path.join(projectRoot, 'src', 'cli.mjs'), 'mcp'], timeout: 90000, disabled: true, env: { PRIVATE_FIXTURE: 'do-not-return' } };
  const original = JSON.stringify({ mcpServers: { [serverName]: entry } }, null, 4);
  const filename = await fixture('idempotent/settings.json', original);
  const result = await applyMcpSetup({ client: 'gemini', configPath: filename, apply: true });
  assert.equal(result.status, 'unchanged');
  assert.equal(await readFile(filename, 'utf8'), original);
  assert.equal(JSON.stringify(result).includes('do-not-return'), false);
  await assert.rejects(stat(filename + '.huaidj-backups'), { code: 'ENOENT' });
});

test('skill preview creates nothing; explicit apply copies one packaged folder and is idempotent', async () => {
  const target = path.join(fixtures, 'skills', 'huaidj-disk-toolkit');
  const preview = await skillSetup({ target });
  assert.equal(preview.applied, false);
  await assert.rejects(stat(target), { code: 'ENOENT' });
  const result = await skillSetup({ target, apply: true });
  assert.equal(result.applied, true);
  assert.equal(result.treeSHA256, result.verifiedTreeSHA256);
  assert.ok((await readFile(path.join(target, 'SKILL.md'), 'utf8')).includes('name: huaidj-disk-toolkit'));
  const repeated = await skillSetup({ target, apply: true });
  assert.equal(repeated.status, 'unchanged');
  assert.equal(repeated.treeSHA256, result.treeSHA256);
});

test('different existing skill is never overwritten and dry-run never creates a target', async () => {
  const target = await fixture('conflicting-skill/huaidj-disk-toolkit/SKILL.md', 'user-owned skill');
  await assert.rejects(skillSetup({ target: path.dirname(target), apply: true }), { code: 'SKILL_CONFLICT' });
  assert.equal(await readFile(target, 'utf8'), 'user-owned skill');
  const dry = path.join(fixtures, 'dry-skill', 'huaidj-disk-toolkit');
  const result = await skillSetup({ target: dry, apply: true, dryRun: true });
  assert.equal(result.applied, false);
  await assert.rejects(stat(dry), { code: 'ENOENT' });
});
