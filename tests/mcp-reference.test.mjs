import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { makeServer } from '../src/server.mjs';

test('MCP reference tools and destructive schemas work without a privileged process', async () => {
  const server = makeServer();
  const client = new Client({ name: 'reference-contract-test', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    for (const name of ['write_usb', 'execute_disk_operation', 'restore_export_snapshot']) assert.equal(tools.find(tool => tool.name === name).annotations.destructiveHint, true);
    for (const name of ['filesystem_compatibility', 'recommend_dj_media', 'inspect_export_library']) assert.equal(tools.find(tool => tool.name === name).annotations.readOnlyHint, true);
    const formats = await client.callTool({ name: 'filesystem_compatibility', arguments: { platform: 'macos', filesystem: 'ntfs' } });
    assert.notEqual(formats.isError, true);
    assert.equal(JSON.parse(formats.content[0].text).filesystems[0].support.write, false);
    const advice = await client.callTool({ name: 'rekordbox_version_advice', arguments: { version: '7' } });
    assert.equal(JSON.parse(advice.content[0].text).versionStatus, 'incomplete-version');
    const denied = await client.callTool({ name: 'restore_export_snapshot', arguments: { root_path: 'unselected', snapshot_id: 'bad', confirm_restore: false } });
    assert.equal(denied.isError, true);
  } finally { await client.close(); await server.close(); }
});
