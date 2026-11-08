import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { WebSocketServer } from 'ws';

const [repoRoot, runtimeRoot, fixtureRoot] = process.argv.slice(2);
process.env.OPENCLAW_HOME = fixtureRoot;
process.env.OPENCLAW_STATE_DIR = fixtureRoot;
process.env.OPENAI_API_KEY = 'unrelated-environment-key';
const compiled = path.join(fixtureRoot, 'managed-realtime-voice.mjs');
const compilation = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  banner: {
    js: 'import { createRequire as makeRequire } from "node:module"; const require = makeRequire(import.meta.url);',
  },
  plugins: [
    {
      name: 'locked-public-sdk',
      setup(builder) {
        builder.onResolve({ filter: /^openclaw\/plugin-sdk\// }, args => ({
          path: pathToFileURL(
            path.join(runtimeRoot, 'dist/plugin-sdk', `${args.path.split('/').at(-1)}.js`),
          ).href,
          external: true,
        }));
      },
    },
  ],
};
await build({
  ...compilation,
  entryPoints: [
    path.join(repoRoot, 'plugins/extensions/openai/managed-realtime-voice-provider.ts'),
  ],
  outfile: compiled,
});
const { buildManagedRealtimeVoiceProvider, resolveManagedRealtimeVoiceProfile } = await import(
  pathToFileURL(compiled).href
);
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise(resolve => server.once('listening', resolve));
let connectionCount = 0;
let receivedHeaders;
const messages = [];
let socket;
server.on('connection', (connected, request) => {
  connectionCount += 1;
  socket = connected;
  receivedHeaders = request.headers;
  connected.send(JSON.stringify({ type: 'session.created' }));
  connected.on('message', value => {
    const event = JSON.parse(value.toString());
    messages.push(event);
    if (event.type === 'session.update')
      connected.send(JSON.stringify({ type: 'session.updated' }));
  });
});
const profile = {
  protocolId: 'openai-voice-realtime',
  configurationId: 'realtimeVoice.fixture-credential-version.apiKey',
  baseUrl: `ws://127.0.0.1:${server.address().port}/service/realtime/`,
  model: 'internal/live/model',
  speakerVoice: 'internal-voice',
  inputTranscriptionModel: 'internal-input-model',
  apiKey: '',
};
const cfg = { plugins: { entries: { openai: { config: { realtimeVoice: profile } } } } };
let forbiddenAuthCalls = 0;
const forbidden = () => {
  forbiddenAuthCalls += 1;
  throw new Error('No implicit auth source allowed');
};
const provider = buildManagedRealtimeVoiceProvider({
  createRealtimeTranscriptionWebSocketSession: forbidden,
  resolveProviderRequestHeaders: forbidden,
  resolveDebugProxySettings: () => undefined,
  createDebugProxyWebSocketAgent: () => undefined,
  warn: () => undefined,
});
const catalogFile = path.join(fixtureRoot, 'capability-catalog.mjs');
await build({
  ...compilation,
  entryPoints: [path.join(repoRoot, 'plugins/extensions/openai/capability-catalog.ts')],
  outfile: catalogFile,
});
const catalog = (await import(pathToFileURL(catalogFile).href)).default({});
assert.deepEqual(
  catalog.realtimeVoiceProviders.map(value => value.id),
  ['openai'],
);
for (const value of [...catalog.realtimeVoiceProviders, ...catalog.speechProviders]) {
  assert.equal(value.defaultModel, undefined);
  assert.equal(value.models, undefined);
  assert.equal(value.voices, undefined);
}
const speechProvider = catalog.speechProviders[0];
const speechBase = {
  protocolId: 'openai-speech-http',
  baseUrl: 'http://speech.fixture/v1',
  model: 'arbitrary/speech-model',
  speakerVoice: 'CaseSensitiveVoice',
  apiKey: '',
};
for (const fields of [
  { compatibilityProfile: undefined },
  { protocolId: 'chat-audio-speech' },
  { modelId: '\ncustom-model' },
  { voiceId: 'custom-voice\n' },
]) {
  assert.throws(() =>
    speechProvider.resolveTalkConfig({ baseTtsConfig: speechBase, talkProviderConfig: fields }),
  );
  assert.throws(() => speechProvider.resolveTalkOverrides({ params: fields }));
}
assert.equal(
  speechProvider.resolveTalkConfig({
    baseTtsConfig: speechBase,
    talkProviderConfig: { modelId: 'another/arbitrary-model', voiceId: 'AnotherCaseVoice' },
  }).voice,
  'AnotherCaseVoice',
);
const publicFactoryFile = path.join(fixtureRoot, 'public-voice-factory.mjs');
await build({
  ...compilation,
  entryPoints: [
    path.join(repoRoot, 'plugins/extensions/openai/realtime-voice-provider-factory.ts'),
  ],
  outfile: publicFactoryFile,
});
const { buildOpenAIRealtimeVoiceProvider } = await import(pathToFileURL(publicFactoryFile).href);
const publicProvider = buildOpenAIRealtimeVoiceProvider({});
assert.deepEqual(publicProvider.resolveConfig({ cfg: {}, rawConfig: profile }), {});
assert.equal(publicProvider.isConfigured({ providerConfig: {} }), false);
assert.throws(() => publicProvider.createBridge({ providerConfig: {} }), /not configured/);
assert.equal(publicProvider.createBrowserSession, undefined);
assert.equal(connectionCount, 0);
const publicApiFile = path.join(fixtureRoot, 'public-api.mjs');
await build({
  ...compilation,
  entryPoints: [path.join(repoRoot, 'plugins/extensions/openai/api.ts')],
  outfile: publicApiFile,
});
const publicApi = await import(pathToFileURL(publicApiFile).href);
for (const name of [
  'buildOpenAIProvider',
  'loginOpenAICodexOAuth',
  'refreshOpenAICodexToken',
  'buildOpenAIRealtimeTranscriptionProvider',
  'buildOpenAIRealtimeVoiceProvider',
])
  assert.equal(typeof publicApi[name], 'function', `preserved public API: ${name}`);
