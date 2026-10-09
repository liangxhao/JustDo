// Verify the new plugin with the packaged OpenClaw SDK and a local HTTP fixture.
// No language/video model or external service is invoked.
const assert = require('node:assert/strict');
const { execFileSync, fork } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function nativeExport(runtime, prefix, symbol) {
  const dist = path.join(runtime, 'dist');
  for (const name of fs
    .readdirSync(dist)
    .filter(name => name.startsWith(prefix) && name.endsWith('.mjs'))) {
    const source = fs.readFileSync(path.join(dist, name), 'utf8');
    const declarations = [...source.matchAll(/export\s*\{([^}]+)\}/g)];
    for (const declaration of declarations) {
      const exported = declaration[1].match(
        new RegExp('\\b' + symbol + '(?: as (\\w+))?\\s*(?:,|$)'),
      );
      if (!exported) continue;
      const module = await import(pathToFileURL(path.join(dist, name)).href);
      if (typeof module[exported[1] || symbol] === 'function') return module[exported[1] || symbol];
    }
  }
  throw new Error('Missing packaged runtime export: ' + symbol);
}

function restrictTemporaryCredentialFile(filePath) {
  if (process.platform !== 'win32') {
    fs.chmodSync(filePath, 0o600);
    return;
  }
  const systemDirectory = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const options = { windowsHide: true, timeout: 5000, encoding: 'utf8' };
  const sid = execFileSync(
    path.join(systemDirectory, 'whoami.exe'),
    ['/user', '/fo', 'csv', '/nh'],
    options,
  ).match(/S-1-\d+(?:-\d+)+/)?.[0];
  assert.ok(sid, 'The temporary credential owner must be identifiable');
  execFileSync(
    path.join(systemDirectory, 'icacls.exe'),
    [filePath, '/inheritance:r', '/grant:r', '*' + sid + ':F', '*S-1-5-18:F', '*S-1-5-32-544:F'],
    options,
  );
}

async function runNativeToolWorker({ runtime, root, cfg, providerId, expectedVideoHex }) {
  const prepareSecrets = await nativeExport(runtime, 'runtime-', 'prepareSecretsRuntimeSnapshot');
  const activateSecrets = await nativeExport(runtime, 'runtime-', 'activateSecretsRuntimeSnapshot');
  const snapshot = await prepareSecrets({
    config: cfg,
    includeAuthStoreRefs: false,
    env: process.env,
    agentDirs: [root],
  });
  assert.equal(typeof snapshot.sourceConfig.models.providers[providerId].apiKey, 'object');
  assert.equal(typeof snapshot.config.models.providers[providerId].apiKey, 'string');
  activateSecrets(snapshot);
  const configSdk = await import(
    pathToFileURL(path.join(runtime, 'dist/plugin-sdk/config-runtime.js')).href
  );
  const activeCfg = configSdk.getRuntimeConfig();
  assert.equal(
    activeCfg.models.providers[providerId].apiKey,
    snapshot.config.models.providers[providerId].apiKey,
  );
  const createTools = await nativeExport(runtime, 'openclaw-tools-', 'createOpenClawTools');
  const tools = createTools({ config: activeCfg, workspaceDir: root, agentDir: root });
  const tool = tools.find(tool => tool.name === 'video_generate');
  assert.ok(tool, 'Configured video provider must expose the native video_generate tool');
  const result = await tool.execute(
    'native-video-smoke',
    {
      prompt: 'Native tool file-secret test',
      timeoutMs: 15_000,
    },
    new AbortController().signal,
  );
  assert.equal(result.details?.provider, providerId);
  assert.equal(result.details?.model, 'Wan-AI/internal-video');
  assert.equal(result.details?.attachments?.[0]?.type, 'video');
  assert.equal(result.details?.attachments?.[0]?.mimeType, 'video/mp4');
  assert.equal(result.details?.paths?.length, 1);
  const savedPath = path.resolve(result.details.paths[0]);
  const relative = path.relative(root, savedPath);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  assert.equal(result.details.attachments[0].path, savedPath);
  assert.equal(fs.readFileSync(savedPath).toString('hex'), expectedVideoHex);
  return {
    ok: true,
    fileSecretResolved: true,
    nativeToolExposed: true,
    nativeVideoAttachment: true,
  };
}

function invokeNativeToolWorker(payload) {
  // Native tool setup opens SQLite handles. Exit the isolated worker before the
  // parent removes the temporary state directory, especially on Windows.
  return new Promise((resolve, reject) => {
    const child = fork(__filename, ['--native-tool-worker'], {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: payload.root,
        OPENCLAW_CONFIG_PATH: path.join(payload.root, 'openclaw.json'),
      },
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let result;
    let output = '';
    child.stderr.on('data', chunk => {
      output = (output + chunk.toString()).slice(-4096);
    });
    const timer = setTimeout(() => child.kill(), 30_000);
    child.once('message', message => {
      result = message;
    });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0 && result?.ok === true) resolve(result);
      else
        reject(
          new Error(result?.error || output || 'Native video tool worker exited with code ' + code),
        );
    });
    child.send(payload);
  });
}

