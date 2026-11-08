import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const [repoRoot, runtimeRoot, fixtureRoot] = process.argv.slice(2);
process.env.OPENCLAW_HOME = fixtureRoot;
process.env.OPENCLAW_STATE_DIR = fixtureRoot;
process.env.OPENCLAW_CONFIG_PATH = path.join(fixtureRoot, 'openclaw.json');
const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const sdk = path.join(runtimeRoot, 'dist/plugin-sdk');
const source = path.join(repoRoot, 'plugins/extensions/openai');

// Test-only discovery checks the same native owners shipped in the immutable archive.
async function nativeOwner(prefix, symbol, declaration) {
  const directory = path.join(runtimeRoot, 'dist');
  const matches = [];
  for (const name of (await fs.readdir(directory)).filter(
    name => name.startsWith(prefix) && name.endsWith('.mjs'),
  )) {
    const content = await fs.readFile(path.join(directory, name), 'utf8');
    if (!content.includes(declaration)) continue;
    const tail = content.slice(content.lastIndexOf('\nexport {'));
    const exported = tail.match(new RegExp('\\b' + symbol + '(?: as ([\\w$]+))?\\s*[,}]'));
    if (exported) matches.push({ name, content, exportedName: exported[1] ?? symbol });
  }
  assert.equal(matches.length, 1, 'one actual native owner for ' + symbol);
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

const compiled = path.join(fixtureRoot, 'transcription-provider.mjs');
await build({
  entryPoints: [path.join(source, 'realtime-transcription-provider-factory.ts')],
  outfile: compiled,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  plugins: [
    {
      name: 'locked-public-sdk',
      setup(builder) {
        builder.onResolve({ filter: /^openclaw\/plugin-sdk\// }, args => ({
          path: pathToFileURL(path.join(sdk, `${args.path.split('/').at(-1)}.js`)).href,
          external: true,
        }));
      },
    },
  ],
});
const { buildOpenAIRealtimeTranscriptionProvider } = await import(pathToFileURL(compiled).href);
const manifest = JSON.parse(await fs.readFile(path.join(source, 'openclaw.plugin.json'), 'utf8'));
const validatePluginSchemaValue = await nativeOwner(
  'schema-validator-',
  'validatePluginSchemaValue',
  'function validatePluginSchemaValue(',
);
const schema = value =>
  validatePluginSchemaValue({
    origin: 'bundled',
    schema: manifest.configSchema,
    cacheKey: 'composer-transcription',
    value,
  });