const exportedVoice = publicApi.buildOpenAIRealtimeVoiceProvider();
assert.deepEqual(exportedVoice.capabilities.transports, ['gateway-relay']);
assert.equal(exportedVoice.createBrowserSession, undefined);
assert.deepEqual(exportedVoice.resolveConfig({ cfg: {}, rawConfig: profile }), {});
assert.equal(exportedVoice.isConfigured({ providerConfig: {} }), false);
assert.equal(connectionCount, 0);
const source = path.join(repoRoot, 'plugins/extensions/openai');
const manifest = JSON.parse(await fs.readFile(path.join(source, 'openclaw.plugin.json'), 'utf8'));
assert.deepEqual(manifest.contracts.realtimeVoiceProviders, ['openai']);
const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
async function nativeOwner(prefix, symbol, declaration) {
  const directory = path.join(runtimeRoot, 'dist');
  const matches = [];
  for (const name of (await fs.readdir(directory)).filter(
    name => name.startsWith(prefix) && name.endsWith('.mjs'),
  )) {
    const content = await fs.readFile(path.join(directory, name), 'utf8');
    if (!content.includes(declaration)) continue;
    const exported = content
      .slice(content.lastIndexOf('\nexport {'))
      .match(new RegExp('\\b' + symbol + '(?: as ([\\w$]+))?\\s*[,}]'));
    if (exported) matches.push({ name, content, exportedName: exported[1] ?? symbol });
  }
  assert.equal(matches.length, 1);
  const selected = matches[0];
  assert.ok(
    asar
      .extractFile(path.join(runtimeRoot, 'gateway.asar'), 'dist/' + selected.name)
      .equals(Buffer.from(selected.content)),
  );
  return (await import(pathToFileURL(path.join(directory, selected.name)).href))[
    selected.exportedName
  ];
}
const validatePluginSchemaValue = await nativeOwner(
  'schema-validator-',
  'validatePluginSchemaValue',
  'function validatePluginSchemaValue(',
);
const schema = value =>
  validatePluginSchemaValue({
    origin: 'bundled',
    schema: manifest.configSchema,
    cacheKey: 'managed-realtime-voice',
    value,
  });
