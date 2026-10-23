'use strict';

const fs = require('node:fs');
const readline = require('node:readline');
const input = readline.createInterface({ input: process.stdin });
const sharedOutputSchemas = process.env.EXTERNAL_MCP_FIXTURE_OUTPUT_SCHEMAS === 'true';
const schema = type => ({
  $id: 'urn:external-mcp:shared-output',
  type: 'object',
  properties: { value: { $ref: '#/$defs/value' } },
  $defs: { value: { type } },
  required: ['value'],
  additionalProperties: false,
});
input.on('close', () => process.exit(0));
input.on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const reply = result =>
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
  if (message.method === 'initialize') {
    reply({
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'external-mcp-fixture', version: '1' },
    });
  } else if (message.method === 'tools/list') {
    if (sharedOutputSchemas) {
      reply({
        tools: ['text', 'number'].map(name => ({
          name,
          inputSchema: { type: 'object' },
          outputSchema: schema(name === 'text' ? 'string' : 'number'),
        })),
      });
      return;
    }
    reply({
      tools: [
        {
          name: 'echo',
          inputSchema: {
            type: 'object',
            $defs: { text: { type: 'string' } },
            properties: { value: { $ref: '#/$defs/text' } },
            required: ['value'],
          },
        },
      ],
    });
  } else if (message.method === 'tools/call') {
    if (process.argv[2]) fs.appendFileSync(process.argv[2], 'call\n');
    if (sharedOutputSchemas) {
      reply({
        content: [{ type: 'text', text: String(message.params.arguments.value) }],
        structuredContent: { value: message.params.arguments.value },
      });
      return;
    }
    const run = () =>
      reply({
        content: [{ type: 'text', text: message.params.arguments.value }],
        structuredContent: {
          cwd: process.cwd(),
          custom: process.env.EXTERNAL_MCP_FIXTURE,
          leakedToken: Boolean(process.env.OPENCLAW_GATEWAY_TOKEN),
          pid: process.pid,
        },
      });
    if (message.params.arguments.value === 'wait') setTimeout(run, 10_000);
    else run();
  }
});
