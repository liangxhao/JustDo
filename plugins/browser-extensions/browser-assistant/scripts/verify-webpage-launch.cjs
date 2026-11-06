// Opt-in browser capability probe. UI clicks are performed manually or by the
// computer-use tool; DevTools is used only to observe/stop the fixture worker.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { WebSocket } = require('ws');

const repoRoot = path.resolve(__dirname, '../../../..');
const argument = name => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const reviewReportPath = argument('--review-report');
if (reviewReportPath) {
  const sourcePath = fs.realpathSync(path.resolve(reviewReportPath));
  const sourceBytes = fs.readFileSync(sourcePath);
  const source = JSON.parse(sourceBytes);
  const recorded = source.events;
  assert(Array.isArray(recorded));
  assert.equal(source.browserExitCode, 0, 'The original browser must have retired normally.');
  assert.notEqual(source.cleanupForcedKill, true);
  const negative = recorded.find(
    event => event.kind === 'open-rejected' && event.type === 'negative-timer',
  );
  assert.match(negative?.error ?? '', /user gesture|user action/iu);
  const synthetic = recorded.find(event => event.kind === 'synthetic-blocked');
  assert(synthetic?.nonce);
  assert(!recorded.some(event => event.kind === 'open-invoked' && event.nonce === synthetic.nonce));
  const clicks = recorded
    .filter(event => event.kind === 'content-click' && event.trusted && event.activation)
    .sort((left, right) => left.at - right.at);
  assert.equal(clicks.length, 2, 'Review requires exactly two recorded activated clicks.');
  const opens = clicks.map(click =>
    recorded.find(
      event =>
        event.kind === 'open-resolved' &&
        event.type === 'launch-click' &&
        event.nonce === click.nonce,
    ),
  );
  assert(opens.every(Boolean));
  const stopAt = source.workerStoppedBeforeClick?.at;
  assert(Number.isFinite(stopAt));
  assert(clicks[0].at >= stopAt);
  assert.notEqual(opens[0].bootId, negative.bootId);
  const coldBoot = recorded.find(
    event => event.kind === 'worker-boot' && event.bootId === opens[0].bootId,
  );
  assert(coldBoot && coldBoot.at >= clicks[0].at);
  assert(
    !recorded.some(
      event => event.kind === 'worker-boot' && event.receivedAt > stopAt && event.at < clicks[0].at,
    ),
  );
  const visible = recorded.find(
    event =>
      event.kind === 'panel-loaded' &&
      event.visibility === 'visible' &&
      event.at >= clicks[0].at &&
      event.at < clicks[1].at,
  );
  assert(visible);
  assert.equal(source.checks.coldWorkerRealClickOpened, true);
  assert.equal(source.checks.visiblePanelDocumentLoaded, true);
  const invocations = clicks.map(click =>
    recorded.find(event => event.kind === 'open-invoked' && event.nonce === click.nonce),
  );
  assert(invocations.every(event => event?.frameId === 0 && event.lifecycle === 'active'));
  assert.equal(invocations[0].documentId, invocations[1].documentId);
  assert.equal(invocations[0].tabId, invocations[1].tabId);
  const workerReused = opens[0].bootId === opens[1].bootId;
  if (!workerReused) {
    assert(
      recorded.some(
        event =>
          event.kind === 'worker-boot' &&
          event.bootId === opens[1].bootId &&
          event.at >= clicks[1].at,
      ),
    );
  }
  if (source.status !== 'passed') {
    assert.equal(source.status, 'failed');
    assert.match(source.error, /^Expected values to be strictly equal:/u);
    assert(source.error.includes(opens[0].bootId) && source.error.includes(opens[1].bootId));
    assert.equal(
      workerReused,
      false,
      'Only the old identical-worker assertion is explained by this review.',
    );
  }
  const fixture = fs.realpathSync(source.fixtureRoot);
  assert(fixture.startsWith(fs.realpathSync(path.join(repoRoot, 'build')) + path.sep));
  for (const name of [
    'manifest.json',
    'background.js',
    'content.js',
    'sidepanel.html',
    'panel.js',
  ]) {
    assert.equal(
      crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(fixture, 'extension', name)))
        .digest('hex'),
      source.fixtureSha256[name],
      `Original fixture ${name} must match its recorded hash.`,
    );
  }
  const assessment = {
    status: 'capability-confirmed-from-recorded-events',
    freshFullRun: false,
    sourceReport: sourcePath,
    sourceReportSha256: crypto.createHash('sha256').update(sourceBytes).digest('hex'),
    sourceHarnessStatus: source.status,
    sourceHarnessError: source.error ?? null,
    reviewerScriptSha256: crypto
      .createHash('sha256')
      .update(fs.readFileSync(__filename))
      .digest('hex'),
    reviewedAt: new Date().toISOString(),
    browserVersion: source.browserVersion,
    sourceFixtureHashesVerified: true,
    checks: {
      noGestureRejected: true,
      syntheticClickBlocked: true,
      stoppedWorkerRealClickOpened: true,
      visiblePanelLoaded: true,
      secondActivatedClickOpened: true,
      sameDocumentAndTab: true,
      browserRetiredNormally: true,
    },
    secondClickIntervalMs: clicks[1].at - clicks[0].at,
    secondClickWorkerReused: workerReused,
    explanation:
      'Both sidePanel.open calls resolved. The original harness incorrectly required the second click to reuse the same worker; worker retirement/restart between operator clicks is allowed.',
    limits:
      'Review of preserved real-browser events, not a fresh full harness pass or production SDK integration test. Event trust alone does not establish OS-input provenance.',
  };
  const assessmentPath = path.join(path.dirname(sourcePath), 'assessment.json');
  fs.writeFileSync(assessmentPath, JSON.stringify(assessment, null, 2));
  console.log(
    JSON.stringify({
      status: assessment.status,
      sourceHarnessStatus: source.status,
      assessment: assessmentPath,
    }),
  );
  return;
}
const chromePath = argument('--chrome') || process.env.BROWSER_EXTENSION_CHROMIUM;
if (!chromePath || !fs.existsSync(chromePath)) {
  throw new Error(
    'Pass --chrome <existing Chrome for Testing executable>; no download is performed.',
  );
}
const timeoutMs = Number(argument('--timeout-ms') || 300_000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 900_000) {
  throw new Error('--timeout-ms must be an integer between 30000 and 900000.');
}
const runId = `${new Date().toISOString().replace(/[:.]/gu, '-')}-${crypto.randomBytes(3).toString('hex')}`;
const outputDir = path.join(repoRoot, '.agent-tasks/browser-artifacts', `webpage-launch-${runId}`);
fs.mkdirSync(path.join(repoRoot, 'build'), { recursive: true });
const fixtureRoot = fs.mkdtempSync(path.join(repoRoot, 'build', 'wlp-'));
const extensionDir = path.join(fixtureRoot, 'extension');
const profileDir = path.join(fixtureRoot, 'profile');
fs.mkdirSync(outputDir, { recursive: true });
fs.mkdirSync(extensionDir, { recursive: true });
fs.mkdirSync(profileDir, { recursive: true });