assert.equal(schema({ realtimeVoice: profile }).ok, true);
assert.equal(schema({ realtimeVoice: null }).ok, true);
for (const value of [
  { ...profile, inputTranscriptionModel: '' },
  { ...profile, unknown: true },
  { ...profile, apiKey: null },
  { ...profile, model: 'x'.repeat(257) },
])
  assert.equal(schema({ realtimeVoice: value }).ok, false);
assert.equal(
  schema({
    realtimeVoice: { ...profile, apiKey: { source: 'file', provider: 'fixture', id: '/key' } },
  }).ok,
  true,
);
const OpenClawSchema = await nativeOwner('zod-schema-', 'OpenClawSchema', 'const OpenClawSchema =');
assert.equal(
  OpenClawSchema.safeParse({
    ...cfg,
    agents: { ownership: 'explicit', entries: { main: {} } },
    talk: {
      realtime: {
        provider: 'openai',
        model: profile.model,
        speakerVoice: profile.speakerVoice,
        transport: 'gateway-relay',
        consultRouting: 'force-agent-consult',
      },
    },
  }).success,
  true,
);
const secretPath = path.join(fixtureRoot, 'voice-credentials.json');
await fs.writeFile(secretPath, JSON.stringify({ key: 'isolated-voice-key' }), { mode: 0o600 });
if (process.platform === 'win32') {
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const options = { windowsHide: true, encoding: 'utf8', timeout: 5000 };
  const sid = execFileSync(
    path.join(system, 'whoami.exe'),
    ['/user', '/fo', 'csv', '/nh'],
    options,
  ).match(/S-1-\d+(?:-\d+)+/)?.[0];
  assert.ok(sid);
  execFileSync(
    path.join(system, 'icacls.exe'),
    [secretPath, '/inheritance:r', '/grant:r', `*${sid}:F`, '*S-1-5-18:F', '*S-1-5-32-544:F'],
    options,
  );
}
const secretRef = { source: 'file', provider: 'voice-credentials', id: '/key' };
const secretConfig = {
  agents: { ownership: 'explicit', entries: { main: {} } },
  secrets: {
    providers: { 'voice-credentials': { source: 'file', path: secretPath, mode: 'json' } },
  },
  plugins: {
    allow: ['openai'],
    entries: {
      openai: { enabled: true, config: { realtimeVoice: { ...profile, apiKey: secretRef } } },
    },
  },
};
const redactConfigObject = await nativeOwner(
  'redact-snapshot-',
  'redactConfigObject',
  'function redactConfigObject(',
);
const redactedConfig = redactConfigObject(secretConfig, {
  'plugins.entries.openai.config.realtimeVoice.apiKey': { sensitive: true },
});
assert.notEqual(redactedConfig.plugins.entries.openai.config.realtimeVoice.apiKey.id, secretRef.id);
assert.equal(
  redactedConfig.plugins.entries.openai.config.realtimeVoice.configurationId,
  profile.configurationId,
);
assert.deepEqual(secretConfig.plugins.entries.openai.config.realtimeVoice.apiKey, secretRef);
const prepareSecretsRuntimeSnapshot = await nativeOwner(
  'runtime-',
  'prepareSecretsRuntimeSnapshot',
  'async function prepareSecretsRuntimeSnapshot(',
);
const snapshot = await prepareSecretsRuntimeSnapshot({
  config: secretConfig,
  includeAuthStoreRefs: false,
  loadablePluginOrigins: new Map([['openai', 'bundled']]),
  manifestRegistry: {
    plugins: [
      {
        ...manifest,
        origin: 'bundled',
        rootDir: source,
        source: path.join(source, 'index.ts'),
        manifestPath: path.join(source, 'openclaw.plugin.json'),
        channels: [],
        skills: [],
        hooks: [],
        cliBackends: [],
      },
    ],
    diagnostics: [],
  },
});
assert.deepEqual(snapshot.degradedOwners, []);
assert.equal(
  snapshot.config.plugins.entries.openai.config.realtimeVoice.apiKey,
  'isolated-voice-key',
);
assert.deepEqual(secretConfig.plugins.entries.openai.config.realtimeVoice.apiKey, secretRef);
assert.equal(
  provider.resolveConfig({ cfg: snapshot.config, rawConfig: {} }).apiKey,
  'isolated-voice-key',
);
assert.equal(provider.createBrowserSession, undefined);
assert.deepEqual(provider.capabilities.transports, ['gateway-relay']);
assert.equal(provider.capabilities.supportsSessionResumption, false);
const resolved = provider.resolveConfig({
  cfg,
  rawConfig: { baseUrl: 'https://unrelated.invalid', apiKey: 'other' },
});
assert.equal(resolved.model, profile.model);
assert.equal(resolved.apiKey, '');
assert.equal(provider.isConfigured({ providerConfig: resolved }), true);
for (const value of [
  null,
  {},
  { ...profile, protocolId: 'other' },
  { ...profile, compatibilityProfile: 'removed' },
  { ...profile, compatibilityProfile: undefined },
  { ...profile, model: '' },
  { ...profile, speakerVoice: '' },
  { ...profile, inputTranscriptionModel: '' },
  { ...profile, apiKey: null },
  { ...profile, apiKey: { source: 'env', id: 'OPENAI_API_KEY' } },
  { ...profile, baseUrl: `${profile.baseUrl}?deployment=fixture` },
  { ...profile, baseUrl: 'https://user:password@host/realtime' },
])
  assert.equal(resolveManagedRealtimeVoiceProfile(value), null);
