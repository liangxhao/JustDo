// Manual offline host check: node this-file <path-to-playwright-core>.
// Uses a temporary generated extension, loopback HTTP/WebSocket fixtures and an
// isolated Chromium context. No native host registration or real account access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { prepareBrowserExtension } = require('../../scripts/browser/prepare-browser-extension.cjs');

async function main() {
  const playwrightPath = process.argv[2];
  if (!playwrightPath)
    throw new Error('Pass an installed playwright-core path; no download is performed.');
  const { chromium } = require(path.resolve(playwrightPath));
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-browser-host-'));
  const repoRoot = path.resolve(__dirname, '../..');
  const extension = path.join(fixture, 'build/browser-extension/chrome-extension');
  fs.cpSync(
    path.join(repoRoot, 'resources/browser-extension'),
    path.join(fixture, 'resources/browser-extension'),
    { recursive: true },
  );
  fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(fixture, 'package.json'));
  fs.cpSync(path.join(repoRoot, 'resources/icons/png'), path.join(fixture, 'resources/icons/png'), {
    recursive: true,
  });
  const requests = [];
  const sockets = new Set();
  let running = false;
  let browser;
  const server = http.createServer((req, res) => {
    const relative = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).slice(1);
    if (!relative) {
      res.setHeader('Content-Type', 'text/html');
      return res.end('<!doctype html><title>Offline protocol fixture</title>');
    }
    const file = path.resolve(extension, relative);
    if (
      !file.startsWith(extension + path.sep) ||
      !fs.existsSync(file) ||
      !fs.statSync(file).isFile()
    ) {
      res.writeHead(404);
      return res.end();
    }
    res.setHeader(
      'Content-Type',
      {
        '.js': 'text/javascript',
        '.html': 'text/html',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
      }[path.extname(file)] || 'application/octet-stream',
    );
    fs.createReadStream(file).pipe(res);
  });
  const ws = new WebSocketServer({ server });
  ws.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('message', raw => {
      const request = JSON.parse(String(raw));
      if (request.id === undefined) return;
      requests.push(request);
      let result = {};
      if (request.method === 'thread/list')
        result = {
          data: [
            { id: 'one', title: 'Offline fixture', status: { type: running ? 'active' : 'idle' } },
          ],
        };
      if (request.method === 'thread/read')
        result = {
          thread: {
            id: 'one',
            status: { type: running ? 'active' : 'idle' },
            turns: [
              {
                id: 'history',
                items: [
                  {
                    type: 'userMessage',
                    content: [{ type: 'text', text: 'Existing offline question' }],
                  },
                  {
                    type: 'userMessage',
                    content: [{ type: 'text', text: 'Retained cancelled input' }],
                    pendingInput: { id: 'pending-fixture', state: 'cancelled' },
                  },
                ],
              },
            ],
          },
        };
      if (request.method === 'composer/options')
        result = {
          models: [{ id: 'fixture/model', name: 'Offline model' }],
          modelRef: 'fixture/model',
          permissionMode: 'ask',
        };
      if (request.method === 'turn/start') {
        running = true;
        result = { turn: { id: 'run-1' } };
      }
      if (request.method === 'turn/interrupt') running = false;
      socket.send(JSON.stringify({ id: request.id, result }));
    });
  });
  try {
    prepareBrowserExtension({ repoRoot: fixture, outputDir: extension });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.origin === origin ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    const auth = await page.evaluate(async () => {
      const { createExtensionRelayAuthClient, parseRelayAuthJson } =
        await import('/modules/relay-auth-v2.js');
      const token = Array.from({ length: 32 }, (_, index) =>
        index.toString(16).padStart(2, '0'),
      ).join('');
      const fields = {
        keyId: 'Yw3NKWbEM2aRElRIu7JbT_',
        instanceId: 'EREREREREREREREREREREQ',
        sessionId: 'IiIiIiIiIiIiIiIiIiIiIg',
        clientNonce: 'MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM',
        serverNonce: 'REREREREREREREREREREREREREREREREREREREREREQ',
        issuedAtMs: 1786123456000,
        expiresAtMs: 1786123466000,
        role: 'extension',
        transport: 'websocket',
        method: 'GET',
        resource: '/extension?profile=chrome',
        flow: 'extension',
      };
      const challenge = {
        type: 'auth.challenge',
        v: 2,
        ...fields,
        serverProof: 'ynhaAA_l2HkOGXQ8DvIWfzWwwGjDcV93aumHNe_NM-Q',
      };
      const make = () =>
        createExtensionRelayAuthClient({
          token,
          relayUrl: 'ws://127.0.0.1:18797/extension?profile=chrome',
          clientNonce: fields.clientNonce,
          now: () => fields.issuedAtMs + 1,
        });
      const good = await make();
      const hello = good.start();
      const response = await good.acceptChallenge(challenge);
      if (response.clientProof !== 'Rl8TStMYlPLxJPDYwSe__mtEjgMf1C4TM-ZN6sUipZ4')
        throw new Error('Client vector mismatch');
      await good.acceptOk({
        type: 'auth.ok',
        v: 2,
        sessionId: fields.sessionId,
        acceptProof: '1R5MpHs6qnAdc0_X6vKBwj91tlRoWfNuGXaNfSD7VnI',
      });
      let rejected = 0;
      for (const change of [
        { serverProof: 'A'.repeat(43) },
        { resource: '/other' },
        { expiresAtMs: fields.expiresAtMs + 1 },
        { unexpected: true },
      ]) {
        const bad = await make();
        bad.start();
        try {
          await bad.acceptChallenge({ ...challenge, ...change });
        } catch {
          rejected++;
        }
        if (bad.authenticated) throw new Error('Invalid challenge authenticated');
        try {
          await bad.acceptChallenge(challenge);
          throw new Error('Failed client reused');
        } catch (error) {
          if (!error.message.includes('out of sequence')) throw error;
        }
      }
      return {
        version: hello.v,
        authenticated: good.authenticated,
        rejected,
        duplicateRejected: parseRelayAuthJson('{"type":"auth.ok","v":2,"v":1}') === null,
      };
    });
    assert.deepEqual(auth, {
      version: 2,
      authenticated: true,
      rejected: 4,
      duplicateRejected: true,
    });
    await page.addInitScript(
      url => {
        globalThis.chrome = {
          windows: { getCurrent: async () => ({ id: 1 }) },
          runtime: {
            sendMessage: async () => ({ ok: true, localAppServerUrl: url }),
            getManifest: () => ({ version: '0.0.0' }),
            openOptionsPage() {},
          },
          tabs: { query: async () => [] },
          permissions: { request: async () => false },
        };
      },
      origin.replace('http:', 'ws:'),
    );
    await page.goto(`${origin}/sidepanel.html`);
    await page.waitForFunction(() =>
      globalThis.document.querySelector('#session option[value="one"]'),
    );
    await page.selectOption('#session', 'one');
    await page.getByText('Existing offline question', { exact: true }).waitFor();
    await page.getByText('Retained cancelled input', { exact: true }).waitFor();
    assert.match(await page.locator('.pending-input-status').innerText(), /cancelled|取消/i);
    for (const socket of sockets)
      socket.send(
        JSON.stringify({
          method: 'thread/updated',
          params: {
            threadId: 'one',
            thread: {
              id: 'one',
              turns: [
                {
                  id: 'history',
                  items: [
                    {
                      type: 'userMessage',
                      content: [{ type: 'text', text: 'Existing offline question' }],
                    },
                  ],
                },
              ],
            },
          },
        }),
      );
    await page
      .getByText('Retained cancelled input', { exact: true })
      .waitFor({ state: 'detached' });
    await page.fill('#prompt', 'Offline test request');
    await page.click('#send');
    await page.waitForFunction(
      () => globalThis.document.querySelector('#send')?.getAttribute('aria-label') === 'Stop',
    );
    const emit = (seq, stream, data) => {
      const frame = {
        method: 'thread/stream',
        params: {
          threadId: 'one',
          kind: 'agent',
          event: {
            runId: 'run-1',
            sessionKey: 'agent:main:justdo:one',
            sessionId: null,
            lifecycleGeneration: null,
            agentId: 'main',
            spawnedBy: null,
            agentSeq: seq,
            frameSeq: seq,
            deliveryEvent: 'agent',
            timestamp: seq,
            stream,
            data,
          },
        },
      };
      for (const socket of sockets) socket.send(JSON.stringify(frame));
    };
    emit(1, 'thinking', { text: 'Offline thinking' });
    await page.waitForFunction(
      () => globalThis.document.querySelector('.process-cluster')?.open === true,
    );
    await page.click('.process-cluster > summary');
    emit(2, 'thinking', { text: 'More offline thinking' });
    await page.getByText('More offline thinking', { exact: true }).waitFor({ state: 'attached' });
    assert.equal(await page.locator('.process-cluster').evaluate(el => el.open), false);
    emit(3, 'assistant', { text: 'Offline streamed answer' });
    await page.getByText('Offline streamed answer', { exact: true }).waitFor();
    await page.click('#send');
    await page.waitForFunction(
      () => globalThis.document.querySelector('#send')?.getAttribute('aria-label') === 'Send',
    );
    assert.equal(requests.filter(request => request.method === 'turn/start').length, 1);
    assert.equal(requests.filter(request => request.method === 'turn/interrupt').length, 1);
    assert.equal(
      requests.find(request => request.method === 'turn/start').params.input[0].text,
      'Offline test request',
    );
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        ok: true,
        browser: browser.version(),
        auth,
        overlay: {
          history: true,
          pendingInputRecoveryAndRemoval: true,
          send: true,
          realLoopbackWebSocket: true,
          streamedThinking: true,
          manualCollapse: true,
          streamedAnswer: true,
          stop: true,
        },
        pageErrors: 0,
        nativeHost: 'not exercised',
      }),
    );
  } finally {
    await browser?.close();
    for (const socket of sockets) socket.terminate();
    await new Promise(resolve => ws.close(resolve));
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
