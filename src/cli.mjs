#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import * as core from './core.mjs';

const help = `HuaiDJ Disk Toolkit 0.1.0 — CLI + MCP + skill

huaidj-rufus status
huaidj-rufus devices
huaidj-rufus inspect --image <alias|ISO|IMG> [--sha256 <hash>]
huaidj-rufus prepare --device <physical-number> --image <alias|path> --sha256 <hash> [--mode dd|iso]
huaidj-disk prepare-native-format --device <number> --filesystem fat32|ntfs|exfat [--scheme auto|mbr|gpt] [--cluster-size auto|bytes] [--label <label>] [--full]
huaidj-rufus dry-run --plan <id> --confirm <exact-confirmation>
huaidj-rufus write --plan <id> --confirm <exact-confirmation> --erase
huaidj-rufus job --id <id> [--wait] [--timeout <seconds>]
huaidj-disk capabilities
huaidj-disk details --device <physical-number>
huaidj-disk verify --device <number> --image <alias|path> --sha256 <hash>
huaidj-disk prepare-verify --device <number> --image <alias|path> --sha256 <hash>
huaidj-disk prepare-disk --operation format-volume|initialize-usb --device <number> --filesystem FAT|FAT32|exFAT|NTFS|UDF [--partition <number>] [--partition-style GPT|MBR] [--label <name>] [--full]
huaidj-disk execute-disk --plan <id> --confirm <exact-confirmation> --erase
huaidj-disk formats [--platform windows|macos] [--filesystem <name>]
huaidj-disk dj-models [--query <text>]
huaidj-disk dj-model --model <exact-model-id>
huaidj-disk dj-recommend --models <id,id> [--platforms windows,macos] [--largest-file-bytes <number>] [--firmware model=version,model=version] [--version <rekordbox-version>]
huaidj-disk dj-audio --model <id> --format <actual-codec> [--sample-rate <Hz>] [--bit-depth <bits>]
huaidj-disk rekordbox-advice [--version <6.8.7|7.2.13>] [--scope usb-export|desktop-main-library|all]
huaidj-disk export-inspect --root <USB-root|export-copy> [--hash]
huaidj-disk snapshot-preview --root <media-root> [--analysis]
huaidj-disk snapshot-list
huaidj-disk snapshot-create --root <media-root> [--exporter-version <version>] [--analysis]
huaidj-disk restore-preview --snapshot <id> --root <same-media-root>
huaidj-disk snapshot-restore --snapshot <id> --root <same-media-root> --preview <id> --snapshot-identity <hash> --confirm <exact-confirmation> --restore
huaidj-disk setup-mcp --client codex|claude-code|claude-desktop|gemini|opencode|vscode [--config <path>] [--apply] [--dry-run]
huaidj-disk setup-skill [--target <final-skill-folder>] [--apply] [--dry-run]
huaidj-disk smart-plan [--device <number>] [--purpose dj|shared-data|windows-data|mac-data] [--models 'id,id'] [--platforms 'windows,macos'] [--firmware 'id=version'] [--version <rekordbox-release>] [--file-size-class unknown|within-fat32|over-fat32] [--scheme auto|mbr|gpt]
huaidj-disk detect-dj
huaidj-rufus mcp

Write erases the entire selected USB. Internal/system disks are refused.
Native Rufus may require Windows UAC. Unexpected warnings stop automation.
USB preparation does not install Linux on an internal disk or reboot Windows.
`;
const output = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
function firmwareMap(value) {
  return Object.fromEntries((value ?? '').split(/[,\s]+/).filter(Boolean).map(pair => {
    const [model, version, extra] = pair.split('=');
    if (!model || !version || extra) throw new Error('Firmware entries must use model=version.');
    return [model, version];
  }));
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (!command || ['--help', '-h', 'help'].includes(command)) { process.stdout.write(help); return; }
  if (['--version', '-v'].includes(command)) { process.stdout.write('0.1.0\n'); return; }
  if (command === 'mcp') {
    if (rest.length) throw new Error('The mcp command accepts no arguments.');
    const { runServer } = await import('./server.mjs');
    await runServer(); return;
  }
  const { values } = parseArgs({ args: rest, options: {
    image: { type: 'string' }, sha256: { type: 'string' }, device: { type: 'string' },
    mode: { type: 'string' }, plan: { type: 'string' }, confirm: { type: 'string' },
    erase: { type: 'boolean', default: false }, id: { type: 'string' },
    wait: { type: 'boolean', default: false }, timeout: { type: 'string', default: '3600' }
    ,platform: { type: 'string' }, filesystem: { type: 'string' }, query: { type: 'string' },
    model: { type: 'string' }, models: { type: 'string' }, platforms: { type: 'string' },
    'largest-file-bytes': { type: 'string' }, version: { type: 'string' }, scope: { type: 'string' },
    operation: { type: 'string' }, partition: { type: 'string' }, 'partition-style': { type: 'string' }, label: { type: 'string' }, full: { type: 'boolean', default: false },
    firmware: { type: 'string' }, format: { type: 'string' }, 'sample-rate': { type: 'string' }, 'bit-depth': { type: 'string' },
    root: { type: 'string' }, hash: { type: 'boolean', default: false }, analysis: { type: 'boolean', default: false }, 'exporter-version': { type: 'string' },
    snapshot: { type: 'string' }, preview: { type: 'string' }, 'snapshot-identity': { type: 'string' }, restore: { type: 'boolean', default: false },
    client: { type: 'string' }, config: { type: 'string' }, target: { type: 'string' }, apply: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false }, 'expected-sha256': { type: 'string' }
    ,scheme: { type: 'string' }, 'target-system': { type: 'string' }, 'cluster-size': { type: 'string' }
    ,purpose: { type: 'string' }, 'file-size-class': { type: 'string' }
    ,'target-json': { type: 'string' }
  }, strict: true, allowPositionals: false });
  if (command === 'status') return output(await core.bridgeStatus());
  if (command === 'devices') return output(await core.listDevices());
  if (command === 'smart-plan' || command === 'detect-dj') {
    const smart = await import('./smart-plan.mjs');
    if (command === 'detect-dj') return output(await smart.detectDjEquipment());
    if (values['target-json'] && Buffer.byteLength(values['target-json'],'utf8') > 16384) throw new Error('The cached preview target is too large.');
    return output(await smart.smartMediaPlan({ deviceNumber: values.device === undefined ? undefined : Number(values.device), targetSnapshot: values['target-json'] === undefined ? undefined : JSON.parse(values['target-json']), purpose: values.purpose ?? 'dj', models: values.models?.split(/[,\s]+/).filter(Boolean) ?? [], hostPlatforms: values.platforms?.split(/[,\s]+/).filter(Boolean) ?? ['windows', 'macos'], firmwareVersions: firmwareMap(values.firmware), rekordboxVersion: values.version, largestFileBytes: values['largest-file-bytes'] === undefined ? null : Number(values['largest-file-bytes']), fileSizeClass: values['file-size-class'] ?? 'unknown', partitionScheme: values.scheme ?? 'auto' }));
  }
  if (command === 'setup-mcp' || command === 'setup-skill') {
    const setup = await import('./setup.mjs');
    if (command === 'setup-skill') return output(await setup.skillSetup({ target: values.target, apply: values.apply, dryRun: values['dry-run'] }));
    return output(await setup.applyMcpSetup({ client: values.client, configPath: values.config, apply: values.apply, dryRun: values['dry-run'], expectedSha256: values['expected-sha256'] }));
  }
  if (['export-inspect', 'snapshot-preview', 'snapshot-list', 'snapshot-create', 'restore-preview', 'snapshot-restore'].includes(command)) {
    const exportsLibrary = await import('./export-libraries.mjs');
    if (command === 'snapshot-list') return output(await exportsLibrary.listExportSnapshots());
    if (command === 'export-inspect') return output(await exportsLibrary.inspectExportLibrary({ rootPath: values.root, hashDatabases: values.hash }));
    if (command === 'snapshot-preview') return output(await exportsLibrary.previewExportSnapshot({ rootPath: values.root, includeAnalysis: values.analysis }));
    if (command === 'snapshot-create') return output(await exportsLibrary.createExportSnapshot({ rootPath: values.root, exporterVersion: values['exporter-version'], includeAnalysis: values.analysis }));
    if (command === 'restore-preview') return output(await exportsLibrary.previewRestore({ rootPath: values.root, snapshotId: values.snapshot }));
    return output(await exportsLibrary.restoreExportSnapshot({ rootPath: values.root, snapshotId: values.snapshot, previewId: values.preview, expectedSnapshotIdentity: values['snapshot-identity'], confirmation: values.confirm, confirmRestore: values.restore }));
  }
  if (['capabilities', 'details', 'verify', 'prepare-verify', 'prepare-disk', 'execute-disk'].includes(command)) {
    const disks = await import('./disks.mjs');
    if (command === 'capabilities') return output(await disks.diskCapabilities());
    if (command === 'details') return output(await disks.diskDetails(Number(values.device)));
    if (command === 'verify') return output(await disks.verifyUsbImage({ deviceNumber: Number(values.device), image: values.image, expectedSha256: values.sha256 }));
    if (command === 'prepare-verify') return output(await disks.prepareDiskOperation({ operation:'verify-image', deviceNumber: Number(values.device), image: values.image, expectedSha256: values.sha256 }));
    if (command === 'prepare-disk') return output(await disks.prepareDiskOperation({ operation: values.operation, deviceNumber: Number(values.device), partitionNumber: values.partition ? Number(values.partition) : undefined, filesystem: values.filesystem, label: values.label ?? '', quick: !values.full, partitionStyle: values['partition-style'] ?? 'GPT' }));
    return output(await disks.startDiskOperation({ planId: values.plan, confirmation: values.confirm, confirmErase: values.erase }));
  }
  if (['formats', 'dj-models', 'dj-model', 'dj-recommend', 'dj-audio', 'rekordbox-advice'].includes(command)) {
    const compatibility = await import('./compatibility.mjs');
    if (command === 'formats') return output(await compatibility.platformFormats({ platform: values.platform, filesystem: values.filesystem }));
    if (command === 'dj-models') return output(await compatibility.listDjModels({ query: values.query }));
    if (command === 'dj-model') return output(await compatibility.djCompatibility(values.model));
    if (command === 'dj-audio') return output(await compatibility.checkDjAudio({ model: values.model, format: values.format, sampleRateHz: values['sample-rate'] === undefined ? undefined : Number(values['sample-rate']), bitDepth: values['bit-depth'] === undefined ? undefined : Number(values['bit-depth']) }));
    if (command === 'dj-recommend') {
      const firmwareVersions = firmwareMap(values.firmware);
      return output(await compatibility.recommendDjMedia({ models: values.models?.split(/[,\s]+/).filter(Boolean), hostPlatforms: values.platforms?.split(/[,\s]+/).filter(Boolean) ?? ['windows', 'macos'], largestFileBytes: Number(values['largest-file-bytes'] ?? 0), firmwareVersions, rekordboxVersion: values.version }));
    }
    return output(await compatibility.rekordboxVersionAdvice(values.version, values.scope));
  }
  if (command === 'inspect') return output(await core.inspectDiskImage(values.image, values.sha256));
  if (command === 'prepare' || command === 'prepare-native-format') {
    const options = {};
    if (values.filesystem !== undefined) options.filesystem = values.filesystem;
    if (values.scheme !== undefined) options.partitionScheme = values.scheme;
    if (values['target-system'] !== undefined) options.targetSystem = values['target-system'];
    if (values['cluster-size'] !== undefined) options.clusterSize = values['cluster-size'] === 'auto' ? 'auto' : Number(values['cluster-size']);
    if (values.label !== undefined) options.volumeLabel = values.label;
    if (values.full) options.quickFormat = false;
    if (command === 'prepare-native-format') return output(await core.prepareNativeFormat({ deviceNumber: Number(values.device), nativeOptions: options }));
    return output(await core.prepareWrite({ deviceNumber: Number(values.device), image: values.image, expectedSha256: values.sha256, mode: values.mode ?? 'dd', nativeOptions: options }));
  }
  if (command === 'write' || command === 'dry-run') return output(await core.startWrite({ planId: values.plan, confirmation: values.confirm, confirmErase: values.erase, dryRun: command === 'dry-run' }));
  if (command === 'job') {
    const seconds = Number(values.timeout);
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 86400) throw new Error('Timeout must be between 1 and 86400 seconds.');
    const deadline = Date.now() + seconds * 1000;
    for (;;) {
      const status = await core.jobStatus(values.id);
      if (!values.wait || ['completed', 'failed', 'start-failed', 'prepared'].includes(status.state)) return output(status);
      if (Date.now() >= deadline) throw new Error('Job is still running; query its status again.');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  throw new Error(`Unknown command: ${command}. Use --help.`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${JSON.stringify({ error: error.code ?? 'CLI_ERROR', message: error.message, jobId:error.jobId, snapshotId:error.snapshotId, operationId:error.operationId })}\n`);
    process.exitCode = 1;
  });
}
