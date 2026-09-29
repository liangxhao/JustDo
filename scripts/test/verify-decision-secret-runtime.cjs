'use strict';

// Offline integration check: the actual packaged Gateway resolves a file SecretRef
// and invokes TypeSafe through its separately loaded SDK. No chat model is called.
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const runtime = path.resolve(process.argv[2] || 'vendor/openclaw-runtime/current');
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-secret-runtime-'));
  const configPath = path.join(state, 'openclaw.json');
  const secretPath = path.join(state, 'test-secrets.json');
  const token = 'isolated-gateway-test-token';
  // Deliberately overlaps kev-latest: request-owned model text is not a key leak.
  let expectedKey = 'test';
  let calls = 0;
  const provider = http.createServer(async (req, res) => {
    calls++;
    if (req.url !== '/v1/systemone' || req.headers.authorization !== `Bearer ${expectedKey}`) {
      res.writeHead(401);
      res.end();
      return;
    }
    const parts = [];
    for await (const part of req) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts).toString());
    assert.equal(body.model, 'kev-latest');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        model: 'kev-latest',
        answers: { q: { type: 'noul', noul: 0.9 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const reservation = http.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const writeSecret = value => fs.writeFileSync(secretPath, JSON.stringify(value), { mode: 0o600 });
  writeSecret({ apiKey: expectedKey });
  if (process.platform === 'win32') {
    const systemDirectory = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    const options = { windowsHide: true, timeout: 5000, encoding: 'utf8' };
    const identity = execFileSync(
      path.join(systemDirectory, 'whoami.exe'),
      ['/user', '/fo', 'csv', '/nh'],
      options,
    );
    const sid = identity.match(/S-1-\d+(?:-\d+)+/)?.[0];
    assert.ok(sid, 'Cannot identify synthetic credential owner.');
    execFileSync(
      path.join(systemDirectory, 'icacls.exe'),
      [secretPath, '/inheritance:r', '/grant:r', `*${sid}:F`, '*S-1-5-18:F', '*S-1-5-32-544:F'],
      options,
    );
  }
  const config = {
    gateway: {
      mode: 'local',
      bind: 'loopback',
      port,
      auth: { mode: 'token', token },
      controlUi: { enabled: false },
    },
    agents: {
      defaults: { workspace: path.join(state, 'workspace'), decisionModel: 'typesafe/kev-latest' },
    },
    tools: { alsoAllow: ['typesafe_evaluate'] },
    secrets: { providers: { decision_test: { source: 'file', path: secretPath, mode: 'json' } } },
    plugins: {
      allow: ['typesafe'],
      slots: { memory: 'none' },
      entries: {
        typesafe: {
          enabled: true,
          config: {
            serviceUrl: `http://127.0.0.1:${provider.address().port}/v1`,
            model: 'kev-latest',
            apiKey: { source: 'file', provider: 'decision_test', id: '/apiKey' },
          },
        },
      },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const env = {
    ...process.env,
    OPENCLAW_HOME: state,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_NO_RESPAWN: '1',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    NO_PROXY: '*',
  };
  Object.assign(process.env, env);
  const child = spawn(
    process.execPath,
    [
      path.join(runtime, 'gateway-launcher.cjs'),
      'gateway',
      'run',
      '--allow-unconfigured',
      '--port',
      String(port),
    ],
    {
      cwd: runtime,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.on('data', data => {
    output = (output + data).slice(-32000);
  });
  child.stderr.on('data', data => {
    output = (output + data).slice(-32000);
  });
  let client;
  const deadline = setTimeout(() => child.kill(), 120000);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (child.exitCode !== null) throw new Error(`Gateway exited (${child.exitCode}).`);
      try {
        ready = (
          await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) })
        ).ok;
        if (ready) break;
      } catch {
        /* Wait for the isolated Gateway to bind. */
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.equal(ready, true, 'Gateway did not become ready.');
    const invoke = () =>
      fetch(`http://127.0.0.1:${port}/tools/invoke`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          tool: 'typesafe_evaluate',
          args: { state: 'Synthetic test input', questions: { q: { type: 'noul' } } },
        }),
        signal: AbortSignal.timeout(15000),
      });
    const verifyResult = async response => {
      assert.equal(response.status, 200, 'Evaluation request failed.');
      const body = await response.json();
      assert.equal(body.ok, true);
      assert.notEqual(body.result?.isError, true);
      assert.deepEqual(body.result?.details?.evaluation, {
        model: 'kev-latest',
        answers: { q: { type: 'noul', noul: 0.9 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    };
    const first = await invoke();
    await verifyResult(first);
    assert.equal(calls, 1, 'The provider did not receive the prepared credential.');
    const clientFile = fs
      .readdirSync(path.join(runtime, 'dist'))
      .find(
        file =>
          /^client-.*\.mjs$/.test(file) &&
          fs.readFileSync(path.join(runtime, 'dist', file), 'utf8').includes('GatewayClient as t'),
      );
    assert.ok(clientFile, 'Native Gateway client entry not found.');
    const { t: GatewayClient } = await import(
      pathToFileURL(path.join(runtime, 'dist', clientFile)).href
    );
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Gateway handshake timed out.')), 15000);
      client = new GatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token,
        clientName: 'gateway-client',
        mode: 'backend',
        scopes: ['operator.admin'],
        onHelloOk: () => {
          clearTimeout(timer);
          resolve();
        },
        onConnectError: error => {
          clearTimeout(timer);
          reject(error);
        },
      });
      client.start();
    });
    expectedKey = 'isolated-decision-key-two';
    writeSecret({ apiKey: expectedKey });
    await client.request('secrets.reload', {});
    const rotated = await invoke();
    await verifyResult(rotated);
    assert.equal(calls, 2);
    writeSecret({});
    await client.request('secrets.reload', {});
    const unavailable = await invoke();
    assert.notEqual(unavailable.status, 200, 'Missing credentials must fail closed.');
    assert.equal(calls, 2, 'Unavailable credentials must not reach the provider.');
    writeSecret({ apiKey: expectedKey });
    await client.request('secrets.reload', {});
    const recovered = await invoke();
    await verifyResult(recovered);
    assert.equal(calls, 3);
    console.log(
      'PASS: packaged Gateway + native SDK file SecretRef, rotation, unavailable-owner blocking and recovery.',
    );
  } catch (error) {
    // This isolated fixture contains synthetic credentials only; still redact them.
    const safe = output
      .replaceAll(token, '[redacted]')
      .replace(/isolated-decision-key-\w+/g, '[redacted]');
    fs.writeFileSync(path.join(state, 'gateway-debug.log'), safe);
    throw new Error(
      `${error.message}\nIsolated diagnostic log: ${path.join(state, 'gateway-debug.log')}`,
    );
  } finally {
    clearTimeout(deadline);
    client?.stop();
    child.kill();
    if (child.exitCode === null)
      await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]);
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