async function runSmoke() {
  const repo = path.resolve(__dirname, '../../..');
  const runtime = path.resolve(
    process.argv[2] || path.join(repo, 'vendor/openclaw-runtime/current'),
  );
  const temporaryParent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporaryParent, 'intranet-video-smoke-'));
  const providerId = 'video-openai';
  const pluginDir = path.join(root, providerId);
  fs.mkdirSync(pluginDir);
  fs.copyFileSync(
    path.join(repo, 'openclaw-extensions', providerId, 'openclaw.plugin.json'),
    path.join(pluginDir, 'openclaw.plugin.json'),
  );
  fs.writeFileSync(
    path.join(pluginDir, 'package.json'),
    JSON.stringify({
      name: 'openclaw-video-openai',
      version: '1.0.0',
      type: 'module',
      openclaw: { extensions: ['./index.mjs'] },
    }),
  );
  await require('esbuild').build({
    entryPoints: [path.join(repo, 'openclaw-extensions', providerId, 'index.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'es2023',
    outfile: path.join(pluginDir, 'index.mjs'),
    plugins: [
      {
        name: 'packaged-sdk',
        setup(build) {
          build.onResolve({ filter: /^openclaw\/plugin-sdk\// }, args => ({
            path: pathToFileURL(
              path.join(runtime, 'dist/plugin-sdk', args.path.split('/').at(-1) + '.js'),
            ).href,
            external: true,
          }));
        },
      },
    ],
  });
  const requests = [];
  let pollCount = 0;
  let redirectSubmission = false;
  let responseFixture;
  const videoCredential = 'local-video-test';
  const video = Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex');
  const trap = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    requests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      contentType: req.headers['content-type'],
      body,
    });
    if (responseFixture && req.url === responseFixture.url) {
      res.writeHead(responseFixture.status, {
        'content-type': 'application/json',
        'x-request-id': 'request-' + videoCredential,
      });
      res.end(responseFixture.body);
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/videos') {
      if (redirectSubmission) {
        res.writeHead(307, { location: '/unexpected-redirect' }).end();
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'video-smoke', status: 'queued' }));
    } else if (req.url === '/v1/videos/video-smoke') {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'video-smoke',
          status: ++pollCount === 1 ? 'in_progress' : 'completed',
        }),
      );
    } else if (req.url === '/v1/videos/video-smoke/content') {
      res.setHeader('content-type', 'video/mp4');
      res.end(video);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise(resolve => trap.listen(0, '127.0.0.1', resolve));
  try {
    const cfg = {
      agents: {
        defaults: {
          workspace: root,
          mediaModels: {
            video: { primary: providerId + '/Wan-AI/internal-video' },
          },
        },
      },
      models: {
        providers: {
          [providerId]: {
            api: 'openai-completions',
            models: [],
            baseUrl: 'http://127.0.0.1:' + trap.address().port + '/v1',
            apiKey: videoCredential,
            request: { allowPrivateNetwork: true },
          },
          openai: {
            api: 'openai-completions',
            models: [],
            baseUrl: 'http://chat.invalid/v1',
            apiKey: 'unused-chat-key',
          },
        },
      },
      plugins: {
        allow: [providerId],
        entries: { [providerId]: { enabled: true } },
        load: { paths: [pluginDir] },
      },
    };
    const sdk = await import(
      pathToFileURL(path.join(runtime, 'dist/plugin-sdk/video-generation-runtime.js')).href
    );
    const result = await sdk.generateVideo({
      cfg,
      prompt: 'Synthetic local test',
      durationSeconds: 5,
      size: '1280x720',
      timeoutMs: 15_000,
      autoProviderFallback: false,
      inputImages: [
        {
          buffer: Buffer.from('reference'),
          mimeType: 'image/png',
          role: 'first_frame',
        },
      ],
      providerOptions: { seed: 42, fps: 16 },
    });
    assert.equal(result.provider, providerId);
    assert.equal(result.videos[0].mimeType, 'video/mp4');
    assert.deepEqual(result.videos[0].buffer, video);
    assert.equal(requests.length, 4);
    assert.match(requests[0].contentType, /^multipart\/form-data; boundary=/);
    assert.match(requests[0].body, /Wan-AI\/internal-video/);
    assert.match(requests[0].body, /name="input_reference"/);
    assert.ok(requests.every(req => req.authorization === 'Bearer ' + videoCredential));
    assert.ok(requests.every(req => req.url.startsWith('/v1/videos')));
    const unauthenticated = structuredClone(cfg);
    delete unauthenticated.models.providers[providerId].apiKey;
    const authenticatedCount = requests.length;
    await sdk.generateVideo({
      cfg: unauthenticated,
      prompt: 'No-auth local test',
      timeoutMs: 15_000,
      autoProviderFallback: false,
    });
    assert.ok(requests.slice(authenticatedCount).every(req => req.authorization === undefined));

    const secretCfg = structuredClone(cfg);
    const secretsPath = path.join(root, 'extension-secrets.json');
    fs.writeFileSync(secretsPath, '', { mode: 0o600, flag: 'wx' });
    restrictTemporaryCredentialFile(secretsPath);
    fs.writeFileSync(secretsPath, JSON.stringify({ videoKey: videoCredential }), 'utf8');
    secretCfg.models.providers[providerId].apiKey = {
      source: 'file',
      provider: 'justdo-extension-secrets',
      id: '/videoKey',
    };
    secretCfg.secrets = {
      providers: {
        'justdo-extension-secrets': { source: 'file', path: secretsPath, mode: 'json' },
      },
    };
    const beforeNativeTool = requests.length;
    pollCount = 0;
    const nativeToolResult = await invokeNativeToolWorker({
      runtime,
      root,
      cfg: secretCfg,
      providerId,
      expectedVideoHex: video.toString('hex'),
    });
    assert.equal(requests.length, beforeNativeTool + 4);
    assert.ok(
      requests
        .slice(beforeNativeTool)
        .every(req => req.authorization === 'Bearer ' + videoCredential),
    );

    redirectSubmission = true;
    const beforeRedirect = requests.length;
    await assert.rejects(
      sdk.generateVideo({
        cfg,
        prompt: 'Redirect local test',
        timeoutMs: 15_000,
        autoProviderFallback: false,
      }),
      /redirect/i,
    );
    assert.equal(requests.length, beforeRedirect + 1);
    assert.ok(requests.every(req => req.url !== '/unexpected-redirect'));
    redirectSubmission = false;

    for (const [stage, url, expectedRequests] of [
      ['submission', '/v1/videos', 1],
      ['status', '/v1/videos/video-smoke', 2],
      ['download', '/v1/videos/video-smoke/content', 3],
    ]) {
      responseFixture = {
        url,
        status: 401,
        body: JSON.stringify({
          error: { message: 'Access denied for ' + videoCredential },
        }),
      };
      const beforeFailure = requests.length;
      await assert.rejects(
        sdk.generateVideo({
          cfg,
          prompt: 'HTTP failure local test',
          timeoutMs: 15_000,
          autoProviderFallback: false,
        }),
        error => {
          assert.match(error.message, new RegExp(stage + '.*HTTP 401'));
          for (const field of ['message', 'errorBody', 'requestId']) {
            assert.ok(
              !String(error[field]).includes(videoCredential),
              'Reflected credential leaked into ' + field,
            );
          }
          return true;
        },
      );
      assert.equal(requests.length, beforeFailure + expectedRequests);
    }
    for (const [url, expectedRequests] of [
      ['/v1/videos', 1],
      ['/v1/videos/video-smoke', 2],
    ]) {
      responseFixture = {
        url,
        status: 200,
        body: '{"status":' + videoCredential,
      };
      const beforeMalformed = requests.length;
      await assert.rejects(
        sdk.generateVideo({
          cfg,
          prompt: 'Malformed response local test',
          timeoutMs: 15_000,
          autoProviderFallback: false,
        }),
        error => {
          assert.match(error.message, /malformed JSON/);
          assert.ok(!error.message.includes(videoCredential));
          assert.equal(error.cause, undefined);
          return true;
        },
      );
      assert.equal(requests.length, beforeMalformed + expectedRequests);
    }
    console.log(
      JSON.stringify({
        ok: true,
        registeredNativeProvider: result.provider,
        multipartReference: true,
        nativeVideoBytes: video.length,
        optionalAuth: true,
        redirectsBlocked: true,
        reflectedCredentialsRedacted: true,
        malformedResponseCauseSuppressed: true,
        fileSecretResolved: nativeToolResult.fileSecretResolved,
        nativeToolExposed: nativeToolResult.nativeToolExposed,
        nativeVideoAttachment: nativeToolResult.nativeVideoAttachment,
        localRequests: requests.length,
      }),
    );
  } finally {
    await new Promise(resolve => trap.close(resolve));
    // Remove only the temporary directory created by this invocation.
    assert.equal(path.dirname(root), temporaryParent);
    assert.ok(path.basename(root).startsWith('intranet-video-smoke-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--native-tool-worker') {
  process.once('message', payload => {
    runNativeToolWorker(payload).then(
      result => process.send(result, () => process.exit(0)),
      error => process.send({ ok: false, error: error.message }, () => process.exit(1)),
    );
  });
} else {
  runSmoke().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
