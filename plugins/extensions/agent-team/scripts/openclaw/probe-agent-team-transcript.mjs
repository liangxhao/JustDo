import probePaths from '../probe-paths.cjs';
const { hostRoot, pluginRoot, hostRequire } = probePaths;
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Isolated native execution against a loopback fixture provider. No user config,
// credentials, workspaces, external provider, or running Gateway is consulted.
const runtime = path.resolve(
  process.argv[2] ?? path.join(hostRoot, 'vendor/openclaw-runtime/current'),
);
const state = await mkdtemp(path.join(os.tmpdir(), 'agent-team-transcript-'));
process.env.OPENCLAW_STATE_DIR = state;
process.env.OPENCLAW_HOME = state;
process.env.OPENCLAW_CONFIG_PATH = path.join(state, 'openclaw.json');
process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = '1';
const workspace = path.join(state, 'workspace');
await mkdir(workspace);
const sdk = async name => import(pathToFileURL(path.join(runtime, `dist/plugin-sdk/${name}.js`)));
const inbound = await sdk('channel-inbound');
const sessions = await sdk('session-store-runtime');
const transcriptSdk = await sdk('session-transcript-runtime');
let modelRequests = 0;
const server = createServer((request, response) => {
  request.resume();
  request.on('end', () => {
    modelRequests++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(
      `data: ${JSON.stringify({
        id: `fixture-${modelRequests}`,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'Fixture public answer.' } }],
      })}\n\n`,
    );
    response.end(
      `data: ${JSON.stringify({
        id: `fixture-${modelRequests}`,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })}\n\ndata: [DONE]\n\n`,
    );
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const cfg = {
  agents: {
    ownership: 'explicit',
    entries: { alice: {}, bob: {} },
    defaults: {
      workspace,
      skipBootstrap: true,
      heartbeat: { every: '0m' },
      model: { primary: 'fixture/answer' },
      models: { 'fixture/answer': { agentRuntime: { id: 'openclaw' } } },
      blockStreamingDefault: 'off',
    },
  },
  models: {
    mode: 'replace',
    providers: {
      fixture: {
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        apiKey: 'synthetic-probe-key',
        api: 'openai-completions',
        request: { allowPrivateNetwork: true },
        models: [
          {
            id: 'answer',
            name: 'Fixture',
            reasoning: false,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 1024,
          },
        ],
      },
    },
  },
  plugins: { slots: { memory: 'none' } },
  tools: { profile: 'minimal', deny: ['*'] },
  broadcast: { 'agent-team:probe': { agents: ['alice', 'bob'], maxRounds: 1, maxTurns: 2 } },
};
await writeFile(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(cfg));
const deliveries = [];
const nativeRuns = new Map();
try {
  const result = await inbound.dispatchChannelInboundTurn({
    cfg,
    channel: 'agent-team',
    accountId: 'default',
    route: { agentId: 'alice', sessionKey: 'agent:alice:agent-team:group:probe' },
    ctxPayload: {
      Body: 'Give a short fixture answer.',
      RawBody: 'Give a short fixture answer.',
      CommandBody: 'Give a short fixture answer.',
      From: 'probe',
      To: 'probe',
      SessionKey: 'agent:alice:agent-team:group:probe',
      Provider: 'agent-team',
      Surface: 'agent-team',
      ChatType: 'group',
      OriginatingChannel: 'agent-team',
      OriginatingTo: 'probe',
      NativeChannelId: 'probe',
      AccountId: 'default',
      MessageSid: 'fixture-user-1',
      SenderId: 'fixture-user',
      CommandAuthorized: false,
    },
    replyOptions: {
      abortSignal: AbortSignal.timeout(45000),
      onAgentRunStart: runId => {
        const identity = inbound.getGroupThreadDeliverySession();
        assert.ok(identity);
        nativeRuns.set(identity.agentId, runId);
      },
    },
    delivery: {
      deliver: async (payload, info) => {
        const identity = inbound.getGroupThreadDeliverySession();
        assert.ok(identity);
        const entry = sessions.getSessionEntry({
          agentId: identity.agentId,
          sessionKey: identity.sessionKey,
        });
        assert.ok(entry);
        const sourceMessageId = `fixture-output-${identity.agentId}`;
        const mirror = await transcriptSdk.appendAssistantMirrorMessageByIdentity({
          ...identity,
          sessionId: entry.sessionId,
          text: payload.text,
          deliveryMirror: { kind: 'channel-final', sourceMessageId },
          idempotencyKey: sourceMessageId,
          updateMode: 'none',
          config: cfg,
        });
        assert.equal(mirror.ok, true);
        deliveries.push({
          identity,
          mirrorEntryId: mirror.messageId,
          payloadKeys: Object.keys(payload),
          infoKeys: Object.keys(info),
        });
        return { visibleReplySent: true, messageIds: [sourceMessageId] };
      },
    },
  });
  const transcripts = ['alice', 'bob'].map(agentId => {
    const key = `agent:${agentId}:agent-team:group:probe`;
    const entry = sessions.getSessionEntry({ agentId, sessionKey: key });
    const events = entry
      ? sessions.loadTranscriptEventsSync({ agentId, sessionId: entry.sessionId, sessionKey: key })
      : [];
    return {
      agentId,
      exists: Boolean(entry),
      messages: events
        .filter(event => event.type === 'message')
        .map(event => ({
          entryId: event.id,
          role: event.message?.role,
          keys: Object.keys(event.message ?? {}),
          idempotencyKey: event.message?.idempotencyKey,
          deliveryMirror: event.message?.openclawDeliveryMirror,
        })),
    };
  });
  console.log(
    JSON.stringify(
      {
        stateDirectory: state,
        dispatched: result.dispatched,
        modelRequests,
        deliveries,
        transcripts,
      },
      null,
      2,
    ),
  );
  assert.equal(modelRequests, 2, 'both native agent runs must reach the isolated provider');
  assert.equal(deliveries.length, 2, 'both native outputs must reach delivery');
  assert.ok(
    transcripts.every(
      transcript =>
        transcript.messages.some(message => message.role === 'user') &&
        transcript.messages.some(message => message.role === 'assistant'),
    ),
  );
  assert.equal(nativeRuns.size, 2);
  for (const delivery of deliveries) {
    const transcript = transcripts.find(item => item.agentId === delivery.identity.agentId);
    assert.ok(
      transcript.messages.some(
        message =>
          message.entryId === delivery.mirrorEntryId &&
          message.deliveryMirror?.kind === 'channel-final',
      ),
    );
  }
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
// Native maintenance workers retain handles after assertions have completed.
// The fixture server is closed and all tested transcript writes are awaited.
process.exit(0);
