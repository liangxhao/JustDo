import probePaths from '../probe-paths.cjs';
const { hostRoot, pluginRoot, hostRequire } = probePaths;
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
// Exercises the installed public SDK with a deterministic dispatcher. This proves
// routing and option forwarding, not native model execution or permission enforcement.
// Usage: node plugins/extensions/agent-team/scripts/openclaw/probe-agent-team-routing.mjs <prepared-runtime-directory>
assert.ok(process.argv[2], 'A prepared runtime directory is required');
const runtime = path.resolve(process.argv[2]);
const state = await mkdtemp(path.join(os.tmpdir(), 'agent-team-plan-routing-'));
Object.assign(process.env, {
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_HOME: state,
  OPENCLAW_CONFIG_PATH: path.join(state, 'openclaw.json'),
});
const sdk = await import(pathToFileURL(path.join(runtime, 'dist/plugin-sdk/channel-inbound.js')));
const version = JSON.parse(await readFile(path.join(runtime, 'package.json'), 'utf8')).version;
const channel = 'agent-team',
  peerId = 'plan-routing-probe';
const sourceKey = 'agent:main:justdo:source-probe';
const cfg = {
  agents: { entries: { main: {}, bob: {} } },
  broadcast: { [`${channel}:${peerId}`]: { agents: ['main', 'bob'], maxRounds: 1, maxTurns: 2 } },
};
const calls = [],
  deliveries = [];
async function dispatch(agentId, sessionKey, id) {
  return sdk.dispatchChannelInboundTurn({
    cfg,
    channel,
    accountId: 'default',
    route: { agentId, sessionKey },
    ctxPayload: {
      Body: 'Probe',
      RawBody: 'Probe',
      CommandBody: 'Probe',
      From: peerId,
      To: peerId,
      SessionKey: sessionKey,
      Provider: channel,
      Surface: channel,
      ChatType: 'group',
      OriginatingChannel: channel,
      OriginatingTo: peerId,
      NativeChannelId: peerId,
      AccountId: 'default',
      MessageSid: id,
    },
    replyOptions: { toolsAllow: ['read'] },
    dispatchReplyFromConfig: async ({ ctx, dispatcher, replyOptions }) => {
      calls.push({
        agentId: ctx.AgentId,
        sessionKey: ctx.SessionKey,
        policyKey: ctx.RuntimePolicySessionKey,
        toolsAllow: replyOptions.toolsAllow,
      });
      replyOptions?.onAgentRunStart?.(`fixture-${calls.length}`);
      const queuedFinal = dispatcher.sendFinalReply({ text: `Finding ${ctx.AgentId}` });
      return { queuedFinal, counts: dispatcher.getQueuedCounts() };
    },
    delivery: {
      deliver: async () => {
        deliveries.push(sdk.getGroupThreadDeliverySession());
        return { visibleReplySent: true, messageIds: [`delivery-${deliveries.length}`] };
      },
    },
  });
}
await dispatch('main', sourceKey, 'ordinary');
assert.equal(calls.length, 2);
assert.equal(calls[0].sessionKey, `agent:main:${channel}:group:${peerId}`);
assert.notEqual(calls[0].sessionKey, sourceKey);
const ordinary = calls.splice(0);
deliveries.splice(0);
const group = sdk.resolveGroupThreadConfig({ cfg, channel, peerId });
assert.ok(group);
await sdk.runGroupThread({
  cfg,
  group,
  channel,
  peerId,
  messageId: 'custom',
  text: 'Probe',
  runTurn: turn =>
    dispatch(
      turn.agentId,
      turn.agentId === 'main' ? sourceKey : `agent:bob:${channel}:group:${peerId}`,
      'custom',
    ),
});
assert.equal(calls.length, 2);
assert.equal(calls[0].sessionKey, sourceKey);
assert.equal(calls[0].policyKey, sourceKey);
assert.equal(deliveries[0].sessionKey, sourceKey);
assert.deepEqual(
  calls.map(c => c.toolsAllow),
  [['read'], ['read']],
);
console.log(
  JSON.stringify(
    {
      version,
      state,
      ordinary,
      candidate: calls,
      deliveries,
      limitations: [
        'real installed public SDK, deterministic mock dispatcher',
        'no live Gateway or model',
        'toolsAllow forwarding only; no enforcement or busy queue test',
      ],
    },
    null,
    2,
  ),
);
