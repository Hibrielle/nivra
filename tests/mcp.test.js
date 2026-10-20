import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';
import { parseRulePack, explainRules, RULE_TEMPLATES } from '../rules.js';

test(
  'real MCP stdio handshake, discovery, pack generation, validation and simulation',
  { timeout: 15000 },
  async () => {
    const client = new Client({ name: 'nivra-test', version: '0.2.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../mcp/server.mjs', import.meta.url))],
      stderr: 'pipe',
    });
    try {
      await client.connect(transport);
      const list = await client.listTools();
      assert.equal(list.tools.length, 4);
      assert.ok(list.tools.every((tool) => tool.annotations.readOnlyHint));
      const guide = await client.callTool({ name: 'nivra_guide', arguments: {} });
      assert.equal(guide.structuredContent.templates.length, RULE_TEMPLATES.length);
      const created = await client.callTool({
        name: 'nivra_create_pack',
        arguments: { rules: [{ name: 'PDF', extensions: 'pdf', folder: '文档/{year}-{month}' }] },
      });
      assert.equal(created.isError, undefined);
      const pack = parseRulePack(created.structuredContent.json);
      assert.equal(created.structuredContent.applied, false);
      const valid = await client.callTool({
        name: 'nivra_validate',
        arguments: { pack, existingPack: pack },
      });
      assert.equal(valid.structuredContent.valid, true);
      assert.equal(valid.structuredContent.preview.added, 0);
      const sample = {
        filename: 'report.pdf',
        url: 'https://example.com/report.pdf',
        startTime: '2026-10-19T12:00:00Z',
      };
      const simulated = await client.callTool({
        name: 'nivra_simulate',
        arguments: { pack, samples: [sample], includeTrace: true },
      });
      const local = explainRules(sample, {
        enabled: true,
        rules: pack.rules.map((r, i) => ({ ...r, id: `rule-${i + 1}` })),
      });
      assert.deepEqual(simulated.structuredContent.results[0].decision, local.decision);
      assert.equal(simulated.structuredContent.results[0].steps[0].status, 'selected');
      const rooted = await client.callTool({
        name: 'nivra_simulate',
        arguments: { pack, samples: [sample], archiveRoot: '资料/下载' },
      });
      assert.equal(
        rooted.structuredContent.results[0].decision.target,
        '资料/下载/文档/2026-10/report.pdf',
      );
      const badRoot = await client.callTool({
        name: 'nivra_simulate',
        arguments: { pack, samples: [sample], archiveRoot: '../escape' },
      });
      assert.equal(badRoot.isError, true);
      const unsafe = await client.callTool({
        name: 'nivra_create_pack',
        arguments: { rules: [{ name: 'bad', extensions: 'pdf', folder: '../escape' }] },
      });
      assert.equal(unsafe.isError, true);
      const invalidTypes = await client.callTool({
        name: 'nivra_create_pack',
        arguments: {
          rules: [{ name: 'bad', extensions: 'pdf', folder: 'docs', enabled: 'false' }],
        },
      });
      assert.equal(invalidTypes.isError, true);
    } finally {
      await client.close();
    }
  },
);
