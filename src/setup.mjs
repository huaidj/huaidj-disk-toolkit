import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { open, readFile, writeFile, mkdir, lstat, realpath, readdir, rename, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as jsonc from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { BridgeError } from './images.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverName = 'huaidj-rufus';
const skillName = 'huaidj-disk-toolkit';
const maxConfigBytes = 16 * 1024 * 1024;
export const SUPPORTED_MCP_CLIENTS = Object.freeze(['codex', 'claude-code', 'claude-desktop', 'gemini', 'opencode', 'vscode']);
const hash = value => createHash('sha256').update(value).digest('hex');
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const samePath = (a, b) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const exists = async filename => { try { return await lstat(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const fail = (code, message, details) => { const error = new BridgeError(code, message); if (details) error.details = details; throw error; };

function normalizedClient(client) {
  if (typeof client !== 'string' || !SUPPORTED_MCP_CLIENTS.includes(client))
    fail('UNSUPPORTED_CLIENT', `Select one supported client: ${SUPPORTED_MCP_CLIENTS.join(', ')}.`);
  return client;
}

async function desktopCandidates(home, appData, localData, xdg) {
  if (process.platform === 'darwin') return [path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')];
  if (process.platform !== 'win32') return [path.join(xdg, 'Claude', 'claude_desktop_config.json')];
  const candidates = [path.join(appData, 'Claude', 'claude_desktop_config.json')];
  for (const [base, expression, suffix] of [
    [path.join(localData, 'Claude-Data'), /^claude[_-]/i, ['claude_desktop_config.json']],
    [path.join(localData, 'Packages'), /claude/i, ['LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json']]
  ]) {
    const directory = await exists(base);
    if (!directory?.isDirectory()) continue;
    for (const child of await readdir(base, { withFileTypes: true })) {
      if (child.isDirectory() && expression.test(child.name)) candidates.push(path.join(base, child.name, ...suffix));
    }
  }
  return candidates;
}

async function chooseConfigPath(client, explicit) {
  if (explicit !== undefined) {
    if (typeof explicit !== 'string' || !explicit.trim() || explicit.includes('\0') || /^[a-z]+:\/\//i.test(explicit))
      fail('INVALID_CONFIG_PATH', 'Use one explicit local configuration file path.');
    const selected = path.resolve(explicit);
    const extension = path.extname(selected).toLowerCase();
    if ((client === 'codex' && extension !== '.toml') || (client !== 'codex' && !['.json', '.jsonc'].includes(extension)))
      fail('INVALID_CONFIG_PATH', 'Codex uses a TOML configuration; the other supported clients use JSON or JSONC.');
    if (/^(?:auth|tokens?|credentials?|secrets?|client_secret)\.(?:jsonc?|toml)$/i.test(path.basename(selected)))
      fail('INVALID_CONFIG_PATH', 'Authentication, token, credential and secret stores are not setup targets.');
    return selected;
  }
  const home = homedir();
  const xdg = process.env.XDG_CONFIG_HOME ? path.resolve(process.env.XDG_CONFIG_HOME) : path.join(home, '.config');
  const appData = process.env.APPDATA ? path.resolve(process.env.APPDATA) : path.join(home, 'AppData', 'Roaming');
  const localData = process.env.LOCALAPPDATA ? path.resolve(process.env.LOCALAPPDATA) : path.join(home, 'AppData', 'Local');
  let candidates;
  if (client === 'codex') candidates = [path.join(process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(home, '.codex'), 'config.toml')];
  else if (client === 'claude-code') candidates = [path.join(home, '.claude.json')];
  else if (client === 'claude-desktop') candidates = await desktopCandidates(home, appData, localData, xdg);
  else if (client === 'gemini') candidates = [path.join(home, '.gemini', 'settings.json')];
  else if (client === 'opencode') candidates = [path.join(xdg, 'opencode', 'opencode.json'), path.join(xdg, 'opencode', 'opencode.jsonc')];
  else {
    const base = process.platform === 'win32' ? appData : process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : xdg;
    candidates = [path.join(base, 'Code', 'User', 'mcp.json')];
  }
  const present = [];
  for (const candidate of candidates) if (await exists(candidate)) present.push(candidate);
  if (present.length === 1) return present[0];
  if (present.length > 1) fail('AMBIGUOUS_CLIENT_CONFIG', 'Several existing configurations were found. Select one with an explicit config path.', { candidates: present });
  const recognized = [];
  for (const candidate of candidates) {
    const marker = client === 'claude-code' ? path.join(home, '.claude') : path.dirname(candidate);
    if ((await exists(marker))?.isDirectory()) recognized.push(candidate);
  }
  // OpenCode's two file extensions describe one application directory.
  if (client === 'opencode' && recognized.length) return recognized.find(item => item.endsWith('.jsonc')) ?? recognized[0];
  if (recognized.length === 1) return recognized[0];
  if (recognized.length > 1) fail('AMBIGUOUS_CLIENT_CONFIG', 'Several client locations were found. Select one configuration path.', { candidates: recognized });
  fail('CLIENT_NOT_DETECTED', 'No existing configuration or application settings directory was found. Use an explicit config path for an intentional new setup.');
}

async function effectivePath(requested) {
  if (await exists(requested)) return realpath(requested);
  let parent = path.dirname(requested);
  while (!(await exists(parent))) {
    const next = path.dirname(parent);
    if (next === parent) fail('INVALID_CONFIG_PATH', 'A parent of the configuration path could not be resolved.');
    parent = next;
  }
  return path.join(await realpath(parent), path.relative(parent, requested));
}

async function snapshot(filename) {
  let handle;
  try { handle = await open(filename, 'r'); }
  catch (error) {
    if (error.code === 'ENOENT') return { exists: false, bytes: Buffer.alloc(0), sha256: null, mode: 0o600, identity: null };
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maxConfigBytes)) fail('INVALID_CONFIG_FILE', 'The selected configuration must be a regular file of at most 16 MiB.');
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs) fail('CONFIG_CHANGED', 'The configuration changed while it was being read. Retry preview.');
    return { exists: true, bytes, sha256: hash(bytes), mode: Number(after.mode & 0o777n), identity: `${after.dev}:${after.ino}:${after.mtimeNs}:${after.size}:${after.mode}` };
  } finally { await handle.close(); }
}

function rejectDuplicateProperties(node) {
  if (!node) return;
  if (node.type === 'object') {
    const names = new Set();
    for (const property of node.children ?? []) {
      const name = property.children?.[0]?.value;
      if (names.has(name)) fail('CONFIG_PARSE_FAILED', 'The JSON configuration has duplicate object properties. Resolve them before setup.');
      names.add(name);
    }
  }
  for (const child of node.children ?? []) rejectDuplicateProperties(child);
}

function parseJson(text, client) {
  const errors = [];
  const options = { allowTrailingComma: ['vscode', 'opencode'].includes(client), disallowComments: !['vscode', 'opencode'].includes(client) };
  const tree = jsonc.parseTree(text, errors, options);
  if (errors.length || !tree || tree.type !== 'object') fail('CONFIG_PARSE_FAILED', 'The selected JSON/JSONC configuration is invalid. No file was changed.');
  rejectDuplicateProperties(tree);
  return jsonc.getNodeValue(tree);
}

function parseConfig(text, client) {
  if (client !== 'codex') return parseJson(text.replace(/^\uFEFF/, ''), client);
  try { return parseToml(text.replace(/^\uFEFF/, '')); }
  catch { fail('CONFIG_PARSE_FAILED', 'The selected TOML configuration is invalid. No file was changed.'); }
}

function mapAndEntry(client, config) {
  const launcher = { command: process.execPath, args: [path.join(projectRoot, 'src', 'cli.mjs'), 'mcp'] };
  if (client === 'codex') return { entryPath: ['mcp_servers', serverName], entry: launcher, map: config.mcp_servers, style: 'stdio' };
  if (client === 'vscode') return { entryPath: ['servers', serverName], entry: { type: 'stdio', ...launcher }, map: config.servers, style: 'stdio' };
  if (client === 'opencode') {
    if (config.mcp !== undefined && !plainObject(config.mcp)) fail('UNSUPPORTED_CONFIG_SHAPE', 'OpenCode mcp must be an object.');
    const mcp = config.mcp ?? {};
    const hasNested = Object.hasOwn(mcp, 'servers');
    const legacyEntries = Object.entries(mcp).filter(([key, value]) => key !== 'servers' && plainObject(value) && (['local', 'remote'].includes(value.type) || Object.hasOwn(value, 'command') || Object.hasOwn(value, 'url')));
    if (hasNested && legacyEntries.length) fail('UNSUPPORTED_CONFIG_SHAPE', 'OpenCode mixes old and new server locations. Choose one schema before setup.');
    const legacy = !hasNested && legacyEntries.length > 0;
    return { entryPath: legacy ? ['mcp', serverName] : ['mcp', 'servers', serverName], entry: { type: 'local', command: [launcher.command, ...launcher.args] }, map: legacy ? mcp : mcp.servers, style: legacy ? 'opencode-v1' : 'opencode-v2' };
  }
  return { entryPath: ['mcpServers', serverName], entry: { ...(client === 'claude-code' ? { type: 'stdio' } : {}), ...launcher }, map: config.mcpServers, style: 'stdio' };
}

function sameEntrypoint(current, expected) {
  if (!plainObject(current) || current.url || current.httpUrl || ['http', 'sse', 'remote'].includes(current.type)) return false;
  if (Array.isArray(expected.command)) {
    return current.type === 'local' && Array.isArray(current.command) && current.command.length === expected.command.length &&
      current.command.every(value => typeof value === 'string') &&
      samePath(current.command[0], expected.command[0]) && samePath(current.command[1], expected.command[1]) && current.command[2] === 'mcp';
  }
  return typeof current.command === 'string' && samePath(current.command, expected.command) && Array.isArray(current.args) && current.args.length === 2 &&
    current.args.every(value => typeof value === 'string') &&
    samePath(current.args[0], expected.args[0]) && current.args[1] === 'mcp';
}

async function mcpPlan({ client, configPath } = {}) {
  client = normalizedClient(client);
  const requested = await chooseConfigPath(client, configPath);
  const target = await effectivePath(requested);
  const original = await snapshot(target);
  let decoded;
  try { decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(original.bytes); }
  catch { fail('UNSUPPORTED_CONFIG_ENCODING', 'The configuration must be valid UTF-8. Convert it explicitly before setup.'); }
  const bom = decoded.startsWith('\uFEFF') ? '\uFEFF' : '';
  let text = decoded.replace(/^\uFEFF/, '');
  if (!text.trim()) text += client === 'codex' ? '' : '{}';
  const parsed = parseConfig(text, client);
  const spec = mapAndEntry(client, parsed);
  if (spec.map !== undefined && !plainObject(spec.map)) fail('UNSUPPORTED_CONFIG_SHAPE', 'The MCP server container must be an object/table.');
  if (Object.keys(spec.map ?? {}).some(name => name.toLowerCase() === serverName && name !== serverName))
    fail('MCP_SERVER_CONFLICT', 'A differently cased registration already uses this server name. Resolve it explicitly before setup.');
  const current = spec.map?.[serverName];
  const present = spec.map !== undefined && Object.hasOwn(spec.map, serverName);
  if (present && !sameEntrypoint(current, spec.entry)) fail('MCP_SERVER_CONFLICT', 'The server name already points to another entry point. Existing registration was preserved.');
  let proposed = text;
  if (!present) {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    if (client === 'codex') {
      const separator = text.length ? (text.endsWith('\n') ? eol : eol + eol) : '';
      proposed = `${text}${separator}[mcp_servers.${serverName}]${eol}command = ${JSON.stringify(spec.entry.command)}${eol}args = ${JSON.stringify(spec.entry.args)}${eol}`;
      try { parseToml(proposed.replace(/^\uFEFF/, '')); }
      catch { fail('UNSUPPORTED_CONFIG_SHAPE', 'A separate Codex MCP section cannot be appended safely to this TOML shape. Existing configuration was preserved.'); }
    } else {
      const indentation = text.match(/^([ \t]+)"/m)?.[1];
      const formattingOptions = { insertSpaces: !indentation?.includes('\t'), tabSize: indentation && !indentation.includes('\t') ? indentation.length : 2, eol };
      proposed = jsonc.applyEdits(text, jsonc.modify(text, spec.entryPath, spec.entry, { formattingOptions }));
    }
  }
  const validated = parseConfig(proposed, client);
  const finalSpec = mapAndEntry(client, validated);
  if (!sameEntrypoint(finalSpec.map?.[serverName], spec.entry)) fail('SETUP_VERIFY_FAILED', 'The proposed configuration does not resolve to the intended entry point.');
  const bytes = present ? original.bytes : Buffer.from(bom + proposed, 'utf8');
  return { client, requested, target, original, bytes, spec, unchanged: present, sha256After: present ? original.sha256 : hash(bytes) };
}

function publicPlan(plan) {
  return {
    client: plan.client, serverName, configPath: plan.requested, writePath: plan.target,
    status: plan.unchanged ? 'unchanged' : 'ready', applied: false, changesNeeded: !plan.unchanged,
    entryPath: plan.spec.entryPath, entry: plan.spec.entry, schema: plan.spec.style,
    sha256Before: plan.original.sha256, sha256After: plan.sha256After,
    hostValidation: 'not-run',
    note: 'Only this named server entry is added. Existing client settings and approval policy are retained. Reload the client and verify its MCP handshake separately.'
  };
}

export async function previewMcpSetup(options = {}) { return publicPlan(await mcpPlan(options)); }

async function withTargetLock(filename, callback) {
  await mkdir(path.dirname(filename), { recursive: true });
  const lockPath = filename + '.huaidj-setup.lock';
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') fail('SETUP_BUSY', 'Another setup operation owns this configuration. Existing locks are never removed automatically.'); throw error; }
  const owned = await lock.stat({ bigint: true });
  try { return await callback(); }
  finally {
    await lock.close();
    let current;
    try { current = await lstat(lockPath, { bigint: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current && current.isFile() && current.dev === owned.dev && current.ino === owned.ino) await unlink(lockPath);
  }
}

function unchangedSnapshot(a, b) { return a.exists === b.exists && a.sha256 === b.sha256 && a.identity === b.identity; }

export async function applyMcpSetup(options = {}) {
  if (options.apply !== true || options.dryRun === true) return previewMcpSetup(options);
  const initial = await mcpPlan(options);
  if (initial.unchanged) return publicPlan(initial);
  if (Object.hasOwn(options, 'expectedSha256') && options.expectedSha256 !== initial.original.sha256)
    fail('CONFIG_CHANGED', 'The configuration no longer matches the supplied preview hash. Preview again.');
  return withTargetLock(initial.target, async () => {
    if (!samePath(await effectivePath(initial.requested), initial.target) || !unchangedSnapshot(await snapshot(initial.target), initial.original))
      fail('CONFIG_CHANGED', 'The configuration changed after preview. No replacement was made.');
    let backupPath = null;
    if (initial.original.exists) {
      const backupRoot = initial.target + '.huaidj-backups';
      await mkdir(backupRoot, { recursive: true });
      backupPath = path.join(backupRoot, `${new Date().toISOString().replace(/[:.]/g, '-')}.${randomUUID()}.bak`);
      const backup = await open(backupPath, 'wx', initial.original.mode);
      try { await backup.writeFile(initial.original.bytes); await backup.sync(); } finally { await backup.close(); }
      if (hash(await readFile(backupPath)) !== initial.original.sha256) fail('BACKUP_VERIFY_FAILED', 'The original-byte configuration backup did not verify. No replacement was made.');
    }
    const temporary = initial.target + `.${randomUUID()}.tmp`;
    const staged = await open(temporary, 'wx', initial.original.mode);
    try { await staged.writeFile(initial.bytes); await staged.sync(); } finally { await staged.close(); }
    if (!samePath(await effectivePath(initial.requested), initial.target) || !unchangedSnapshot(await snapshot(initial.target), initial.original))
      fail('CONFIG_CHANGED', 'The configuration changed before atomic replacement. The original file was preserved.', { backupPath });
    if (initial.original.exists) await rename(temporary, initial.target);
    else { await link(temporary, initial.target); await unlink(temporary); }
    const verified = await snapshot(initial.target);
    if (verified.sha256 !== initial.sha256After) fail('SETUP_VERIFY_FAILED', 'The configuration changed during independent readback. Preserve the backup and inspect the client before retrying.', { backupPath });
    const parsed = parseConfig(verified.bytes.toString('utf8'), initial.client);
    const finalSpec = mapAndEntry(initial.client, parsed);
    if (!sameEntrypoint(finalSpec.map?.[serverName], initial.spec.entry)) fail('SETUP_VERIFY_FAILED', 'The installed entry did not verify. Preserve the original-byte backup.', { backupPath });
    return { ...publicPlan(initial), status: 'applied', applied: true, backupPath, backupSHA256: initial.original.sha256, verifiedSHA256: verified.sha256 };
  });
}

async function skillSnapshot(root) {
  const rootInfo = await exists(root);
  if (!rootInfo) return null;
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail('UNSUPPORTED_SKILL_PATH', 'The skill folder must be an ordinary directory, not a link.');
  const entries = [];
  let total = 0;
  async function visit(directory, relative = '') {
    for (const child of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const name = relative ? `${relative}/${child.name}` : child.name;
      const filename = path.join(directory, child.name);
      const info = await lstat(filename);
      if (info.isSymbolicLink()) fail('UNSUPPORTED_SKILL_PATH', 'Skill folders containing links are not copied.');
      if (info.isDirectory()) { entries.push({ name, type: 'directory' }); await visit(filename, name); }
      else if (info.isFile()) {
        const bytes = await readFile(filename); total += bytes.length;
        if (total > 16 * 1024 * 1024 || entries.length >= 1000) fail('SKILL_TOO_LARGE', 'The packaged skill exceeds the bounded installer size.');
        entries.push({ name, type: 'file', bytes, sha256: hash(bytes), size: bytes.length, mode: info.mode & 0o777 });
      } else fail('UNSUPPORTED_SKILL_PATH', 'Only regular skill files and directories can be installed.');
    }
  }
  await visit(root);
  const metadata = entries.map(({ name, type, sha256, size }) => ({ name, type, ...(type === 'file' ? { sha256, size } : {}) }));
  return { entries, metadata, totalBytes: total, treeSHA256: hash(JSON.stringify(metadata)) };
}

export async function skillSetup({ target, apply = false, dryRun = false } = {}) {
  const source = path.join(projectRoot, 'skills', skillName);
  if (typeof target !== 'undefined' && (typeof target !== 'string' || !target.trim() || target.includes('\0') || /^[a-z]+:\/\//i.test(target)))
    fail('INVALID_SKILL_TARGET', 'Supply the final destination skill folder.');
  const destination = target === undefined ? path.join(homedir(), '.agents', 'skills', skillName) : path.resolve(target);
  if (path.basename(destination) !== skillName) fail('INVALID_SKILL_TARGET', `Use a final folder named ${skillName}, not its parent directory.`);
  const packaged = await skillSnapshot(source);
  if (!packaged?.entries.some(entry => entry.name === 'SKILL.md' && entry.type === 'file')) fail('PACKAGED_SKILL_MISSING', 'The project packaged skill is incomplete.');
  const existing = await skillSnapshot(destination);
  if (existing && existing.treeSHA256 !== packaged.treeSHA256) fail('SKILL_CONFLICT', 'The destination skill differs from this package. Existing files were preserved; choose a new location or use your skill management system.');
  const result = { source, target: destination, status: existing ? 'unchanged' : 'ready', applied: false, changesNeeded: !existing, treeSHA256: packaged.treeSHA256, totalBytes: packaged.totalBytes, files: packaged.metadata, note: 'This copies one packaged skill only. It does not edit any separate skill registry, routing index, SSOT or official cache.' };
  if (existing || apply !== true || dryRun === true) return result;
  await mkdir(path.dirname(destination), { recursive: true });
  try { await mkdir(destination); } catch (error) { if (error.code === 'EEXIST') fail('SKILL_CONFLICT', 'The target appeared during setup. No existing skill files were overwritten.'); throw error; }
  for (const entry of packaged.entries.filter(entry => entry.type === 'directory')) await mkdir(path.join(destination, entry.name), { recursive: true });
  for (const entry of packaged.entries.filter(entry => entry.type === 'file' && entry.name !== 'SKILL.md'))
    await writeFile(path.join(destination, entry.name), entry.bytes, { flag: 'wx', mode: entry.mode });
  const main = packaged.entries.find(entry => entry.name === 'SKILL.md');
  const temporary = path.join(destination, `.SKILL.md.${randomUUID()}.tmp`);
  await writeFile(temporary, main.bytes, { flag: 'wx', mode: main.mode });
  await link(temporary, path.join(destination, 'SKILL.md'));
  await unlink(temporary);
  const verified = await skillSnapshot(destination);
  if (verified.treeSHA256 !== packaged.treeSHA256) fail('SKILL_VERIFY_FAILED', 'The copied skill differs from its packaged snapshot. Existing external skill files were not changed.');
  return { ...result, status: 'applied', applied: true, verifiedTreeSHA256: verified.treeSHA256 };
}
