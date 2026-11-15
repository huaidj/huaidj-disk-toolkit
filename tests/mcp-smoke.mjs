import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from '../src/core.mjs';
import assert from 'node:assert/strict';

const client = new Client({ name: 'huaidj-rufus-local-validation', version: '0.1.0' }, { capabilities: {} });
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(projectRoot, 'src', 'cli.mjs'), 'mcp'], stderr: 'pipe' });
let stderr = '';
transport.stderr?.on('data', data => { stderr += String(data); });
try {
  await client.connect(transport);
  const list = await client.listTools();
  assert.ok(list.tools.length >= 12);
  assert.equal(list.tools.find(t => t.name === 'write_usb').annotations.destructiveHint, true);
  const status = await client.callTool({ name: 'rufus_status', arguments: {} });
  assert.equal(status.isError, undefined);
  const devices = await client.callTool({ name: 'list_usb_devices', arguments: {} });
  assert.equal(devices.isError, undefined);
  const parsed = JSON.parse(devices.content[0].text);
  assert.ok(Array.isArray(parsed.devices));
  assert.ok(parsed.devices.every(d => !Object.hasOwn(d, 'serial')));
  assert.ok(parsed.devices.filter(d => d.busType !== 'USB').every(d => d.eligible === false));
  const rejection = await client.callTool({ name: 'write_usb', arguments: { plan_id: 'bad', confirmation: 'bad', confirm_erase: false } });
  assert.equal(rejection.isError, true);
  const receipt = {
    timestampUTC: new Date().toISOString(), server: client.getServerVersion(),
    tools: list.tools.map(t => ({ name: t.name, annotations: t.annotations })),
    initialize: 'PASS', discovery: 'PASS', readOnlyDeviceCall: 'PASS', schemaRejection: 'PASS',
    nativeEngineAvailable: JSON.parse(status.content[0].text).nativeEngineAvailable,
    usbDeviceCount: parsed.devices.filter(d => d.busType === 'USB').length,
    internalDiskEligible: parsed.devices.some(d => d.busType !== 'USB' && d.eligible),
    stderrBytes: Buffer.byteLength(stderr)
  };
  await writeFile(path.join(projectRoot, 'work', 'mcp-smoke.json'), JSON.stringify(receipt, null, 2));
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
} finally { await client.close(); }
