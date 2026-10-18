import fs from 'node:fs';
import readline from 'node:readline';

const receipts = { calls: {}, cancellations: 0 };
const save = () => fs.writeFileSync(process.env.MCP_FIXTURE_RECEIPTS, JSON.stringify(receipts));
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const result = (id, value) => send({ jsonrpc: '2.0', id, result: value });
const pending = new Map();
let enabled = true;
const ui = { resourceUri: 'ui://fixture/app', visibility: ['app', 'model'] };
const appOnly = { ui: { visibility: ['app'] } };
const tool = (name, readOnlyHint = true, meta = appOnly) => ({
  name,
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint, destructiveHint: !readOnlyHint },
  _meta: meta,
});
const tools = [
  tool('show', true, {
    ui,
    'openai/ui': {
      entrypoints: [{ type: 'global' }, { type: 'thread' }, { type: 'file', extensions: ['.txt'] }],
    },
  }),
  tool('echo', false),
  tool('slow'),
  tool('ask'),
  tool('settings_read'),
  tool('settings_update', false),
  tool('mentions', true, { ...appOnly, 'openai/extensions': { 'mentions/search': {} } }),
];
tools[0].inputSchema = {
  type: 'object',
  properties: { metric: { type: 'string', default: 'retention' } },
};
save();
for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === 'notifications/cancelled') {
    receipts.cancellations++;
    pending.delete(message.params.requestId);
    save();
    continue;
  }
  if (!message.method) {
    const original = pending.get(message.id);
    if (original !== undefined) {
      pending.delete(message.id);
      result(original, { content: [{ type: 'text', text: JSON.stringify(message.result) }] });
    }
    continue;
  }
  if (message.id === undefined) continue;
  if (message.method === 'initialize') {
    result(message.id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: {
        tools: {},
        resources: {},
        extensions: {
          'openai/settings': { readTool: 'settings_read', updateTool: 'settings_update' },
        },
      },
      serverInfo: { name: 'MCP Apps fixture', version: '1' },
    });
  } else if (message.method === 'ping') result(message.id, {});
  else if (message.method === 'tools/list') result(message.id, { tools });
  else if (message.method === 'resources/list')
    result(message.id, {
      resources: [{ uri: 'fixture://data', name: 'Data', mimeType: 'text/plain' }],
    });
  else if (message.method === 'resources/templates/list')
    result(message.id, { resourceTemplates: [] });
  else if (message.method === 'resources/read')
    result(message.id, {
      contents: [
        {
          uri: message.params.uri,
          mimeType: message.params.uri.startsWith('ui://')
            ? 'text/html;profile=mcp-app'
            : 'text/plain',
          text: message.params.uri.startsWith('ui://')
            ? '<!doctype html><title>Fixture</title><p>MCP App fixture</p>'
            : 'Fixture resource',
        },
      ],
    });
  else if (message.method === 'tools/call') {
    const { name, arguments: args = {} } = message.params;
    receipts.calls[name] = (receipts.calls[name] ?? 0) + 1;
    save();
    if (name === 'slow') {
      setTimeout(() => {
        receipts.slowCompleted = (receipts.slowCompleted ?? 0) + 1;
        save();
        result(message.id, { content: [{ type: 'text', text: 'completed after local close' }] });
      }, 1500);
      continue;
    }
    if (name === 'ask') {
      const id = `elicitation-${message.id}`;
      pending.set(id, message.id);
      send({
        jsonrpc: '2.0',
        id,
        method: 'elicitation/create',
        params: {
          mode: 'form',
          message: 'Choose a fixture value',
          requestedSchema: {
            type: 'object',
            properties: { name: { type: 'string', title: 'Name' } },
            required: ['name'],
          },
        },
      });
      continue;
    }
    if (name === 'settings_update') enabled = args.set?.enabled ?? enabled;
    result(message.id, {
      content: [{ type: 'text', text: name === 'echo' ? `echo:${args.value}` : name }],
      ...(name === 'settings_read'
        ? {
            structuredContent: {
              schema: {
                type: 'object',
                properties: { enabled: { type: 'boolean', title: 'Enabled' } },
              },
              values: { enabled },
            },
          }
        : {}),
      ...(name === 'mentions'
        ? {
            structuredContent: {
              items: [{ type: 'resource_link', uri: 'fixture://data', name: 'Fixture resource' }],
            },
          }
        : {}),
    });
  } else
    send({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: 'Unknown fixture method' },
    });
}