assert.deepEqual(provider.resolveConfig({ cfg: {}, rawConfig: profile }), {});
assert.equal(provider.isConfigured({ providerConfig: {} }), false);
assert.throws(() => provider.createBridge({ providerConfig: {} }), /not configured/);
const transcripts = [];
const audio = [];
let closed = false;
const bridge = provider.createBridge({
  cfg,
  providerConfig: resolved,
  autoRespondToAudio: false,
  instructions: 'fixture instructions',
  tools: [],
  onAudio: bytes => audio.push(bytes),
  onClearAudio() {},
  onTranscript: (...args) => transcripts.push(args),
  onClose: () => {
    closed = true;
  },
  onError: () => {},
});
try {
  await bridge.connect();
  assert.equal(receivedHeaders.authorization, undefined);
  assert.equal(forbiddenAuthCalls, 0);
  const update = messages.find(event => event.type === 'session.update');
  assert.equal(update.session.model, profile.model);
  assert.equal(update.session.audio.input.transcription.model, profile.inputTranscriptionModel);
  assert.equal(update.session.audio.output.voice, profile.speakerVoice);
  assert.deepEqual(update.session.audio.input.format, { type: 'audio/pcm', rate: 24000 });
  assert.equal(update.session.audio.input.turn_detection.create_response, false);
  bridge.sendAudio(Buffer.alloc(960));
  socket.send(
    JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'fixture',
    }),
  );
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(messages.some(event => event.type === 'input_audio_buffer.append'));
  assert.equal(transcripts.length, 1);
  socket.close();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(closed, true);
  assert.equal(connectionCount, 1);
  assert.equal(forbiddenAuthCalls, 0);
  const authenticated = provider.createBridge({
    providerConfig: { ...resolved, apiKey: 'explicit-fixture-key' },
    onAudio() {},
    onClearAudio() {},
    onClose() {},
    onError() {},
  });
  await authenticated.connect();
  assert.equal(receivedHeaders.authorization, 'Bearer explicit-fixture-key');
  authenticated.close();
  bridge.close();
} finally {
  server.clients.forEach(client => client.terminate());
  await new Promise(resolve => server.close(resolve));
  await fs.rm(compiled, { force: true });
}
console.log('managed-realtime-voice-native-contract-ok');
