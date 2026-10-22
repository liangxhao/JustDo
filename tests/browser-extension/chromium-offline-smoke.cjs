// Manual offline host check: node this-file <path-to-playwright-core>.
// Uses a temporary generated extension, loopback HTTP/WebSocket fixtures and an
// isolated Chromium context. No native host registration or real account access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const {
  prepareBrowserExtension,
} = require('../../plugins/browser-extensions/browser-assistant/scripts/prepare.cjs');

async function main() {
  const playwrightPath = process.argv[2];
  if (!playwrightPath)
    throw new Error('Pass an installed playwright-core path; no download is performed.');
  const { chromium } = require(path.resolve(playwrightPath));
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-host-'));
  const repoRoot = path.resolve(__dirname, '../..');
  const extension = path.join(fixture, 'build/browser-extension/chrome-extension');
  fs.cpSync(
    path.join(repoRoot, 'plugins/browser-extensions/browser-assistant'),
    path.join(fixture, 'plugins/browser-extensions/browser-assistant'),
    { recursive: true },
  );
  fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(fixture, 'package.json'));
  fs.cpSync(path.join(repoRoot, 'resources/icons/png'), path.join(fixture, 'resources/icons/png'), {
    recursive: true,
  });
  const requests = [];
  const sockets = new Set();
  let running = false;
  let activeTurnId = '';
  let stopRequested = false;
  let historyTurns = [
    {
      id: 'history',
      items: [
        {
          id: 'initial-user',
          type: 'userMessage',
          content: [{ type: 'text', text: 'Existing offline question' }],
        },
        {
          id: 'archived-thinking',
          type: 'reasoning',
          content: ['Archived inspection'],
          status: 'completed',
        },
        {
          id: 'archived-tool',
          type: 'toolCall',
          toolUseId: 'archived-read',
          toolName: 'read',
          input: { path: 'archived.md' },
          output: Array.from({ length: 80 }, (_, index) => `Archived line ${index + 1}`).join('\n'),
          status: 'completed',
        },
        {
          id: 'archived-intermediate',
          type: 'agentMessage',
          text: 'Archived intermediate explanation',
        },
        {
          id: 'archived-compaction',
          type: 'systemMessage',
          status: 'completed',
          rawMessage: {
            role: 'system',
            content: '',
            __openclaw: {
              kind: 'compaction',
              id: 'archived-compaction',
              tokensBefore: 12000,
              tokensAfter: 4000,
              summary: 'Preserved offline decisions',
            },
          },
        },
        {
          id: 'archived-progress',
          type: 'toolCall',
          toolUseId: 'archived-progress',
          toolName: 'progress_card',
          input: {
            plan: [
              { step: 'Inspect files', status: 'completed' },
              { step: 'Check offline results', status: 'in_progress' },
            ],
          },
          output: 'Plan updated',
          status: 'completed',
        },
        {
          id: 'archived-second-thinking',
          type: 'reasoning',
          content: ['Second archived inspection'],
          status: 'completed',
        },
        {
          id: 'archived-second-tool',
          type: 'toolCall',
          toolUseId: 'archived-second-read',
          toolName: 'read',
          input: { path: 'second.md' },
          output: 'Second archived result',
          status: 'completed',
        },
        {
          id: 'archived-final',
          type: 'agentMessage',
          text: 'Archived final answer',
        },
        {
          id: 'cancelled-user',
          type: 'userMessage',
          content: [{ type: 'text', text: 'Retained cancelled input' }],
          pendingInput: { id: 'pending-fixture', state: 'cancelled' },
        },
      ],
    },
  ];
  const fixtureThread = () => ({
    id: 'one',
    status: { type: running ? 'active' : 'idle' },
    turns: historyTurns,
  });
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
            {
              id: 'one',
              name: 'Offline verification',
              status: { type: running ? 'active' : 'idle' },
            },
          ],
        };
      if (request.method === 'thread/read')
        result = {
          thread: fixtureThread(),
          activeTurn: running
            ? {
                id: activeTurnId,
                nativeRunId: activeTurnId,
                status: 'inProgress',
                executionSettled: false,
              }
            : null,
        };
      if (request.method === 'composer/options')
        result = {
          models: [{ id: 'fixture/model', name: 'Offline model' }],
          modelRef: 'fixture/model',
          permissionMode: 'ask',
        };
      if (request.method === 'turn/start') {
        running = true;
        activeTurnId = request.params.clientTurnId || 'run-1';
        historyTurns.push({
          id: 'current-history',
          items: [
            {
              id: 'current-user',
              type: 'userMessage',
              content: [{ type: 'text', text: request.params.input[0].text }],
            },
          ],
        });
        result = {
          turn: {
            id: activeTurnId,
            nativeRunId: activeTurnId,
            status: 'inProgress',
            executionSettled: false,
          },
        };
      }
      if (request.method === 'turn/interrupt') stopRequested = true;
      socket.send(JSON.stringify({ id: request.id, result }));
    });
  });
  try {
    prepareBrowserExtension({ repoRoot: fixture, outputDir: extension });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const evidenceDirectory = path.join(repoRoot, 'build/browser-extension/verification');
    fs.mkdirSync(evidenceDirectory, { recursive: true });
    browser = await chromium.launch({
      headless: true,
      ...(process.env.BROWSER_EXTENSION_CHROMIUM
        ? { executablePath: process.env.BROWSER_EXTENSION_CHROMIUM }
        : {}),
    });
    const context = await browser.newContext({
      viewport: { width: 420, height: 860 },
      locale: 'en-US',
    });
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
    await page
      .waitForFunction(() => globalThis.document.querySelector('#session option[value="one"]'))
      .catch(error => {
        assert.deepEqual(errors, [], 'Sidepanel failed during startup');
        throw error;
      });
    await page.selectOption('#session', 'one');
    await page.getByText('Existing offline question', { exact: true }).waitFor();
    await page.getByText('Retained cancelled input', { exact: true }).waitFor();
    assert.match(await page.locator('.pending-input-status').innerText(), /cancelled|取消/i);
    const processDetails = page.locator('#processDetails');
    assert.equal(await processDetails.getAttribute('type'), 'button');
    assert.equal(await processDetails.getAttribute('aria-pressed'), 'false');
    assert.equal(await processDetails.getAttribute('aria-label'), 'Expand all process details');
    for (const width of [280, 390, 420]) {
      await page.setViewportSize({ width, height: 860 });
      const geometry = await page.evaluate(() => ({
        width: window.innerWidth,
        bodyWidth: document.body.scrollWidth,
        headerWidth: document.querySelector('header').scrollWidth,
        buttons: ['processDetails', 'refresh', 'settings'].map(id => {
          const rect = document.getElementById(id).getBoundingClientRect();
          return { id, left: rect.left, right: rect.right, width: rect.width };
        }),
      }));
      assert.ok(geometry.bodyWidth <= geometry.width, `Body overflow at ${width}px`);
      assert.ok(geometry.headerWidth <= geometry.width, `Header overflow at ${width}px`);
      for (const button of geometry.buttons) {
        assert.ok(
          button.width >= 24 && button.left >= 0 && button.right <= geometry.width,
          `${button.id} clipped at ${width}px`,
        );
      }
    }
    const archivedHistory = page.locator('.completed-process');
    assert.equal(await archivedHistory.evaluate(element => element.open), false);
    assert.equal(
      await archivedHistory.locator(':scope > summary').getAttribute('aria-label'),
      'Expand process history',
    );
    assert.doesNotMatch(await archivedHistory.locator(':scope > summary').innerText(), /×/);
    assert.equal(await archivedHistory.locator('.process-summary-group').count(), 0);
    await page.getByText('Archived final answer', { exact: true }).waitFor();
    assert.equal(await page.locator('.process-tool').count(), 0);
    await processDetails.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () => document.getElementById('processDetails')?.getAttribute('aria-pressed') === 'true',
    );
    assert.equal(await processDetails.getAttribute('title'), 'Collapse all process details');
    assert.equal(await archivedHistory.evaluate(element => element.open), true);
    await archivedHistory.getByText('12,000 → 4,000 tokens', { exact: false }).waitFor();
    const compactionReader = archivedHistory.locator('.chat-divider__details');
    await compactionReader.locator(':scope > summary').click();
    await compactionReader.getByText('Preserved offline decisions', { exact: true }).waitFor();
    const progressReceipt = archivedHistory.locator('.progress-card-receipt');
    assert.match(await progressReceipt.innerText(), /1\/2/);
    assert.match(await progressReceipt.innerText(), /Check offline results/);
    await page.waitForTimeout(250);
    await page.locator('#messages').evaluate(element => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }));
      element.scrollTop = 0;
    });
    await page.screenshot({
      path: path.join(evidenceDirectory, 'sidepanel-history-expanded.png'),
      fullPage: true,
    });
    assert.equal(await archivedHistory.locator('.process-summary-group[open]').count(), 2);
    assert.equal(await page.locator('details.process-thinking').count(), 0);
    assert.equal(
      await archivedHistory.getByText('Archived final answer', { exact: true }).count(),
      0,
    );
    await archivedHistory.getByText('Archived inspection', { exact: true }).waitFor();
    const archivedTool = page.locator('.process-tool[data-tool-id="archived-read"]');
    assert.equal(await archivedTool.evaluate(element => element.open), false);
    await archivedTool.locator('summary').waitFor();
    await page.waitForTimeout(250);
    await archivedTool.locator('summary').focus();
    assert.equal(
      await archivedTool.locator('summary').evaluate(element => element === document.activeElement),
      true,
    );
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () => document.querySelector('.process-tool[data-tool-id="archived-read"]')?.open === true,
    );
    const archivedToolNode = await archivedTool.elementHandle();
    const archivedReader = archivedTool.locator('[data-section="output"] pre');
    await archivedReader.getByText('Archived line 80', { exact: false }).waitFor();
    await page.waitForTimeout(250);
    const archivedScroll = await archivedReader.evaluate(element => {
      element.scrollTop = 120;
      return element.scrollTop;
    });
    assert.ok(archivedScroll > 0);
    await processDetails.focus();
    await page.keyboard.press('Space');
    await page.waitForFunction(
      () => document.getElementById('processDetails')?.getAttribute('aria-pressed') === 'false',
    );
    await page.waitForTimeout(250);
    assert.equal(
      await archivedToolNode.evaluate(
        element =>
          element === document.querySelector('.process-tool[data-tool-id="archived-read"]'),
      ),
      true,
    );
    assert.equal(await archivedTool.evaluate(element => element.open), true);
    assert.equal(await archivedReader.evaluate(element => element.scrollTop), archivedScroll);
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () => document.getElementById('processDetails')?.getAttribute('aria-pressed') === 'true',
    );
    await page.waitForTimeout(250);
    assert.equal(await archivedReader.evaluate(element => element.scrollTop), archivedScroll);
    // Changing conversation resets only the bulk mode, never dispatches work.
    await page.selectOption('#session', '');
    await page.waitForFunction(
      () => document.getElementById('processDetails')?.getAttribute('aria-pressed') === 'false',
    );
    await page.selectOption('#session', 'one');
    await page.getByText('Existing offline question', { exact: true }).waitFor();
    assert.equal(await processDetails.getAttribute('aria-pressed'), 'false');
    // Outer disclosures are independent. Inner summaries are a single-open
    // accordion in default mode, with Thinking directly visible inside.
    await archivedHistory.locator(':scope > summary').click();
    await page.waitForTimeout(250);
    const archivedSummaries = archivedHistory.locator('.process-summary-group');
    await archivedSummaries.nth(0).locator(':scope > summary').click();
    assert.equal(await archivedSummaries.nth(0).evaluate(element => element.open), true);
    await archivedHistory.getByText('Archived inspection', { exact: true }).waitFor();
    await archivedSummaries.nth(1).locator(':scope > summary').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => {
      const summaries = document.querySelectorAll('.completed-process .process-summary-group');
      return summaries.length === 2 && !summaries[0].open && summaries[1].open;
    });
    assert.equal(await archivedHistory.evaluate(element => element.open), true);
    assert.equal(
      requests.filter(
        request => request.method === 'turn/start' || request.method === 'turn/interrupt',
      ).length,
      0,
    );
    historyTurns[0].items = historyTurns[0].items.filter(item => !item.pendingInput);
    for (const socket of sockets)
      socket.send(
        JSON.stringify({
          method: 'thread/updated',
          params: {
            threadId: 'one',
            thread: fixtureThread(),
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
            runId: activeTurnId,
            sessionKey: 'agent:main:justdo:one',
            sessionId: null,
            lifecycleGeneration: null,
            agentId: 'main',
            spawnedBy: null,
            agentSeq: seq,
            frameSeq: seq,
            deliveryEvent: 'agent',
            timestamp: Date.now(),
            stream,
            data,
          },
        },
      };
      for (const socket of sockets) socket.send(JSON.stringify(frame));
    };
    await page.emulateMedia({ reducedMotion: 'reduce' });
    emit(1, 'thinking', { text: 'Offline thinking' });
    await page
      .locator('.process-live-thinking')
      .getByText('Offline thinking', { exact: true })
      .waitFor();
    assert.equal(
      await page
        .locator('.process-live-thinking')
        .evaluate(element => getComputedStyle(element).animationName),
      'message-enter',
    );
    assert.equal(
      await page
        .locator('.process-thinking[data-status="running"] .process-thinking-marker')
        .evaluate(element => getComputedStyle(element).animationName),
      'process-pulse',
    );
    emit(2, 'thinking', { text: 'More offline thinking' });
    await page
      .locator('.process-live-thinking')
      .getByText('More offline thinking', { exact: true })
      .waitFor();
    emit(3, 'assistant', { text: 'Offline streamed answer' });
    await page.getByText('Offline streamed answer', { exact: true }).waitFor();
    assert.equal(await page.locator('.completed-process').count(), 1);
    const currentSummary = page.locator('#messages > .process-summary-group');
    await currentSummary.locator(':scope > summary').click();
    await currentSummary.getByText('More offline thinking', { exact: true }).waitFor();
    assert.equal(await archivedSummaries.nth(1).evaluate(element => element.open), false);
    emit(4, 'tool', {
      phase: 'start',
      toolCallId: 'inspect-1',
      name: 'read',
      args: { path: 'report.md' },
    });
    emit(5, 'item', {
      kind: 'tool',
      phase: 'update',
      toolCallId: 'inspect-1',
      progressText: 'Reading report sections',
    });
    const currentTool = page.locator('.process-tool[data-tool-id="inspect-1"]');
    await currentTool.waitFor({ state: 'attached' });
    const tool = await currentTool.elementHandle();
    await currentTool.locator(':scope > summary').click();
    await currentTool.locator(':scope > summary').focus();
    emit(6, 'item', {
      kind: 'tool',
      phase: 'update',
      toolCallId: 'inspect-1',
      progressText: 'Reading section 2 of 3',
    });
    await page
      .locator('.process-tool[data-tool-id="inspect-1"] .process-tool-progress')
      .getByText('Reading section 2 of 3', { exact: true })
      .waitFor();
    assert.equal(
      await tool.evaluate(
        element => element === document.querySelector('.process-tool[data-tool-id="inspect-1"]'),
      ),
      true,
    );
    assert.equal(
      await page
        .locator('.process-tool[data-tool-id="inspect-1"] > summary')
        .evaluate(element => element === document.activeElement),
      true,
    );
    emit(7, 'tool', {
      phase: 'update',
      toolCallId: 'inspect-1',
      name: 'read',
      partialResult: Array.from({ length: 80 }, (_, index) => `Report line ${index + 1}`).join(
        '\n',
      ),
    });
    const currentReader = currentTool.locator('[data-section="output"] pre');
    await currentReader.getByText('Report line 80', { exact: false }).waitFor();
    const currentScroll = await currentReader.evaluate(element => {
      element.scrollTop = 96;
      return element.scrollTop;
    });
    assert.ok(currentScroll > 0);
    await currentTool.locator(':scope > summary').focus();
    await processDetails.evaluate(element => element.click());
    await page.waitForFunction(
      () => document.getElementById('processDetails')?.getAttribute('aria-pressed') === 'true',
    );
    assert.equal(
      await page
        .locator('.completed-process, .process-summary-group')
        .evaluateAll(elements => elements.every(element => element.open)),
      true,
    );
    assert.equal(await page.locator('details.process-thinking').count(), 0);
    await processDetails.evaluate(element => element.click());
    await page.waitForFunction(
      () => document.getElementById('processDetails')?.getAttribute('aria-pressed') === 'false',
    );
    await page.waitForTimeout(250);
    assert.equal(
      await page
        .locator('.completed-process')
        .first()
        .evaluate(element => element.open),
      false,
    );
    assert.equal(await page.locator('.process-summary-group[open]').count(), 0);
    await page.locator('.process-live-tool').waitFor();
    assert.equal(await currentTool.evaluate(element => element.open), true);
    assert.equal(
      await tool.evaluate(
        element => element === document.querySelector('.process-tool[data-tool-id="inspect-1"]'),
      ),
      true,
    );
    assert.equal(
      await currentTool
        .locator(':scope > summary')
        .evaluate(element => element === document.activeElement),
      true,
    );
    assert.equal(await currentReader.evaluate(element => element.scrollTop), currentScroll);
    assert.equal(requests.filter(request => request.method === 'turn/start').length, 1);
    assert.equal(requests.filter(request => request.method === 'turn/interrupt').length, 0);
    assert.notEqual(
      await page
        .locator('.run-activity-icon')
        .evaluate(element => getComputedStyle(element).animationName),
      'none',
    );
    assert.equal(
      await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
      true,
    );
    assert.equal(
      await page
        .locator('.run-activity-icon')
        .evaluate(element => getComputedStyle(element).animationName),
      'activity-turn',
    );
    assert.equal(
      await page
        .locator('.run-activity-label')
        .evaluate(element => getComputedStyle(element).animationName),
      'activity-shimmer',
    );
    assert.equal(
      await currentTool
        .locator('.process-tool-status.running')
        .evaluate(element => getComputedStyle(element).animationName),
      'process-pulse',
    );
    const iconAdvances = await page.locator('.run-activity-icon').evaluate(async element => {
      const animation = element.getAnimations()[0];
      const before = animation?.currentTime;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return (
        animation?.playState === 'running' &&
        typeof before === 'number' &&
        animation.currentTime > before
      );
    });
    assert.equal(iconAdvances, true);
    for (const details of [archivedHistory, currentSummary, currentTool]) {
      assert.equal(
        await details.evaluate(element =>
          getComputedStyle(element, '::details-content')
            .transitionDuration.split(',')
            .some(duration => Number.parseFloat(duration) > 0),
        ),
        true,
      );
    }
    assert.equal(
      await archivedHistory.evaluate(
        element =>
          Number.parseFloat(
            getComputedStyle(element.querySelector('.disclosure-chevron')).transitionDuration,
          ) > 0,
      ),
      true,
    );
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.waitForTimeout(300);
    await page.screenshot({
      path: path.join(evidenceDirectory, 'sidepanel-active.png'),
      fullPage: true,
    });
    emit(9, 'tool', { phase: 'result', toolCallId: 'inspect-1', result: 'Read 3 sections' });
    const finalText =
      '## Findings\n\nThe offline report is ready.\n\n- Connection checked\n- Process details preserved\n\n```ts\nconst connected = true;\n```';
    emit(10, 'assistant', { text: finalText });
    await page.getByText('The offline report is ready.').waitFor();
    await page.click('#send');
    await page.waitForTimeout(150);
    assert.equal(stopRequested, true);
    assert.equal(await page.locator('#send').getAttribute('aria-label'), 'Stop');
    running = false;
    historyTurns[1].items.push(
      {
        id: 'thinking',
        type: 'reasoning',
        content: ['More offline thinking'],
        status: 'completed',
      },
      { id: 'assistant-preview', type: 'agentMessage', text: 'Offline streamed answer' },
      {
        id: 'read',
        type: 'toolCall',
        toolUseId: 'inspect-1',
        toolName: 'read',
        input: { path: 'report.md' },
        output: 'Read 3 sections',
        status: 'completed',
      },
      { id: 'assistant-final', type: 'agentMessage', text: finalText },
    );
    for (const socket of sockets)
      socket.send(
        JSON.stringify({
          method: 'turn/completed',
          params: {
            threadId: 'one',
            turn: { id: activeTurnId, status: 'interrupted', executionSettled: true },
          },
        }),
      );
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
    await page.getByText('The offline report is ready.').waitFor();
    assert.equal(await page.getByText('Offline test request', { exact: true }).count(), 1);
    assert.equal(await page.getByText('Retained cancelled input', { exact: true }).count(), 0);
    await page.waitForTimeout(300);
    await page.screenshot({
      path: path.join(evidenceDirectory, 'sidepanel-completed.png'),
      fullPage: true,
    });
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
          completedProcessHistory: true,
          processSummaryAccordion: true,
          directlyVisibleThinking: true,
          sharedCompactionAndProgressReceipts: true,
          streamedAnswer: true,
          stop: true,
          stopAckIsNotTerminal: true,
          toolProgress: true,
          continuousAnimation: true,
          animationPreservedWithReducedMotion: true,
          toolNodeAndFocusPreserved: true,
          processDetailsKeyboardToggle: true,
          processDetailsScopeReset: true,
          processDetailsPreservesRawToolsAndExecution: true,
          narrowHeader: true,
          screenshots: evidenceDirectory,
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