const secretPath = path.join(fixtureRoot, 'credentials.json');
await fs.writeFile(secretPath, JSON.stringify({ key: 'isolated-input-key' }));
if (process.platform === 'win32') {
  const systemDirectory = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const options = { windowsHide: true, encoding: 'utf8', timeout: 5_000 };
  const identity = execFileSync(
    path.join(systemDirectory, 'whoami.exe'),
    ['/user', '/fo', 'csv', '/nh'],
    options,
  );
  const sid = identity.match(/S-1-\d+(?:-\d+)+/)?.[0];
  assert.ok(sid);
  execFileSync(
    path.join(systemDirectory, 'icacls.exe'),
    [secretPath, '/inheritance:r', '/grant:r', `*${sid}:F`, '*S-1-5-18:F', '*S-1-5-32-544:F'],
    options,
  );
} else {
  await fs.chmod(secretPath, 0o600);
}
const profile = {
  baseUrl: 'https://speech.internal/v1',
  model: 'selected-input-model',
  configurationId: 'composerAsr.fixture-version.apiKey',
  apiKey: { source: 'file', provider: 'input-credentials', id: '/key' },
};
assert.equal(schema({ transcription: profile }).ok, true);
assert.equal(schema({ transcription: null }).ok, true);
assert.equal(schema({ transcription: { ...profile, model: '' } }).ok, false);
assert.equal(schema({ transcription: { ...profile, model: 'x'.repeat(257) } }).ok, false);
assert.equal(schema({ transcription: { ...profile, baseUrl: 'x'.repeat(2049) } }).ok, false);
assert.equal(schema({ transcription: { ...profile, extra: true } }).ok, false);
assert.equal(schema({ transcription: { ...profile, compatibilityProfile: 'removed' } }).ok, false);
assert.equal(
  schema({ transcription: { ...profile, protocolId: 'chat-audio-transcription' } }).ok,
  false,
);
const cfg = {
  agents: { ownership: 'explicit', entries: { main: {} } },
  secrets: {
    providers: { 'input-credentials': { source: 'file', path: secretPath, mode: 'json' } },
  },
  plugins: {
    allow: ['openai'],
    entries: { openai: { enabled: true, config: { transcription: profile } } },
  },
};
const OpenClawSchema = await nativeOwner('zod-schema-', 'OpenClawSchema', 'const OpenClawSchema =');
assert.equal(OpenClawSchema.safeParse(cfg).success, true);
const redactConfigObject = await nativeOwner(
  'redact-snapshot-',
  'redactConfigObject',
  'function redactConfigObject(',
);
const publicConfig = redactConfigObject(cfg, {
  'plugins.entries.openai.config.transcription.apiKey': { sensitive: true },
});
assert.equal(
  publicConfig.plugins.entries.openai.config.transcription.apiKey.id,
  '__OPENCLAW_REDACTED__',
);
assert.equal(
  publicConfig.plugins.entries.openai.config.transcription.configurationId,
  profile.configurationId,
);
const prepareSecretsRuntimeSnapshot = await nativeOwner(
  'runtime-',
  'prepareSecretsRuntimeSnapshot',
  'async function prepareSecretsRuntimeSnapshot(',
);
const snapshot = await prepareSecretsRuntimeSnapshot({
  config: cfg,
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
  snapshot.config.plugins.entries.openai.config.transcription.apiKey,
  'isolated-input-key',
);
assert.equal(
  snapshot.config.plugins.entries.openai.config.transcription.configurationId,
  profile.configurationId,
);
assert.deepEqual(cfg.plugins.entries.openai.config.transcription.apiKey, profile.apiKey);
assert.equal(Object.hasOwn(snapshot.config.plugins.entries, 'voice-call'), false);

const requests = [];
const provider = buildOpenAIRealtimeTranscriptionProvider({
  createRealtimeTranscriptionWebSocketSession(request) {
    requests.push(request);
    return {};
  },
  resolveProviderRequestHeaders(request) {
    return request.defaultHeaders;
  },
});
const stale = { baseUrl: 'https://stale.internal/v1', model: 'stale-model', apiKey: 'stale-key' };
assert.throws(
  () =>
    provider.resolveConfig({
      cfg: {},
      rawConfig: { ...stale, unknownCredential: 'fixture' },
    }),
  /configuration|field/,
);
assert.throws(
  () =>
    provider.resolveConfig({
      cfg: {},
      rawConfig: { protocolId: 'openai-speech-http', openai: stale },
    }),
  /protocol/,
);
const resolved = provider.resolveConfig({ cfg: snapshot.config, rawConfig: stale });
assert.equal(resolved.baseUrl, profile.baseUrl);
assert.equal(resolved.model, profile.model);
assert.equal(resolved.apiKey, 'isolated-input-key');
assert.equal(provider.isConfigured({ cfg: snapshot.config, providerConfig: resolved }), true);
provider.createSession({ cfg: snapshot.config, providerConfig: resolved });
assert.equal(requests[0].url, 'wss://speech.internal/v1/realtime?intent=transcription');
assert.equal((await requests[0].headers()).Authorization, 'Bearer isolated-input-key');

for (const transcription of [
  null,
  {},
  { baseUrl: profile.baseUrl },
  { ...profile, model: ' ' },
  { ...profile, apiKey: '', compatibilityProfile: 'removed' },
  {
    ...profile,
    apiKey: '',
    protocolId: 'openai-transcription-realtime',
    compatibilityProfile: undefined,
  },
  { ...profile, apiKey: '', protocolId: 'chat-audio-transcription' },
]) {
  const withdrawn = { plugins: { entries: { openai: { config: { transcription } } } } };
  const disabled = provider.resolveConfig({ cfg: withdrawn, rawConfig: stale });
  assert.equal(provider.isConfigured({ cfg: withdrawn, providerConfig: disabled }), false);
  assert.equal(disabled.apiKey, undefined);
  assert.throws(
    () => provider.createSession({ providerConfig: disabled }),
    /service URL is required/,
  );
}
assert.equal(requests.length, 1, 'retired profiles must not construct a transport');
const keyless = provider.resolveConfig({
  cfg: {
    plugins: { entries: { openai: { config: { transcription: { ...profile, apiKey: '' } } } } },
  },
  rawConfig: stale,
});
assert.equal(keyless.apiKey, undefined);
assert.equal(provider.isConfigured({ providerConfig: keyless }), true);
assert.equal(provider.resolveConfig({ cfg: {}, rawConfig: stale }).apiKey, 'stale-key');
console.log('managed-transcription-native-contract-ok');
