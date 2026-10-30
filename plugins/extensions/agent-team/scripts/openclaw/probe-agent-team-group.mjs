import probePaths from '../probe-paths.cjs';
const { hostRoot, pluginRoot, hostRequire } = probePaths;
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// This probe exercises the installed public SDK, not a reimplementation of its
// scheduler. The model boundary is a deterministic fixture; no provider is used.
const runtime = path.resolve(
  process.argv[2] ?? path.join(hostRoot, 'vendor/openclaw-runtime/current'),
);
const state = await mkdtemp(path.join(os.tmpdir(), 'agent-team-probe-'));
process.env.OPENCLAW_STATE_DIR = state;
process.env.OPENCLAW_HOME = state;
process.env.OPENCLAW_CONFIG_PATH = path.join(state, 'openclaw.json');
const manifest = JSON.parse(await readFile(path.join(runtime, 'package.json'), 'utf8'));
const sdk = await import(pathToFileURL(path.join(runtime, 'dist/plugin-sdk/channel-inbound.js')));
const channel = 'agent-team';
const roomId = 'probe';
const agentIds = ['alice', 'bob'];
const checks = [];

async function exercise({
  selected = [],
  rounds = 2,
  strategy,
  silent = false,
  abort = false,
} = {}) {
  const controller = new AbortController();
  const calls = [];
  const deliveries = [];
  const rootKey = `agent:alice:${channel}:group:${roomId}`;
  const result = await sdk.dispatchChannelInboundTurn({
    cfg: {
      agents: { entries: { alice: {}, bob: {} } },
      broadcast: {
        ...(strategy ? { strategy } : {}),
        [`${channel}:${roomId}`]: { agents: agentIds, maxRounds: rounds, maxTurns: 8 },
      },
    },
    channel,
    accountId: 'default',
    route: { agentId: 'alice', sessionKey: rootKey },
    ctxPayload: {
      Body: 'Evaluate the fixture.',
      RawBody: 'Evaluate the fixture.',
      CommandBody: 'Evaluate the fixture.',
      From: roomId,
      To: roomId,
      SessionKey: rootKey,
      Provider: channel,
      Surface: channel,
      ChatType: 'group',
      OriginatingChannel: channel,
      OriginatingTo: roomId,
      NativeChannelId: roomId,
      AccountId: 'default',
      MessageSid: `probe-${checks.length}`,
      GroupThread: { mentionedAgentIds: selected },
    },
    replyOptions: { abortSignal: controller.signal },
    dispatchReplyFromConfig: async ({ ctx, dispatcher, replyOptions }) => {
      calls.push({ agentId: ctx.AgentId, sessionKey: ctx.SessionKey, body: ctx.Body });
      replyOptions?.onAgentRunStart?.(`fixture-${calls.length}`);
      if (abort) controller.abort();
      const queuedFinal = dispatcher.sendFinalReply({
        text: silent ? 'NO_REPLY' : `Finding from ${ctx.AgentId}.`,
      });
      return { queuedFinal, counts: dispatcher.getQueuedCounts() };
    },
    delivery: {
      deliver: async (payload, info) => {
        deliveries.push({
          text: payload.text,
          identity: sdk.getGroupThreadDeliverySession(),
          infoKeys: Object.keys(info).sort(),
        });
        return { visibleReplySent: true, messageIds: [`fixture-delivery-${deliveries.length}`] };
      },
    },
  });
  assert.equal(result.dispatched, true);
  return { calls, deliveries };
}

const broadcast = await exercise();
assert.equal(broadcast.calls.length, 4);
assert.equal(broadcast.deliveries.length, 4);
assert.deepEqual(new Set(broadcast.calls.map(call => call.agentId)), new Set(agentIds));
assert.ok(broadcast.calls.slice(2).every(call => call.body.includes('otherwise reply NO_REPLY')));
assert.ok(broadcast.deliveries.every(delivery => delivery.identity?.sessionKey));
checks.push('native fan-out, sibling digest, and delivery session attribution');

const directed = await exercise({ selected: ['bob'], rounds: 1 });
assert.deepEqual(
  directed.calls.map(call => call.agentId),
  ['bob'],
);
checks.push('first-round explicit participant selection');

const quiet = await exercise({ silent: true });
assert.equal(quiet.calls.length, 2);
assert.equal(quiet.deliveries.length, 0);
checks.push('silent replies suppressed and no next round');

const stopped = await exercise({ strategy: 'sequential', abort: true });
assert.equal(stopped.calls.length, 1);
checks.push('abort prevents subsequent launches (not a live model cancellation test)');

console.log(
  JSON.stringify(
    {
      runtimeVersion: manifest.version,
      stateDirectory: state,
      checks,
      deliveryIdentityFields: Object.keys(broadcast.deliveries[0].identity).sort(),
      deliveryInfoFields: broadcast.deliveries[0].infoKeys,
      limitations: [
        'fixture model',
        'no live Gateway',
        'no claim of durable history or permission propagation',
      ],
    },
    null,
    2,
  ),
);
