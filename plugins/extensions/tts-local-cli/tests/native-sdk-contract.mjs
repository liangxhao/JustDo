// Exercise the locked, prepared native SDK in an isolated process; no mocked TTS orchestration.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const [repoRoot, runtimeRoot, fixtureRoot] = process.argv.slice(2);
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
const sdk = path.join(runtimeRoot, 'dist/plugin-sdk');
await fs.mkdir(target, { recursive: true });
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

const requests = [];
const asrRequests = [];
let redirectAsr = false;
let fail = false;
const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');
  if (request.url.endsWith('/audio/transcriptions')) {
    asrRequests.push({
      body,
      authorization: request.headers.authorization,
      contentType: request.headers['content-type'],
    });
    response.writeHead(
      redirectAsr ? 302 : 200,
      redirectAsr ? { location: '/v1/audio/speech' } : { 'content-type': 'application/json' },
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
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
try {
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
      load: { paths: [target] },
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
  const replyConfig = structuredClone(disabled);
  replyConfig.plugins.entries['runtime-services'] = {
    enabled: true,
    config: {
      replySpeech: {
        baseUrl,
        model: 'reply-selected-model',
        speakerVoice: 'reply-selected-voice',
        apiKey: '',
      },
    },
  };
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
  const invokeReply = async () => {
    result = undefined;
    await handler({
      params: { text: 'reply reading' },
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

  // Enable the CLI provider again so a mistaken preference/fallback would produce an observable request.
  replyConfig.plugins.entries['tts-local-cli'].enabled = true;
  replyConfig.plugins.entries.openai.enabled = false;
  assert.equal((await invokeReply())[0], false);
  assert.equal(requests.length, 3);
  delete replyConfig.plugins.entries.openai;
  replyConfig.plugins.allow = ['tts-local-cli'];
  assert.equal((await invokeReply())[0], false);
  assert.equal(requests.length, 3);
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
    }),
  );
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
