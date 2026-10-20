// Real Main registry/submission/binding pipeline; no database or user Gateway required.
import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import { buildSync } from 'esbuild';

const filename = path.resolve('scripts/test/plugin-host/structured-input-fixture.cjs');
const compiled = buildSync({
  stdin: {
    resolveDir: process.cwd(),
    loader: 'ts',
    contents: `
export {AppPluginRegistry} from './src/main/plugins/app/registry';
export {AppSessionParticipants} from './src/main/plugins/app/sessionParticipants';
export {appendAppInput} from './plugins/extensions/runtime-services/contracts/app-input';
export {bindPluginGatewayClient} from './src/main/engine/gateway/pluginRequestBinding';
`,
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
}).outputFiles[0].text;
const module = new Module(filename);
module.paths = Module._nodeModulePaths(path.dirname(filename));
module._compile(compiled, filename);
const { AppPluginRegistry, AppSessionParticipants, appendAppInput, bindPluginGatewayClient } =
  module.exports;
const binding = {
  pluginId: 'structured',
  registrationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  processId: 123,
  gatewayMethods: [],
};
let enabled = true;
let received;
let effects = 0;
const calls = [];
const client = bindPluginGatewayClient({
  request: async (method, params, options) => {
    calls.push({ method, params, options });
    return {};
  },
});
const registry = new AppPluginRegistry(() => ({ enabled, confirmed: true, binding }));
const artifact = {
  root: process.cwd(),
  artifact: {
    hash: 'a'.repeat(64),
    files: {},
    manifest: {
      manifestVersion: 1,
      apiVersion: 1,
      id: 'structured',
      nativePluginId: 'structured',
      version: '1.0.0',
      entries: { main: 'unused.mjs', browser: 'unused-browser.mjs' },
      capabilities: [],
      commands: [],
      slots: [],
    },
  },
};
const checks = {};
try {
  await registry.prepare(
    artifact,
    {
      getDatabase: () => {
        throw new Error('No database is needed');
      },
      getNativeStateDirectory: () => '',
      getSessions: () => ({
        createSession: () => {
          effects++;
          return { id: 'created' };
        },
      }),
      getExecution: () => ({}),
      getRuntime: () => ({ getGatewayClient: () => client }),
      requestGateway: (...args) => client.request(...args),
      requestConnectedGateway: (...args) => client.request(...args),
      onNativeEvent: () => () => {},
      onSessionStopped: () => () => {},
      sessionsChanged() {},
    },
    async () => ({
      register: host => ({
        commands: [],
        submission: {
          matches: (_prompt, submission) => submission?.input?.options?.count === 2,
          register: async input => {
            received = input.submission;
            host.getSessions().createSession('structured');
            await host.requestGateway('fixture.structured', input.submission.input);
          },
          markSubmissionStarted: async () => {
            host.getSessions().createSession('start');
          },
          abortBeforeSend: async () => true,
          cancel: async () => {},
          releaseIfSettled: async () => true,
        },
      }),
    }),
  );
  registry.activate();
  const participants = new AppSessionParticipants(registry);
  const epoch = registry.snapshot()[0].epoch;
  const input = {
    options: { count: 2 },
    binding: {
      pluginId: 'foreign',
      registrationId: 'forged',
      processId: 999,
    },
  };
  const encode = (data, requestedEpoch = epoch) =>
    appendAppInput('visible', {
      v: 1,
      pluginId: 'structured',
      epoch: requestedEpoch,
      mode: 'custom',
      prompt: 'native request',
      input: data,
    });
  const prompt = encode(input);
  checks.inputAvailableToMatch = participants.matches(prompt);
  await participants.register({ sessionId: 'source', clientTurnId: 'turn', prompt });
  assert.deepEqual(received.input, input);
  checks.inputArrivesInBusinessScope = effects === 1;
  checks.dataCannotChooseNativeOwner =
    calls[0].method === 'structured.app.dispatch' &&
    calls[0].params.registrationId === binding.registrationId &&
    calls[0].params.processId === binding.processId;
  await assert.rejects(
    registry.registrations()[0].submission.register({
      sessionId: 'source',
      clientTurnId: 'outside',
      prompt,
      submission: received,
    }),
  );
  checks.outsideScopeCannotEffect = effects === 1;
  await assert.rejects(
    participants.register({
      sessionId: 'source',
      clientTurnId: 'conflict',
      prompt,
      submission: { pluginId: 'structured', epoch: 'wrong', mode: 'custom' },
    }),
  );
  checks.conflictingEnvelopeRejected = effects === 1;
  await assert.rejects(
    participants.register({
      sessionId: 'source',
      clientTurnId: 'large',
      prompt: encode({ options: { count: 2 }, text: 'x'.repeat(1100000) }),
    }),
  );
  checks.oversizedInputRejected = effects === 1;
  await registry.mutate('structured', false, async () => {
    enabled = false;
  });
  await assert.rejects(participants.markSubmissionStarted('source', 'turn'));
  checks.retiredSubmissionCannotStart = effects === 1;
  await registry.mutate('structured', true, async () => {
    enabled = true;
  });
  await assert.rejects(
    participants.register({ sessionId: 'source', clientTurnId: 'stale', prompt }),
  );
  checks.oldEnvelopeCannotBorrowNewEpoch = effects === 1;
  const cleanupRegistry = new AppPluginRegistry(() => ({ enabled: false, confirmed: true }));
  try {
    await cleanupRegistry.prepare(
      artifact,
      {},
      async () => ({
        register: () => ({
          commands: [],
          nativePolicy: {
            skills: ['legacy-skill'],
            sandboxTools: ['legacy_action'],
            surfaces: { legacy: { silentReply: { group: 'allow' } } },
          },
        }),
      }),
      { cleanupOnly: true },
    );
    const cleanupPolicy = cleanupRegistry.nativePolicy();
    checks.cleanupOnlyCannotProjectBusinessPolicy =
      cleanupPolicy.skills.length === 0 &&
      cleanupPolicy.sandboxTools.length === 0 &&
      Object.keys(cleanupPolicy.surfaces).length === 0;
  } finally {
    cleanupRegistry.dispose();
  }
  console.log(
    JSON.stringify({
      realRegistry: true,
      realSessionParticipants: true,
      realRequestBinding: true,
      checks,
    }),
  );
  assert.ok(
    Object.values(checks).every(Boolean),
    'Every structured input admission control must pass',
  );
} finally {
  registry.dispose();
}
