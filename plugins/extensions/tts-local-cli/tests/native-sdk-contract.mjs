// Exercise the locked, prepared native SDK in an isolated process; no mocked TTS orchestration.
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const [repoRoot, runtimeRoot, fixtureRoot] = process.argv.slice(2);
const trace = label => {
  if (process.env.SPEECH_HTTP_WIRE_TRACE === '1')
    process.stderr.write(`[SpeechHttpProbe] ${label}\n`);
};
trace('fixture initialization');
process.env.OPENCLAW_HOME = fixtureRoot;
process.env.OPENCLAW_STATE_DIR = fixtureRoot;
process.env.OPENCLAW_CONFIG_PATH = path.join(fixtureRoot, 'openclaw.json');
const prefsPath = path.join(fixtureRoot, 'speech-tools', 'preferences.json');
process.env.OPENCLAW_TTS_PREFS = prefsPath;
const require = createRequire(import.meta.url);
const asar = require('@electron/asar');

// Test-only native-owner discovery proves schema and legacy admission against archived bytes.
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
const source = path.join(repoRoot, 'plugins/extensions/tts-local-cli');
const target = path.join(fixtureRoot, 'plugin');
const openaiTarget = path.join(fixtureRoot, 'openai');
const sdk = path.join(runtimeRoot, 'dist/plugin-sdk');
await fs.mkdir(target, { recursive: true });
await fs.mkdir(openaiTarget, { recursive: true });
const openaiEntry = path.join(fixtureRoot, 'openai-entry.ts');
await fs.writeFile(
  openaiEntry,
  `import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { buildOpenAISpeechProvider } from ${JSON.stringify(path.join(repoRoot, 'plugins/extensions/openai/speech-provider.ts'))};
export default definePluginEntry({id:'openai',name:'Speech protocol fixture',register(api){api.registerSpeechProvider(buildOpenAISpeechProvider());}});`,
);
await build({
  entryPoints: {
    index: path.join(source, 'index.ts'),
    'capability-catalog': path.join(source, 'capability-catalog.ts'),
    'reply-runtime': path.join(repoRoot, 'plugins/extensions/runtime-services/speech.ts'),
    'asr-request': path.join(repoRoot, 'plugins/extensions/stt-local-cli/online.ts'),
  },
  outdir: target,
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
const manifest = JSON.parse(await fs.readFile(path.join(source, 'openclaw.plugin.json'), 'utf8'));
manifest.capabilityCatalogEntry = './capability-catalog.js';
await fs.writeFile(path.join(target, 'openclaw.plugin.json'), JSON.stringify(manifest));
await fs.writeFile(
  path.join(target, 'package.json'),
  JSON.stringify({
    name: '@openclaw/tts-local-cli',
    version: '2026.10.7',
    type: 'module',
    openclaw: { extensions: ['./index.js'] },
  }),
);
await build({
  entryPoints: [openaiEntry],
  outfile: path.join(openaiTarget, 'index.js'),
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
await fs.writeFile(
  path.join(openaiTarget, 'package.json'),
  JSON.stringify({
    name: '@openclaw/openai-provider',
    version: '2026.10.7',
    type: 'module',
    openclaw: { extensions: ['./index.js'] },
  }),
);
await fs.writeFile(
  path.join(openaiTarget, 'openclaw.plugin.json'),
  JSON.stringify({
    id: 'openai',
    contracts: { speechProviders: ['openai'] },
    configSchema: { type: 'object', additionalProperties: false, properties: {} },
  }),
);

const requests = [];
const asrRequests = [];
const wireRequests = [];
const invalidRequests = [];
let wireReply;
let redirectAsr = false;
let fail = false;
// The host may assign port 0 from a low ephemeral range containing fetch-forbidden ports.
async function listenLoopback(server) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      await new Promise((resolve, reject) => {
        const listening = () => {
          server.off('error', failed);
          resolve();
        };
        const failed = error => {
          server.off('listening', listening);
          reject(error);
        };
        server.once('listening', listening);
        server.once('error', failed);
        server.listen(randomInt(49152, 65536), '127.0.0.1');
      });
      return;
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('Could not bind a safe loopback fixture port.');
}
const server = http.createServer(async (request, response) => {
  response.on('error', () => {});
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks);
  const body = rawBody.toString('utf8');
  if (
    request.method !== 'POST' ||
    !['/deployment/v1/audio/transcriptions', '/deployment/v1/audio/speech'].includes(request.url)
  ) {
    invalidRequests.push({ method: request.method, url: request.url });
    response.writeHead(404).end();
    return;
  }
  if (wireReply) {
    wireRequests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: rawBody,
    });
    wireReply(request, response);
    return;
  }
  if (request.url === '/deployment/v1/audio/transcriptions') {
    asrRequests.push({
      body,
      authorization: request.headers.authorization,
      contentType: request.headers['content-type'],
    });
    response.writeHead(
      redirectAsr ? 302 : 200,
      redirectAsr
        ? { location: '/deployment/v1/audio/speech' }
        : { 'content-type': 'application/json' },
    );
    response.end(redirectAsr ? '' : '{"text":"native transcript"}');
    return;
  }
  requests.push(JSON.parse(body));
  response.writeHead(fail ? 503 : 200, {
    'content-type': fail ? 'application/json' : 'audio/mpeg',
  });
  response.end(
    fail
      ? '{"error":{"message":"test service unavailable"}}'
      : Buffer.from([0xff, 0xfb, 0x90, 0, 1]),
  );
});
await listenLoopback(server);
const baseUrl = `http://127.0.0.1:${server.address().port}/deployment/v1`;
try {
  trace('import native SDK');
  const nativeTts = await import(pathToFileURL(path.join(sdk, 'tts-runtime.js')).href);
  const nativeSpeech = await import(pathToFileURL(path.join(sdk, 'speech-core.js')).href);
  const asr = await import(pathToFileURL(path.join(target, 'asr-request.js')).href);
  const workspace = path.join(fixtureRoot, 'workspace');
  const outside = path.join(fixtureRoot, 'outside');
  await fs.mkdir(workspace);
  await fs.mkdir(outside);
  const inputPath = path.join(workspace, 'input.wav');
  const outsidePath = path.join(outside, 'outside.wav');
  await fs.writeFile(inputPath, 'admitted audio');
  await fs.writeFile(outsidePath, 'outside audio');
  const snapshotPath = path.join(fixtureRoot, 'snapshot.wav');
  await asr.stageOnlineInput(inputPath, snapshotPath, workspace, new AbortController().signal);
  assert.equal(await fs.readFile(snapshotPath, 'utf8'), 'admitted audio');
  await fs.link(outsidePath, path.join(workspace, 'hardlink.wav'));
  await assert.rejects(
    asr.stageOnlineInput(
      path.join(workspace, 'hardlink.wav'),
      path.join(fixtureRoot, 'rejected-hardlink.wav'),
      workspace,
      new AbortController().signal,
    ),
  );
  await fs.symlink(outside, path.join(workspace, 'replaced-directory'), 'junction');
  await assert.rejects(
    asr.stageOnlineInput(
      path.join(workspace, 'replaced-directory/outside.wav'),
      path.join(fixtureRoot, 'rejected-link.wav'),
      workspace,
      new AbortController().signal,
    ),
  );
  await assert.rejects(
    asr.stageOnlineInput(
      outsidePath,
      path.join(fixtureRoot, 'rejected-outside.wav'),
      workspace,
      new AbortController().signal,
    ),
  );
  const asrConfig = asr.readOnlineConfig({
    mode: 'online',
    baseUrl,
    model: 'asr-selected',
    language: 'zh',
  });
  const asrInput = {
    config: asrConfig,
    buffer: Buffer.from('audio'),
    signal: new AbortController().signal,
  };
  trace('existing ASR contract');
  assert.equal(await asr.requestOnlineTranscription(asrInput), 'native transcript');
  assert.equal(asrRequests.length, 1);
  assert.equal(asrRequests[0].authorization, undefined);
  assert.ok(asrRequests[0].contentType.startsWith('multipart/form-data; boundary='));
  assert.match(asrRequests[0].body, /name="model"\r\n\r\nasr-selected/);
  assert.match(asrRequests[0].body, /name="language"\r\n\r\nzh/);
  redirectAsr = true;
  await assert.rejects(asr.requestOnlineTranscription(asrInput));
  assert.equal(asrRequests.length, 2);
  assert.equal(requests.length, 0);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(asr.requestOnlineTranscription({ ...asrInput, signal: cancelled.signal }));
  let admissionChecks = 0;
  await assert.rejects(
    asr.requestOnlineTranscription({
      ...asrInput,
      assertCurrent() {
        if (++admissionChecks === 2) throw new Error('revoked before upload');
      },
    }),
    /revoked before upload/,
  );
  assert.equal(admissionChecks, 2);
  assert.equal(asrRequests.length, 2);
  const cfg = {
    agents: { ownership: 'explicit', entries: { main: {} } },
    plugins: {
      allow: ['tts-local-cli', 'openai'],
      load: { paths: [openaiTarget, target] },
      entries: { 'tts-local-cli': { enabled: true }, openai: { enabled: true } },
    },
    tts: {
      provider: 'tts-local-cli',
      persona: 'assistant-speech',
      personas: {
        'assistant-speech': {
          provider: 'tts-local-cli',
          fallbackPolicy: 'fail',
          providers: { 'tts-local-cli': {} },
        },
      },
      providers: {
        'tts-local-cli': {
          mode: 'online',
          baseUrl,
          model: 'selected-model',
          speakerVoice: 'selected-voice',
          apiKey: '',
        },
        openai: {
          baseUrl,
          model: 'forbidden-fallback',
          speakerVoice: 'fallback-voice',
          apiKey: 'test-key',
        },
      },
    },
  };
  const nativeSchema = await nativeOwner('zod-schema-', 'OpenClawSchema', 'const OpenClawSchema =');
  const nativeLegacy = await nativeOwner(
    'legacy-',
    'findLegacyConfigIssues',
    'function findLegacyConfigIssues(',
  );
  assert.equal(nativeTts.TtsConfigSchema.safeParse(cfg.tts).success, true);
  const parsedConfig = nativeSchema.safeParse(cfg);
  assert.equal(
    parsedConfig.success,
    true,
    parsedConfig.success ? '' : JSON.stringify(parsedConfig.error.issues),
  );
  assert.deepEqual(nativeLegacy(cfg), []);
  const obsolete = { ...cfg, tts: { ...cfg.tts, prefsPath } };
  assert.equal(nativeTts.TtsConfigSchema.safeParse(obsolete.tts).success, false);
  assert.equal(nativeSchema.safeParse(obsolete).success, false);
  assert.equal(nativeSchema.safeParse({ ...cfg, messages: { tts: cfg.tts } }).success, false);
  const resolved = nativeTts.resolveTtsConfig(cfg);
  assert.equal(nativeTts.resolveTtsPrefsPath(resolved), prefsPath);
  assert.equal(nativeTts.getTtsPersona(resolved, prefsPath)?.id, 'assistant-speech');
  assert.equal(nativeSpeech.getSpeechProvider('tts-local-cli', cfg)?.label, 'Configured speech');
  const success = await nativeTts.synthesizeSpeech({
    text: 'speech contract',
    cfg,
    timeoutMs: 2000,
  });
  trace('existing speech contract');
  assert.equal(success.success, true, JSON.stringify(success));
  assert.equal(success.provider, 'tts-local-cli');
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    model: 'selected-model',
    voice: 'selected-voice',
    input: 'speech contract',
    response_format: 'mp3',
  });
  const localConfig = structuredClone(cfg);
  const wav = Buffer.alloc(44);
  wav.write('RIFF');
  wav.write('WAVE', 8);
  localConfig.tts.providers['tts-local-cli'] = {
    command: `"${process.execPath}"`,
    outputFormat: 'wav',
    args: ['-e', `process.stdout.write(Buffer.from('${wav.toString('base64')}', 'base64'))`],
  };
  const localResult = await nativeTts.synthesizeSpeech({
    text: 'local speech contract',
    cfg: localConfig,
    timeoutMs: 2000,
  });
  assert.equal(localResult.success, true, JSON.stringify(localResult));
  assert.equal(localResult.provider, 'tts-local-cli');
  assert.equal(requests.length, 1);

  fail = true;
  const failed = await nativeTts.synthesizeSpeech({ text: 'failed speech', cfg, timeoutMs: 2000 });
  assert.equal(failed.success, false);
  assert.equal(requests.length, 2);
  assert.ok(
    failed.attempts.some(
      attempt =>
        attempt.provider === 'openai' &&
        attempt.outcome === 'skipped' &&
        attempt.personaBinding === 'missing',
    ),
  );

  const disabled = structuredClone(cfg);
  disabled.plugins.entries['tts-local-cli'].enabled = false;
  assert.equal(nativeSpeech.getSpeechProvider('tts-local-cli', disabled), undefined);
  const unavailable = await nativeTts.synthesizeSpeech({
    text: 'disabled speech',
    cfg: disabled,
    timeoutMs: 2000,
  });
  assert.equal(unavailable.success, false);
  assert.equal(requests.length, 2);
  assert.ok(!requests.some(request => request.model === 'forbidden-fallback'));
  fail = false;
  const reply = await import(pathToFileURL(path.join(target, 'reply-runtime.js')).href);
  const replyConfigurationId = 'a'.repeat(64);
  const nextReplyConfigurationId = 'b'.repeat(64);
  const replyConfig = structuredClone(disabled);
  replyConfig.plugins.entries['runtime-services'] = {
    enabled: true,
    config: {
      replySpeech: {
        configurationId: replyConfigurationId,
        baseUrl,
        model: 'reply-selected-model',
        speakerVoice: 'reply-selected-voice',
        apiKey: '',
      },
    },
  };
  const redactConfigObject = await nativeOwner(
    'redact-snapshot-',
    'redactConfigObject',
    'function redactConfigObject(',
  );
  const secretReference = { source: 'file', provider: 'reply-credentials', id: '/key' };
  const publicReplyConfig = redactConfigObject(
    {
      ...replyConfig,
      plugins: {
        ...replyConfig.plugins,
        entries: {
          ...replyConfig.plugins.entries,
          'runtime-services': {
            ...replyConfig.plugins.entries['runtime-services'],
            config: {
              replySpeech: {
                ...replyConfig.plugins.entries['runtime-services'].config.replySpeech,
                apiKey: secretReference,
              },
            },
          },
        },
      },
    },
    { 'plugins.entries.runtime-services.config.replySpeech.apiKey': { sensitive: true } },
  );
  assert.equal(
    publicReplyConfig.plugins.entries['runtime-services'].config.replySpeech.apiKey.id,
    '__OPENCLAW_REDACTED__',
  );
  assert.equal(
    publicReplyConfig.plugins.entries['runtime-services'].config.replySpeech.configurationId,
    replyConfigurationId,
  );
  let handler;
  reply.registerSpeechSynthesis({
    registerGatewayMethod(_method, callback) {
      handler = callback;
    },
    runtime: {
      config: { current: () => replyConfig },
      state: { resolveStateDir: () => fixtureRoot },
    },
  });
  let result;
  const invokeReply = async (
    configurationId = replyConfig.plugins.entries['runtime-services'].config.replySpeech
      .configurationId,
  ) => {
    result = undefined;
    await handler({
      params: { text: 'reply reading', configurationId },
      respond: (...args) => {
        result = args;
      },
      hasCurrentClientAuthority: () => true,
      signal: new AbortController().signal,
    });
    return result;
  };
  const replyResult = await invokeReply();
  assert.equal(replyResult[0], true, JSON.stringify(replyResult));
  assert.equal(replyResult[1].provider, 'openai');
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[2], {
    model: 'reply-selected-model',
    voice: 'reply-selected-voice',
    input: 'reply reading',
    response_format: 'wav',
  });
  assert.equal((await invokeReply(nextReplyConfigurationId))[0], false);
  assert.equal(requests.length, 3);
  // Enable the CLI provider again so a mistaken preference/fallback would produce an observable request.
  replyConfig.plugins.entries['tts-local-cli'].enabled = true;
  replyConfig.plugins.entries.openai.enabled = false;
  assert.equal((await invokeReply())[0], false);
  assert.equal(requests.length, 3);
  delete replyConfig.plugins.entries.openai;
  replyConfig.plugins.allow = ['tts-local-cli'];
  assert.equal((await invokeReply())[0], false);
  assert.equal(requests.length, 3);

  {
    trace('strict loopback wire contracts');
    // Expectations are independent of the production protocol codec.
    const wav = Buffer.alloc(52);
    wav.write('RIFF');
    wav.writeUInt32LE(44, 4);
    wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24);
    wav.writeUInt32LE(32000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(8, 40);
    wav.writeInt16LE(1000, 44);
    wav.writeInt16LE(-1000, 46);
    const opaqueMp3 = Buffer.from([0xff, 0xfb, 0x90, 0, 1]);
    const fixtureKey = 'wire-fixture-key';
    const jsonReply = body => (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    const arm = reply => {
      wireReply = reply;
      const before = wireRequests.length;
      return () => {
        assert.equal(wireRequests.length, before + 1, 'one real HTTP request, with no retries');
        return wireRequests[before];
      };
    };
    const assertWire = (seen, pathname, auth = 'Bearer ' + fixtureKey) => {
      assert.equal(seen.method, 'POST');
      assert.equal(seen.url, pathname);
      assert.equal(seen.headers.host, '127.0.0.1:' + server.address().port);
      assert.equal(seen.headers.authorization, auth === null ? undefined : auth);
    };
    const latch = () => {
      let resolve;
      const promise = new Promise(done => {
        resolve = done;
      });
      return { promise, resolve };
    };
    const boundedWait = async (promise, label) => {
      let timer;
      try {
        return await Promise.race([
          promise,
          new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Timed out waiting for ' + label)), 5000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    const asrWireConfig = asr.readOnlineConfig({
      mode: 'online',
      baseUrl,
      model: 'wire/asr-model',
      language: 'en',
      apiKey: fixtureKey,
      protocolId: 'openai-transcription-http',
    });
    const sendAsr = (signal = new AbortController().signal) =>
      asr.requestOnlineTranscription({ config: asrWireConfig, buffer: wav, signal });

    let received = arm(jsonReply({ text: 'wire transcript' }));
    assert.equal(await sendAsr(), 'wire transcript');
    const seen = received();
    assertWire(seen, '/deployment/v1/audio/transcriptions');
    assert.match(seen.headers['content-type'], /^multipart\/form-data; boundary=/);
    const form = await new Request(baseUrl, {
      method: 'POST',
      headers: { 'content-type': seen.headers['content-type'] },
      body: seen.body,
    }).formData();
    assert.deepEqual([...form.keys()].sort(), ['file', 'language', 'model']);
    assert.equal(form.get('model'), 'wire/asr-model');
    assert.equal(form.get('language'), 'en');
    const file = form.get('file');
    assert.equal(file.name, 'audio.wav');
    assert.equal(file.type, 'audio/wav');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), wav);

    const wireCfg = structuredClone(cfg);
    const openaiProvider = nativeSpeech.getSpeechProvider('openai', wireCfg);
    const toolProvider = nativeSpeech.getSpeechProvider('tts-local-cli', wireCfg);
    assert.equal(openaiProvider?.id, 'openai');
    assert.equal(toolProvider?.id, 'tts-local-cli');
    const speechRequest = (tool = false, timeoutMs = 2000) => ({
      cfg: wireCfg,
      text: 'wire speech text',
      target: 'audio-file',
      timeoutMs,
      providerConfig: {
        ...(tool ? { mode: 'online' } : {}),
        baseUrl,
        model: 'wire/speech-model',
        apiKey: fixtureKey,
        protocolId: 'openai-speech-http',
        voicePolicy: 'preset',
        voiceSelection: { kind: 'preset', voiceId: 'wire-voice' },
        ...(!tool ? { responseFormat: 'wav' } : {}),
      },
    });
    for (const tool of [false, true]) {
      const audio = tool ? opaqueMp3 : wav;
      const format = tool ? 'mp3' : 'wav';
      received = arm((_request, response) => {
        response.writeHead(200, { 'content-type': tool ? 'audio/mpeg' : 'audio/wav' });
        response.end(audio);
      });
      const provider = tool ? toolProvider : openaiProvider;
      const request = speechRequest(tool);
      if (!tool) request.providerConfig.apiKey = '';
      assert.equal(
        await provider.isConfigured({
          cfg: wireCfg,
          providerConfig: request.providerConfig,
          timeoutMs: 2000,
        }),
        true,
      );
      const result = await provider.synthesize(request);
      assert.deepEqual(result.audioBuffer, audio);
      assert.equal(result.outputFormat, format);
      assert.equal(result.fileExtension, '.' + format);
      const sent = received();
      assertWire(sent, '/deployment/v1/audio/speech', tool ? 'Bearer ' + fixtureKey : null);
      assert.equal(sent.headers['content-type'], 'application/json');
      assert.deepEqual(JSON.parse(sent.body), {
        model: 'wire/speech-model',
        input: 'wire speech text',
        voice: 'wire-voice',
        response_format: format,
      });
    }

    replyConfig.plugins.allow = ['tts-local-cli', 'openai'];
    replyConfig.plugins.entries.openai = { enabled: true };
    received = arm((_request, response) => {
      response.writeHead(200, { 'content-type': 'audio/wav' });
      response.end(wav);
    });
    assert.equal(
      (await invokeReply())[0],
      true,
      'reply reader is admitted before retired-field checks',
    );
    assertWire(received(), '/deployment/v1/audio/speech', null);

    trace('retired fields fail before dispatch');
    const beforeRetired = wireRequests.length;
    const wrapped = speechRequest();
    wrapped.providerConfig = {
      protocolId: 'chat-audio-speech',
      providers: { openai: wrapped.providerConfig },
    };
    assert.throws(() =>
      openaiProvider.resolveConfig({ cfg: wireCfg, rawConfig: wrapped.providerConfig }),
    );
    const missingModel = speechRequest();
    delete missingModel.providerConfig.model;
    delete missingModel.providerConfig.protocolId;
    missingModel.providerConfig = {
      protocolId: 'openai-speech-http',
      openai: missingModel.providerConfig,
    };
    await assert.rejects(async () => {
      const selected = openaiProvider.resolveConfig({
        cfg: wireCfg,
        rawConfig: missingModel.providerConfig,
      });
      await openaiProvider.synthesize({ ...missingModel, providerConfig: selected });
    });
    const innerManaged = { ...speechRequest().providerConfig };
    delete innerManaged.model;
    await assert.rejects(async () => {
      const selected = openaiProvider.resolveConfig({
        cfg: wireCfg,
        rawConfig: { protocolId: undefined, openai: innerManaged },
      });
      await openaiProvider.synthesize({ ...missingModel, providerConfig: selected });
    });
    for (const fields of [
      { model: undefined },
      { model: '\ncustom-model' },
      { baseUrl: undefined },
      { voiceSelection: undefined },
      { apiKey: { source: 'file' } },
    ]) {
      const request = speechRequest();
      delete request.providerConfig.protocolId;
      Object.assign(request.providerConfig, fields);
      await assert.rejects(openaiProvider.synthesize(request));
    }
    for (const fields of [
      { model: undefined },
      { model: '\ncustom-model' },
      { baseUrl: undefined },
      { apiKey: { source: 'file' } },
    ]) {
      await assert.rejects(
        asr.requestOnlineTranscription({
          config: { ...asrWireConfig, ...fields },
          buffer: wav,
          signal: new AbortController().signal,
        }),
      );
    }
    const retired = [
      { protocolId: 'chat-audio-speech' },
      { protocolId: undefined, compatibilityProfile: 'removed' },
      { compatibilityProfile: undefined },
      { voiceSelection: { kind: 'service-default' } },
    ];
    for (const fields of retired) {
      for (const tool of [false, true]) {
        const request = speechRequest(tool);
        Object.assign(request.providerConfig, fields);
        await assert.rejects((tool ? toolProvider : openaiProvider).synthesize(request));
      }
      const original = replyConfig.plugins.entries['runtime-services'].config.replySpeech;
      replyConfig.plugins.entries['runtime-services'].config.replySpeech = {
        ...original,
        ...fields,
      };
      assert.equal((await invokeReply())[0], false);
      replyConfig.plugins.entries['runtime-services'].config.replySpeech = original;
    }
    for (const fields of [
      { protocolId: 'chat-audio-transcription' },
      { protocolId: undefined, compatibilityProfile: 'removed' },
      { compatibilityProfile: undefined },
    ]) {
      const raw = { ...asrWireConfig, ...fields };
      assert.throws(() => asr.readOnlineConfig(raw));
      await assert.rejects(
        asr.requestOnlineTranscription({
          config: raw,
          buffer: wav,
          signal: new AbortController().signal,
        }),
      );
    }
    assert.equal(wireRequests.length, beforeRetired);
    assert.equal(requests.length, 3);
    assert.equal(asrRequests.length, 2);

    received = arm(jsonReply({ choices: [{ message: { content: 'wrong response contract' } }] }));
    await assert.rejects(sendAsr(), /transcription result/);
    received();
    received = arm((_request, response) =>
      response.writeHead(200, { 'content-type': 'audio/wav' }).end(),
    );
    await assert.rejects(openaiProvider.synthesize(speechRequest()), /audio|empty/i);
    received();
    for (const synthesis of [false, true]) {
      received = arm((_request, response) => {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: fixtureKey + ': private service body' } }));
      });
      await assert.rejects(
        synthesis ? openaiProvider.synthesize(speechRequest()) : sendAsr(),
        error =>
          /HTTP 401/.test(error.message) &&
          !error.message.includes(fixtureKey) &&
          !error.message.includes('private service body'),
      );
      received();
    }
    received = arm((_request, response) => {
      response.writeHead(200, {
        'content-type': 'application/json',
        'transfer-encoding': 'chunked',
      });
      response.write('{"text":"');
      response.end('x'.repeat(2 * 1024 * 1024) + '"}');
    });
    await assert.rejects(sendAsr(), /large|limit|size|exceed/i);
    received();

    const uploaded = latch(),
      closed = latch();
    received = arm((_request, response) => {
      response.once('close', closed.resolve);
      uploaded.resolve();
    });
    const abort = new AbortController();
    const result = assert.rejects(sendAsr(abort.signal));
    await boundedWait(uploaded.promise, 'complete ASR upload');
    abort.abort();
    await result;
    await boundedWait(closed.promise, 'ASR socket closure after abort');
    assertWire(received(), '/deployment/v1/audio/transcriptions');

    const ttsUploaded = latch(),
      ttsClosed = latch();
    received = arm((_request, response) => {
      response.once('close', ttsClosed.resolve);
      ttsUploaded.resolve();
    });
    const timedOut = assert.rejects(
      openaiProvider.synthesize(speechRequest(false, 500)),
      /abort|timeout|timed out/i,
    );
    await boundedWait(ttsUploaded.promise, 'TTS upload before timeout');
    await timedOut;
    await boundedWait(ttsClosed.promise, 'TTS timeout socket closure');
    received();

    const redirectArrivals = [];
    const trap = http.createServer(async (request, response) => {
      const arrival = { authorization: request.headers.authorization, bytes: 0 };
      redirectArrivals.push(arrival);
      try {
        for await (const chunk of request) arrival.bytes += chunk.length;
      } catch {
        /* Partial upload is still an arrival. */
      }
      if (!response.destroyed) response.writeHead(200).end('{}');
    });
    await listenLoopback(trap);
    try {
      for (const synthesis of [false, true]) {
        received = arm((_request, response) =>
          response
            .writeHead(307, {
              location: 'http://127.0.0.1:' + trap.address().port + '/credential-audio-trap',
            })
            .end(),
        );
        await assert.rejects(synthesis ? openaiProvider.synthesize(speechRequest()) : sendAsr());
        received();
        assert.equal(
          redirectArrivals.length,
          0,
          'no credentials or request data reaches a redirected origin',
        );
      }
    } finally {
      trap.closeAllConnections();
      await new Promise(resolve => trap.close(resolve));
    }
    assert.deepEqual(invalidRequests, []);
    assert.equal(wireRequests.length, 13);
    wireReply = undefined;
  }
  process.stdout.write(
    JSON.stringify({
      nativeVersion: JSON.parse(await fs.readFile(path.join(runtimeRoot, 'package.json'), 'utf8'))
        .version,
      fullConfigSchemaAndLegacyAdmission: true,
      rejectsRetiredPreferencesConfig: true,
      toolPreferencesFromEnvironment: true,
      registered: true,
      nativeAsrHttpAndAdmission: true,
      nativeAsrSnapshot: true,
      localCliPreserved: true,
      isolatedPreferences: true,
      onlineSuccess: true,
      failureHasNoFallback: true,
      disabledHasNoFallback: true,
      replyOwnModelAndVoice: true,
      replyIndependentOfCliEnable: true,
      replyMissingOpenAiHasNoFallback: true,
      replyConfigurationAdmission: true,
      replyConfigurationIdSurvivesRedaction: true,
      loopbackHttpWire: {
        protocols: {
          'openai-transcription-http': true,
          'openai-speech-http': true,
        },
        realHttpRequests: 13,
        environmentCredentialNotUsed: true,
        strictMethodsPathsHeadersAndAudio: true,
        actualSpeechProviderAndToolDelegation: true,
        retiredFieldsHaveZeroDispatch: true,
        errorsAndOversizedStream: true,
        uploadedAsrAbortClosesSocket: true,
        ttsTimeoutClosesSocket: true,
        redirectOriginReceivesNothing: true,
      },
    }),
  );
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
