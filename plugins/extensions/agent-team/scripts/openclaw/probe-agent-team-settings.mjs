import probePaths from '../probe-paths.cjs';
const { hostRoot, pluginRoot, hostRequire } = probePaths;
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
// Public SDK feasibility probe only: its limiter is not the product scheduler.
const runtime = path.resolve(
  process.argv[2] ?? path.join(hostRoot, 'vendor/openclaw-runtime/current'),
);
const state = await mkdtemp(path.join(os.tmpdir(), 'agent-team-settings-'));
process.env.OPENCLAW_STATE_DIR = state;
process.env.OPENCLAW_HOME = state;
process.env.OPENCLAW_CONFIG_PATH = path.join(state, 'openclaw.json');
const manifest = JSON.parse(await readFile(path.join(runtime, 'package.json'), 'utf8'));
const sdk = await import(pathToFileURL(path.join(runtime, 'dist/plugin-sdk/channel-inbound.js')));
const ids = ['alice', 'bob', 'carol', 'dave', 'ellen', 'frank'];
function limiter(cap, signal) {
  let active = 0;
  const queue = [];
  const admit = () => {
    while (queue.length && active < cap) {
      const item = queue.shift();
      if (signal.aborted) {
        item.reject(signal.reason);
        continue;
      }
      active++;
      item.resolve(() => {
        active--;
        admit();
      });
    }
  };
  signal.addEventListener(
    'abort',
    () => {
      for (const item of queue.splice(0)) item.reject(signal.reason);
    },
    { once: true },
  );
  return async task => {
    signal.throwIfAborted();
    const release = await new Promise((resolve, reject) => {
      queue.push({ resolve, reject });
      admit();
    });
    try {
      signal.throwIfAborted();
      return await task();
    } finally {
      release();
    }
  };
}
async function exercise({
  cap = 2,
  strategy = 'parallel',
  turns = 12,
  selected = [],
  silent = false,
  abort = false,
} = {}) {
  const controller = new AbortController();
  const bound = limiter(cap, controller.signal);
  let active = 0,
    peak = 0;
  const calls = [],
    deliveries = [];
  const peer = `room-${Math.random().toString(36).slice(2)}`;
  const root = `agent:alice:agent-team:group:${peer}`;
  const cfg = {
    agents: { entries: Object.fromEntries(ids.map(id => [id, {}])) },
    broadcast: {
      strategy,
      [`agent-team:${peer}`]: { agents: ids, mentionGating: true, maxRounds: 2, maxTurns: turns },
    },
  };
  await sdk.dispatchChannelInboundTurn({
    cfg,
    channel: 'agent-team',
    accountId: 'default',
    route: { agentId: 'alice', sessionKey: root },
    ctxPayload: {
      Body: 'Review fixture',
      RawBody: 'Review fixture',
      CommandBody: 'Review fixture',
      From: peer,
      To: peer,
      SessionKey: root,
      Provider: 'agent-team',
      Surface: 'agent-team',
      ChatType: 'group',
      OriginatingChannel: 'agent-team',
      OriginatingTo: peer,
      NativeChannelId: peer,
      AccountId: 'default',
      MessageSid: peer,
      GroupThread: { mentionedAgentIds: selected },
    },
    replyOptions: { abortSignal: controller.signal },
    dispatchReplyFromConfig: params =>
      bound(async () => {
        const id = params.ctx.AgentId;
        calls.push(id);
        active++;
        peak = Math.max(peak, active);
        try {
          await new Promise(resolve => setTimeout(resolve, 20));
          if (abort) controller.abort();
          const queuedFinal = params.dispatcher.sendFinalReply({
            text: silent ? 'NO_REPLY' : `Evidence from ${id}`,
          });
          return { queuedFinal, counts: params.dispatcher.getQueuedCounts() };
        } finally {
          active--;
        }
      }),
    delivery: {
      deliver: async payload => {
        deliveries.push(payload.text);
        return { visibleReplySent: true, messageIds: [String(deliveries.length)] };
      },
    },
  });
  return { peak, calls, deliveries };
}
const bounded = await exercise();
assert.equal(bounded.peak, 2);
assert.equal(bounded.calls.length, 12);
const serial = await exercise({ cap: 6, strategy: 'sequential' });
assert.equal(serial.peak, 1);
const budget = await exercise({ turns: 5 });
assert.equal(budget.calls.length, 5);
const directed = await exercise({ selected: ['bob'], turns: 6, silent: true });
assert.deepEqual(directed.calls, ['bob']);
const quiet = await exercise({ silent: true });
assert.equal(quiet.calls.length, 6);
assert.equal(quiet.deliveries.length, 0);
const cancelled = await exercise({ cap: 1, abort: true });
assert.equal(cancelled.calls.length, 1);
assert.equal(bounded.peak, 2);
console.log(
  JSON.stringify(
    {
      runtimeVersion: manifest.version,
      checks: {
        boundedPeak: bounded.peak,
        turns: bounded.calls.length,
        sequentialPeak: serial.peak,
        budgetTurns: budget.calls.length,
        directed: directed.calls,
        silentTurns: quiet.calls.length,
        abortStarted: cancelled.calls.length,
      },
      scope:
        'Real installed public SDK with delayed fixture dispatcher; no model, Gateway execution, user configuration or runtime patch changes.',
    },
    null,
    2,
  ),
);