const events = [];
let stage = 'preparing';
let origin;
let cdp;
let browserProcess;
let browserExited = false;
let workerStoppedAt;
let abortError;
const report = {
  runId,
  startedAt: new Date().toISOString(),
  status: 'running',
  scope:
    'Minimal generated extension, real headed Chrome for Testing, real OS input; no production launch implementation.',
  uiInput: 'External human/computer-use OS input; this runner never dispatches UI input.',
  isolatedProfile: true,
  nativeHostOrUserGatewayStarted: false,
  publicNetworkBoundary: 'Loopback fixtures and DNS guard; no OS firewall isolation claim.',
  browserPath: path.resolve(chromePath),
  browserExecutableSha256: crypto
    .createHash('sha256')
    .update(fs.readFileSync(chromePath))
    .digest('hex'),
  fieldTrialTestingConfig: false,
  fixtureRoot,
  outputDir,
  checks: {},
};
const persist = () => {
  fs.writeFileSync(
    path.join(outputDir, 'report.json'),
    JSON.stringify({ ...report, stage, events }, null, 2),
  );
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, limit = 20_000) {
  const started = Date.now();
  while (Date.now() - started < limit) {
    if (abortError) throw abortError;
    const result = predicate();
    if (result) return result;
    if (browserExited) throw new Error(`Browser exited while waiting for ${label}.`);
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  response.setHeader('Cache-Control', 'no-store');
  if (request.method === 'POST' && url.pathname === '/event') {
    let body = '';
    request.on('data', chunk => {
      body += chunk;
      if (body.length > 32_768) request.destroy();
    });
    request.on('end', () => {
      try {
        const event = JSON.parse(body);
        events.push({ ...event, receivedAt: Date.now() });
        persist();
        response.end('ok');
      } catch {
        response.writeHead(400).end();
      }
    });
    return;
  }
  if (url.pathname === '/state') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ stage, checks: report.checks, events: events.slice(-12) }));
    return;
  }
  if (url.pathname !== '/') {
    response.writeHead(404).end();
    return;
  }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><html lang="en"><meta charset="utf-8">
    <title>Webpage Side Panel Probe</title>
    <style>body{font:18px system-ui;margin:52px;background:#f4f6fb;color:#16223a}
    button{font:inherit;padding:20px 30px;background:#265de0;color:white;border:0;border-radius:12px}
    pre{font:14px monospace;white-space:pre-wrap;max-width:900px}h1{font-size:30px}</style>
    <h1>Webpage Side Panel Probe</h1><p>Isolated loopback fixture. No desktop application connection.</p>
    <p id="stage">Preparing negative controls and cold worker...</p>
    <button id="launch" disabled>Open conversation side panel</button>
    <p id="click-result">Waiting for content script.</p><pre id="events"></pre>
    <script>setInterval(async()=>{try{const s=await fetch('/state').then(r=>r.json());
      document.querySelector('#stage').textContent='Stage: '+s.stage;
      document.querySelector('#launch').disabled=!['ready-cold-click','ready-warm-click'].includes(s.stage);
      document.querySelector('#events').textContent=JSON.stringify(s,null,2);}catch{}},300);</script>
    </html>`);
});

async function connectDevTools(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  const notifications = [];
  let nextId = 0;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('DevTools connection timed out.'));
    }, 10_000);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
  socket.on('message', raw => {
    const message = JSON.parse(String(raw));
    if (message.id !== undefined) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
      else waiter.resolve(message.result);
    } else notifications.push(message);
  });
  socket.on('close', () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`DevTools closed during ${waiter.method}.`));
    }
    pending.clear();
  });
  return {
    socket,
    notifications,
    send(method, params = {}, sessionId) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out.`));
        }, 10_000);
        pending.set(id, { method, resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
  };
}

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  report.origin = origin;
  const publicKey = crypto
    .generateKeyPairSync('rsa', { modulusLength: 2048 })
    .publicKey.export({ type: 'spki', format: 'der' });
  const expectedExtensionId = crypto
    .createHash('sha256')
    .update(publicKey)
    .digest('hex')
    .slice(0, 32)
    .replace(/[0-9a-f]/gu, digit => String.fromCharCode(97 + Number.parseInt(digit, 16)));
  const files = {
    'manifest.json': JSON.stringify(
      {
        manifest_version: 3,
        name: 'Webpage Launch Capability Probe',
        version: '1.0.0',
        key: publicKey.toString('base64'),
        permissions: ['sidePanel'],
        host_permissions: ['http://127.0.0.1/*'],
        background: { service_worker: 'background.js' },
        side_panel: { default_path: 'sidepanel.html' },
        content_scripts: [
          { matches: ['http://127.0.0.1/*'], js: ['content.js'], run_at: 'document_idle' },
        ],
      },
      null,
      2,
    ),
    'background.js': `const origin=${JSON.stringify(origin)};
      const bootId=crypto.randomUUID();
      const record=e=>fetch(origin+'/event',{method:'POST',body:JSON.stringify({...e,bootId,at:Date.now()})});
      chrome.runtime.onMessage.addListener((message,sender,reply)=>{
        if(sender.origin!==origin||sender.frameId!==0||!sender.documentId||!sender.tab?.id)return;
        if(!['negative-timer','launch-click'].includes(message.type))return;
        const opened=chrome.sidePanel.open({tabId:sender.tab.id});
        void record({kind:'open-invoked',type:message.type,nonce:message.nonce,documentId:sender.documentId,
          frameId:sender.frameId,lifecycle:sender.documentLifecycle,tabId:sender.tab.id});
        void opened.then(()=>{void record({kind:'open-resolved',type:message.type,nonce:message.nonce});reply({ok:true,bootId});},
          error=>{void record({kind:'open-rejected',type:message.type,nonce:message.nonce,error:error.message});reply({ok:false,error:error.message,bootId});});
        return true;
      });
      chrome.sidePanel.onOpened?.addListener(info=>{void record({kind:'panel-opened',tabId:info.tabId,windowId:info.windowId});});
      void record({kind:'worker-boot'});`,
    'content.js': `if(location.origin===${JSON.stringify(origin)}&&window===top){
      const record=e=>fetch('/event',{method:'POST',body:JSON.stringify({...e,at:Date.now()})});
      const button=document.querySelector('#launch');
      button.addEventListener('click',event=>{
        const nonce=crypto.randomUUID();
        void record({kind:'content-click',nonce,trusted:event.isTrusted,activation:navigator.userActivation.isActive});
        if(!event.isTrusted||!navigator.userActivation.isActive){void record({kind:'synthetic-blocked',nonce});return;}
        chrome.runtime.sendMessage({type:'launch-click',nonce},reply=>{
          document.querySelector('#click-result').textContent=JSON.stringify(reply||{error:chrome.runtime.lastError?.message});
        });
      });
      document.querySelector('#click-result').textContent='Content script ready.';
      setTimeout(()=>{
        button.disabled=false;button.click();button.disabled=true;
        chrome.runtime.sendMessage({type:'negative-timer'},()=>{void chrome.runtime.lastError;});
      },100);
    }`,
    'sidepanel.html':
      '<!doctype html><html lang="en"><meta charset="utf-8"><title>Launch Probe Panel</title><style>body{font:18px system-ui;padding:20px;color:#123862;background:#edf8f4}h1{font-size:26px}</style><h1>Conversation side panel opened</h1><p>Opened from a real webpage button.</p><p>No model or desktop session is started.</p><script src="panel.js"></script></html>',
    'panel.js': `void fetch(${JSON.stringify(origin)}+'/event',{method:'POST',body:JSON.stringify({kind:'panel-loaded',visibility:document.visibilityState,at:Date.now()})});`,
  };
  for (const [name, content] of Object.entries(files))
    fs.writeFileSync(path.join(extensionDir, name), content);
  report.fixtureSha256 = Object.fromEntries(
    Object.entries(files).map(([name, content]) => [
      name,
      crypto.createHash('sha256').update(content).digest('hex'),
    ]),
  );
  browserProcess = spawn(
    chromePath,
    [
      `--user-data-dir=${profileDir}`,
      '--profile-directory=CapabilityProbe',
      `--load-extension=${extensionDir}`,
      `--disable-extensions-except=${extensionDir}`,
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-field-trial-config',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--metrics-recording-only',
      '--enable-logging=stderr',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
      '--window-size=1280,900',
      '--window-position=0,0',
      '--start-maximized',
      '--new-window',
      origin,
      // This is the interactive test surface itself, so it must expose a window.
    ],
    { cwd: path.dirname(chromePath), windowsHide: false, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  browserProcess.on('error', error => {
    report.browserLaunchError = error.message;
    browserExited = true;
  });
  browserProcess.once('exit', code => {
    browserExited = true;
    report.browserExitCode = code;
  });
  report.browserPid = browserProcess.pid;
  const stderr = fs.createWriteStream(path.join(fixtureRoot, 'browser-stderr.log'));
  browserProcess.stderr.pipe(stderr);
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  const [debugPort, browserEndpoint] = await until(() => {
    try {
      const endpoint = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/u);
      return /^\d+$/u.test(endpoint[0]) && endpoint[1]?.startsWith('/devtools/browser/')
        ? endpoint
        : null;
    } catch (error) {
      if (['ENOENT', 'EBUSY', 'EPERM'].includes(error.code)) return null;
      throw error;
    }
  }, 'isolated browser DevTools endpoint');
  cdp = await connectDevTools(`ws://127.0.0.1:${debugPort}${browserEndpoint}`);
  report.browserVersion = await cdp.send('Browser.getVersion');
  assert.match(report.browserVersion.product, /Chrome\//u);
  const negative = await until(
    () => events.find(event => event.kind === 'open-rejected' && event.type === 'negative-timer'),
    'no-gesture rejection',
  );
  assert.match(negative.error, /user gesture|user action/iu);
  const synthetic = events.find(event => event.kind === 'synthetic-blocked');
  assert(synthetic);
  assert(!events.some(event => event.kind === 'open-invoked' && event.nonce === synthetic.nonce));
  report.checks.noGestureRejected = true;
  report.checks.syntheticClickBlocked = true;
  const targets = await cdp.send('Target.getTargets');
  const workers = targets.targetInfos.filter(
    target => target.type === 'service_worker' && target.url.endsWith('/background.js'),
  );
  report.observedWorkerUrls = workers.map(worker => worker.url);
  persist();
  const fixtureWorkers = workers.filter(
    worker => worker.url === `chrome-extension://${expectedExtensionId}/background.js`,
  );
  assert.equal(fixtureWorkers.length, 1, 'The exact generated extension worker must be present.');
  report.extensionId = expectedExtensionId;
  report.additionalWorkerCount = workers.length - fixtureWorkers.length;
  const page = targets.targetInfos.find(
    target => target.type === 'page' && target.url === `${origin}/`,
  );
  assert(page, 'The loopback test page must exist.');
  const attached = await cdp.send('Target.attachToTarget', {
    targetId: page.targetId,
    flatten: true,
  });
  await cdp.send('ServiceWorker.enable', {}, attached.sessionId);
  const scope = `chrome-extension://${report.extensionId}/`;
  const version = await until(
    () =>
      cdp.notifications
        .flatMap(message =>
          message.method === 'ServiceWorker.workerVersionUpdated' ? message.params.versions : [],
        )
        .find(
          value => value.scriptURL === `${scope}background.js` && value.runningStatus === 'running',
        ),
    'worker version observation',
  );
  await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId }, attached.sessionId);
  await until(
    () =>
      cdp.notifications
        .flatMap(message =>
          message.method === 'ServiceWorker.workerVersionUpdated' ? message.params.versions : [],
        )
        .find(value => value.versionId === version.versionId && value.runningStatus === 'stopped'),
    'confirmed stopped worker',
  );
  workerStoppedAt = Date.now();
  report.workerStoppedBeforeClick = { versionId: version.versionId, at: workerStoppedAt };
  await cdp.send('Target.detachFromTarget', { sessionId: attached.sessionId });
  const afterStop = await cdp.send('Target.getTargets');
  assert(
    !afterStop.targetInfos.some(
      target => target.type === 'service_worker' && target.url === `${scope}background.js`,
    ),
  );
  assert(!afterStop.targetInfos.some(target => target.url === `${scope}sidepanel.html`));
  assert(!events.some(event => event.kind === 'panel-loaded'));
  stage = 'ready-cold-click';
  persist();
  console.log(
    JSON.stringify({
      stage,
      origin,
      report: path.join(outputDir, 'report.json'),
      browserVersion: report.browserVersion.product,
    }),
  );
  const coldClick = await until(
    () =>
      events.find(
        event =>
          event.kind === 'content-click' && event.trusted && event.receivedAt > workerStoppedAt,
      ),
    'real cold-worker click',
    timeoutMs,
  );
  assert.equal(coldClick.activation, true);
  const coldOpened = await until(
    () =>
      events.find(
        event =>
          event.kind === 'open-resolved' &&
          event.type === 'launch-click' &&
          event.nonce === coldClick.nonce,
      ),
    'cold-worker side panel open',
  );
  assert.notEqual(coldOpened.bootId, negative.bootId);
  const coldBoot = await until(
    () => events.find(event => event.kind === 'worker-boot' && event.bootId === coldOpened.bootId),
    'cold worker boot observation',
  );
  assert(coldBoot.at >= coldClick.at, 'The fixture worker must boot after the actual click.');
  assert(
    !events.some(
      event =>
        event.kind === 'worker-boot' &&
        event.receivedAt > workerStoppedAt &&
        event.at < coldClick.at,
    ),
  );
  await until(
    () =>
      events.find(
        event =>
          event.kind === 'panel-loaded' &&
          event.receivedAt > workerStoppedAt &&
          event.visibility === 'visible',
      ),
    'visible side panel document',
  );
  report.checks.coldWorkerRealClickOpened = true;
  report.checks.visiblePanelDocumentLoaded = true;
  report.coldWorkerBootId = coldOpened.bootId;
  const warmStageAt = Date.now();
  stage = 'ready-warm-click';
  persist();
  console.log(JSON.stringify({ stage, origin }));
  const warmClick = await until(
    () =>
      events.find(
        event =>
          event.kind === 'content-click' &&
          event.trusted &&
          event.nonce !== coldClick.nonce &&
          event.at > warmStageAt,
      ),
    'second real click',
    timeoutMs,
  );
  assert.equal(warmClick.activation, true);
  const warmOpened = await until(
    () =>
      events.find(
        event =>
          event.kind === 'open-resolved' &&
          event.type === 'launch-click' &&
          event.nonce === warmClick.nonce,
      ),
    'second real click with panel open',
  );
  report.secondClickWorkerReused = warmOpened.bootId === coldOpened.bootId;
  report.checks.secondActivatedClickOpened = true;
  report.status = 'passed';
  report.completedAt = new Date().toISOString();
  stage = 'passed';
  persist();
  console.log(
    JSON.stringify({
      status: report.status,
      checks: report.checks,
      report: path.join(outputDir, 'report.json'),
    }),
  );
}

const deadline = setTimeout(() => {
  abortError = new Error('Overall probe deadline exceeded.');
}, timeoutMs + 60_000);
main()
  .catch(error => {
    report.status = 'failed';
    report.error = error.message;
    report.completedAt = new Date().toISOString();
    persist();
    console.error(
      JSON.stringify({ error: error.message, report: path.join(outputDir, 'report.json') }),
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    clearTimeout(deadline);
    if (cdp) {
      await cdp.send('Browser.close').catch(() => {});
      cdp.socket.close();
    }
    if (browserProcess && !browserExited) {
      const gracefulDeadline = Date.now() + 5_000;
      while (!browserExited && Date.now() < gracefulDeadline) await sleep(100);
      if (!browserExited) {
        report.cleanupForcedKill = true;
        browserProcess.kill();
        const forcedDeadline = Date.now() + 3_000;
        while (!browserExited && Date.now() < forcedDeadline) await sleep(100);
        report.status = 'failed';
        report.error = 'Browser did not retire normally within the cleanup deadline.';
        process.exitCode = 1;
      }
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    persist();
  });
