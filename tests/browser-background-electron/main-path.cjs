'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { BrowserWindow, nativeImage } = require('electron');
const sharedProfile = require('./shared-profile.cjs');

const REQUESTED = 'plugin.embedded-browser.requested';
const CANCELLED = 'plugin.embedded-browser.cancelled';
const RELEASED = 'plugin.embedded-browser.released';

// Only ingress/egress records and metadata lookups are synthetic. All executions
// use the production controller, BrowserAgentBridge, actions and native guest.
exports.run = async function run({
  implementation,
  runRoot,
  url,
  report,
  checked,
  bounded,
  until,
  registerCleanup,
}) {
  const workspace = path.join(runRoot, 'synthetic-main-workspace');
  fs.mkdirSync(workspace);
  const integration = (report.mainPath = {
    ingress: 'synthetic plugin events; no real Gateway or model',
    stubs: ['getDesktopSession', 'getScheduledTask', 'resolve transport'],
    nativePreconditions: [
      'synthetic local file document',
      'synthetic named-profile metadata in isolated userData',
      'real foreground webview login on a synthetic website',
    ],
    requireRendererInteractionAck: true,
    rendererCalls: [],
    executions: [],
    resolved: [],
    releases: [],
  });
  const desktopRun = {
    sessionKey: 'agent:fixture:desktop:synthetic-conversation',
    sessionId: 'synthetic-native-desktop-session',
    runId: 'synthetic-desktop-run',
    trigger: 'user',
    workspaceDir: workspace,
  };
  const cronRun = {
    sessionKey: 'agent:fixture:cron:synthetic-job:run:synthetic-attempt',
    sessionId: 'synthetic-native-cron-session',
    runId: 'synthetic-cron-run',
    trigger: 'cron',
    jobId: 'synthetic-job',
    workspaceDir: workspace,
  };
  const responses = new Map();
  const waiters = new Map();
  const guestsByTarget = new Map();
  implementation.recordImportedBrowserProfile('synthetic-named');
  const foreground = await sharedProfile.createForeground({
    implementation,
    runRoot,
    url,
    report,
    bounded,
    until,
  });
  checked(
    'real foreground webview logs in with server HttpOnly cookie, localStorage and IndexedDB; synthetic UI delegates serve permissions and downloads',
  );
  const mainHost = new implementation.BackgroundBrowserHost();
  const browser = new implementation.BrowserAgentBridge(
    channel => {
      integration.rendererCalls.push(channel);
      assert.fail(`A headless Main request attempted Renderer IPC: ${channel}`);
    },
    () => false,
    () => workspace,
    true,
    undefined,
    undefined,
    mainHost,
  );
  const controller = new implementation.EmbeddedBrowserGatewayBridge({
    isEnabled: () => true,
    getDesktopSession: key =>
      key === desktopRun.sessionKey
        ? {
            id: 'synthetic-desktop-conversation',
            cwd: workspace,
            historyBinding: { nativeSessionId: desktopRun.sessionId },
          }
        : null,
    getScheduledTask: async id =>
      id === cronRun.jobId
        ? {
            id,
            management: 'editable',
            sessionTarget: 'isolated',
            agentId: 'synthetic-agent',
            payload: { kind: 'agentTurn' },
          }
        : null,
    execute: async (sessionKey, command, signal, scope) => {
      const entry = { sessionKey, action: command.action, scope: { ...scope }, completed: false };
      integration.executions.push(entry);
      try {
        return await browser.executeCommand(sessionKey, command, signal, scope);
      } finally {
        entry.completed = true;
        entry.aborted = signal.aborted;
      }
    },
    releaseScope: (sessionId, closePages) => {
      integration.releases.push({ sessionId, closePages });
      browser.releaseExecutionScope(sessionId, closePages);
    },
    revokeAll: () => browser.revokeBackgroundPages(),
    resolve: async (requestId, response) => {
      responses.set(requestId, response);
      integration.resolved.push({ requestId, ok: response.ok });
      waiters.get(requestId)?.(response);
      waiters.delete(requestId);
    },
  });
  registerCleanup(controller);
  let sequence = 0;
  const begin = (run, command, allowLocalFiles = true) => {
    const requestId = `synthetic-request-${++sequence}`;
    const event = {
      event: REQUESTED,
      payload: {
        requestId,
        sessionKey: run.sessionKey,
        run,
        toolCallId: `synthetic-tool-call-${sequence}`,
        command,
        policy: { allowLocalFiles },
      },
    };
    const response = new Promise(resolve => waiters.set(requestId, resolve));
    controller.handleEvent(event);
    return { event, response, requestId };
  };
  const request = async (run, command, allowLocalFiles = true) => {
    const previousWindows = new Set(BrowserWindow.getAllWindows().map(window => window.id));
    const pending = begin(run, command, allowLocalFiles);
    const response = await bounded(pending.response, `Main ${command.action} response`, 12000);
    if (!response.ok && command.action === 'screenshot') {
      const guest = guestsByTarget.get(command.targetId);
      if (guest && !guest.isDestroyed()) {
        integration.failedScreenshotDiagnostics = {
          error: response.error,
          guestId: guest.id,
          offscreen: guest.isOffscreen(),
          painting: guest.isOffscreen() ? guest.isPainting() : null,
          loading: guest.isLoading(),
          bounds: BrowserWindow.fromWebContents(guest)?.getContentBounds(),
          document: await bounded(
            guest.executeJavaScript(
              '({readyState:document.readyState,width:innerWidth,height:innerHeight,visibility:document.visibilityState})',
            ),
            'failed screenshot read-only diagnostics',
          ),
        };
      }
    }
    if (!response.ok && command.action === 'upload') {
      // Read-only diagnostics for a failed real request. This never retries the
      // upload, and the original request still fails this fixture below.
      const guest = guestsByTarget.get(command.targetId);
      if (guest) {
        const inspect = async () => {
          const search = await guest.debugger.sendCommand('DOM.performSearch', { query: '#file' });
          try {
            return {
              search,
              results: search.resultCount
                ? await guest.debugger.sendCommand('DOM.getSearchResults', {
                    searchId: search.searchId,
                    fromIndex: 0,
                    toIndex: 1,
                  })
                : null,
            };
          } finally {
            await guest.debugger.sendCommand('DOM.discardSearchResults', {
              searchId: search.searchId,
            });
          }
        };
        integration.failedUploadDiagnostics = {
          fileInputExists: await guest.executeJavaScript(
            'Boolean(document.querySelector("#file"))',
          ),
          beforeDocument: await inspect(),
        };
        const document = await guest.debugger.sendCommand('DOM.getDocument', { depth: 0 });
        integration.failedUploadDiagnostics.documentNodeId = document.root.nodeId;
        integration.failedUploadDiagnostics.afterDocument = await inspect();
      }
    }
    assert.equal(response.ok, true, JSON.stringify(response));
    if (command.action === 'open') {
      const window = BrowserWindow.getAllWindows().find(
        candidate => !previousWindows.has(candidate.id),
      );
      assert.ok(window, 'Main open did not create its own background window');
      guestsByTarget.set(response.result.targetId, window.webContents);
    }
    return response.result;
  };
  const release = (run, reason) =>
    controller.handleEvent({
      event: RELEASED,
      payload: { run, reason, discardPages: reason === 'revoked' },
    });
  const read = (guest, expression) => guest.executeJavaScript(expression);
  const evaluate = async (run, targetId, expression, profile) => {
    const result = await request(run, {
      action: 'act',
      ...(profile ? { profile } : {}),
      request: { targetId, kind: 'evaluate', fn: `() => ${expression}` },
    });
    return result.details.result;
  };
  const imageResult = (result, name) => {
    const image = result.content?.find(content => content.type === 'image');
    assert.ok(
      image && image.data.length > 100,
      `${name} did not reach the model-facing image content`,
    );
    assert.equal(result.details?.media?.outbound, false);
    const png = Buffer.from(image.data, 'base64');
    const size = nativeImage.createFromBuffer(png).getSize();
    assert.ok(size.width > 0 && size.height > 0);
    fs.writeFileSync(path.join(runRoot, `${name}.png`), png);
    return size;
  };
  const managedArtifact = filePath => {
    const relative = path.relative(
      path.join(workspace, '.agent-tasks/browser-artifacts'),
      filePath,
    );
    assert.ok(
      relative && !relative.startsWith('..') && !path.isAbsolute(relative),
      'A production artifact escaped the trusted workspace capability directory',
    );
    return filePath;
  };

  try {
    const ordinaryDefault = await request(desktopRun, { action: 'status' });
    assert.equal(ordinaryDefault.headless, false);
    const opened = await request(desktopRun, { action: 'open', url, headless: true });
    assert.equal(opened.headless, true);
    assert.equal(BrowserWindow.getAllWindows().length, 2);
    const desktopGuest = guestsByTarget.get(opened.targetId);
    assert.equal(desktopGuest.isOffscreen(), true);
    const desktopTarget = opened.targetId;
    const desktopScope = integration.executions.at(-1).scope;
    assert.equal(desktopScope.headlessOnly, false);
    assert.equal(desktopScope.sessionId, 'synthetic-desktop-conversation');
    checked(
      'Main synthetic user event preserves visible default and opens explicit headless without Renderer ACK',
    );

    assert.equal(
      implementation.isSameBrowserSession(desktopGuest.session, foreground.browserSession),
      true,
    );
    assert.equal(desktopGuest.session.storagePath, foreground.browserSession.storagePath);
    const initialAuth = await evaluate(desktopRun, desktopTarget, sharedProfile.stateExpression);
    sharedProfile.assertLogin(initialAuth, 'sidebar-one');
    assert.equal(initialAuth.sessionStorage, null);
    assert.equal(initialAuth.pageMemory, null);
    assert.equal(await read(desktopGuest, 'globalThis.syntheticPageMemory ?? null'), null);
    const authCookie = (await desktopGuest.session.cookies.get({ url })).find(
      cookie => cookie.name === 'synthetic-auth',
    );
    assert.equal(authCookie.httpOnly, true);
    assert.equal(await read(desktopGuest, 'document.cookie.includes("synthetic-auth=")'), false);
    integration.sharedLogin = {
      initialAuth,
      httpOnly: authCookie.httpOnly,
      storagePath: desktopGuest.session.storagePath,
    };
    integration.profileAfterUserAdmission = await foreground.profileAlive();
    checked(
      'Main ordinary headless uses the actual sidebar Session and live HttpOnly/localStorage/IndexedDB login, with independent page memory and sessionStorage',
    );

    const snapshot = await request(desktopRun, { action: 'snapshot', targetId: desktopTarget });
    assert.ok(
      snapshot.content.some(content => content.type === 'text' && content.text.length > 30),
    );
    await request(desktopRun, {
      action: 'act',
      request: {
        targetId: desktopTarget,
        kind: 'type',
        selector: '#text',
        text: '完整 Main 路径🙂',
        submit: true,
      },
    });
    assert.deepEqual(await read(desktopGuest, 'fixture.submissions'), ['完整 Main 路径🙂']);
    checked(
      'Main controller reaches real snapshot and DOM action implementations with synthetic run identity',
    );

    integration.viewport = imageResult(
      await request(desktopRun, { action: 'screenshot', targetId: desktopTarget }),
      'main-viewport',
    );
    await request(desktopRun, {
      action: 'act',
      request: {
        targetId: desktopTarget,
        kind: 'evaluate',
        fn: '() => { document.body.style.minHeight="1900px"; return document.documentElement.scrollHeight; }',
      },
    });
    integration.fullPage = imageResult(
      await request(desktopRun, { action: 'screenshot', targetId: desktopTarget, fullPage: true }),
      'main-fullpage',
    );
    assert.ok(integration.fullPage.height > integration.fullPage.width);
    integration.element = imageResult(
      await request(desktopRun, {
        action: 'screenshot',
        targetId: desktopTarget,
        element: '#click',
      }),
      'main-element',
    );
    assert.deepEqual(integration.element, { width: 150, height: 36 });
    checked(
      'Main screenshot path returns actual viewport, full-page and element images with outbound disabled',
    );

    const uploadName = '合成 Main 上传.txt';
    fs.writeFileSync(path.join(workspace, uploadName), 'synthetic main-path upload');
    await request(desktopRun, {
      action: 'upload',
      targetId: desktopTarget,
      paths: [uploadName],
      element: '#file',
    });
    assert.equal(
      await read(desktopGuest, 'document.querySelector("#file").files[0].name'),
      uploadName,
    );
    const workspaceOnly = begin(
      desktopRun,
      { action: 'upload', targetId: desktopTarget, paths: [uploadName], element: '#file' },
      false,
    );
    assert.equal((await bounded(workspaceOnly.response, 'workspace-only allowed upload')).ok, true);
    const outsidePath = path.join(runRoot, 'synthetic-outside-workspace.txt');
    fs.writeFileSync(outsidePath, 'synthetic file outside the task workspace');
    const denied = begin(
      desktopRun,
      { action: 'upload', targetId: desktopTarget, paths: [outsidePath], element: '#file' },
      false,
    );
    const deniedResult = await bounded(denied.response, 'filesystem policy rejection');
    assert.equal(deniedResult.ok, false);
    assert.match(deniedResult.error, /workspace/iu);
    assert.equal(
      await read(desktopGuest, 'document.querySelector("#file").files[0].name'),
      uploadName,
    );
    checked(
      'Main upload resolves actual workspace files under workspace-only policy and rejects a synthetic external path',
    );

    const localDocument = path.join(workspace, 'synthetic-local.html');
    fs.writeFileSync(localDocument, '<!doctype html><title>Synthetic local document</title>');
    // Seed an existing local document as a browser-state precondition; the real
    // Main request must enforce its top-level policy before reading that page.
    await desktopGuest.loadURL(pathToFileURL(localDocument).href);
    const localDenied = begin(desktopRun, { action: 'text', targetId: desktopTarget }, false);
    const localDeniedResult = await bounded(
      localDenied.response,
      'local-document policy rejection',
    );
    assert.equal(localDeniedResult.ok, false);
    assert.match(localDeniedResult.error, /local file/iu);
    await desktopGuest.loadURL(url);
    checked('Main top-level workspace-only policy refuses an existing synthetic file document');

    const pdf = await request(desktopRun, { action: 'pdf', targetId: desktopTarget });
    const pdfPath = managedArtifact(pdf.details.path);
    assert.equal(fs.readFileSync(pdfPath).subarray(0, 4).toString(), '%PDF');
    await request(desktopRun, {
      action: 'act',
      request: {
        targetId: desktopTarget,
        kind: 'evaluate',
        fn: '() => { const a = document.createElement("a"); a.id="main-download"; a.href="/download"; a.download="synthetic-download.txt"; a.textContent="Download fixture"; document.body.prepend(a); return true; }',
      },
    });
    const download = await request(desktopRun, {
      action: 'act',
      request: { targetId: desktopTarget, kind: 'click', selector: '#main-download' },
    });
    const downloadPath = managedArtifact(download.details.downloads[0].path);
    assert.equal(fs.readFileSync(downloadPath, 'utf8'), 'synthetic main-path download');
    integration.artifacts = { pdf: pdfPath, download: downloadPath };
    checked(
      'Main PDF and click-triggered download persist real artifacts inside the trusted workspace',
    );

    const cronOpen = await request(cronRun, { action: 'open', url });
    const cronGuest = guestsByTarget.get(cronOpen.targetId);
    assert.equal(cronOpen.headless, true);
    assert.equal(
      implementation.isSameBrowserSession(cronGuest.session, foreground.browserSession),
      true,
    );
    assert.equal(cronGuest.session.storagePath, foreground.browserSession.storagePath);
    const cronScope = integration.executions.at(-1).scope;
    assert.equal(cronScope.headlessOnly, true);
    assert.match(cronScope.sessionId, /^browser-run:[a-f0-9]{64}$/u);
    integration.cronFirstViewport = imageResult(
      await request(cronRun, { action: 'screenshot', targetId: cronOpen.targetId }),
      'main-cron',
    );
    assert.deepEqual(integration.cronFirstViewport, { width: 1280, height: 800 });
    integration.profileAfterCronAdmission = await foreground.profileAlive();
    await request(cronRun, {
      action: 'act',
      request: {
        targetId: cronOpen.targetId,
        kind: 'type',
        selector: '#text',
        text: '定时任务 Main',
        submit: true,
      },
    });
    assert.deepEqual(await read(cronGuest, 'fixture.submissions'), ['定时任务 Main']);
    const cronFalse = begin(cronRun, { action: 'open', url, headless: false });
    assert.equal((await bounded(cronFalse.response, 'cron visible rejection')).ok, false);
    sharedProfile.assertLogin(
      await evaluate(cronRun, cronOpen.targetId, sharedProfile.stateExpression),
      'sidebar-one',
    );
    checked(
      'Main synthetic cron forces omitted headless true, shares sidebar login, returns a screenshot and rejects visible mode',
    );

    await foreground.read(sharedProfile.loginExpression('sidebar-two'));
    sharedProfile.assertLogin(
      await evaluate(desktopRun, desktopTarget, sharedProfile.stateExpression),
      'sidebar-two',
    );
    sharedProfile.assertLogin(
      await evaluate(cronRun, cronOpen.targetId, sharedProfile.stateExpression),
      'sidebar-two',
    );
    await foreground.read(sharedProfile.logoutExpression);
    sharedProfile.assertLogin(
      await evaluate(desktopRun, desktopTarget, sharedProfile.stateExpression),
      null,
    );
    sharedProfile.assertLogin(
      await evaluate(cronRun, cronOpen.targetId, sharedProfile.stateExpression),
      null,
    );
    await foreground.read(sharedProfile.loginExpression('sidebar-three'));
    sharedProfile.assertLogin(
      await evaluate(cronRun, cronOpen.targetId, sharedProfile.stateExpression),
      'sidebar-three',
    );
    await evaluate(cronRun, cronOpen.targetId, sharedProfile.loginExpression('headless-updated'));
    sharedProfile.assertLogin(
      await foreground.read(sharedProfile.stateExpression),
      'headless-updated',
    );
    sharedProfile.assertLogin(
      await evaluate(desktopRun, desktopTarget, sharedProfile.stateExpression),
      'headless-updated',
    );
    const sidebarState = await foreground.read(sharedProfile.stateExpression);
    assert.equal(sidebarState.sessionStorage, 'sidebar-only');
    assert.equal(sidebarState.pageMemory, 'sidebar-only');
    integration.sharedLogin.liveUpdates = [
      'sidebar-login',
      'sidebar-logout',
      'sidebar-relogin',
      'background-login',
    ];
    checked(
      'existing ordinary and cron pages observe sidebar login/logout on their next real Main request; background authentication updates are immediately visible in the webview',
    );

    integration.profileIsolation = [];
    for (const profile of ['imported', 'synthetic-named']) {
      const isolatedOpen = await request(desktopRun, {
        action: 'open',
        url,
        profile,
        headless: true,
      });
      const isolatedGuest = guestsByTarget.get(isolatedOpen.targetId);
      assert.equal(
        implementation.isSameBrowserSession(isolatedGuest.session, foreground.browserSession),
        false,
      );
      assert.notEqual(isolatedGuest.session.storagePath, foreground.browserSession.storagePath);
      sharedProfile.assertLogin(
        await evaluate(desktopRun, isolatedOpen.targetId, sharedProfile.stateExpression, profile),
        null,
      );
      await evaluate(
        desktopRun,
        isolatedOpen.targetId,
        sharedProfile.loginExpression(`${profile}-only`),
        profile,
      );
      sharedProfile.assertLogin(
        await evaluate(desktopRun, isolatedOpen.targetId, sharedProfile.stateExpression, profile),
        `${profile}-only`,
      );
      sharedProfile.assertLogin(
        await foreground.read(sharedProfile.stateExpression),
        'headless-updated',
      );
      integration.profileIsolation.push({
        profile,
        storagePath: isolatedGuest.session.storagePath,
      });
      await request(desktopRun, { action: 'close', targetId: isolatedOpen.targetId, profile });
      await until(() => isolatedGuest.isDestroyed(), `${profile} page destruction`);
    }
    checked(
      'Main imported and synthetic named profiles use distinct native Sessions and independent cookie/localStorage/IndexedDB state',
    );

    await foreground.permission();
    await foreground.download();
    const permissionsBeforeBackground = report.foreground.permissions.length;
    const deniedPermission = await evaluate(
      cronRun,
      cronOpen.targetId,
      `new Promise(resolve=>navigator.geolocation.getCurrentPosition(
      ()=>resolve('unexpected-granted'),error=>resolve(error.code===1?'denied':String(error.code)),{timeout:3000}))`,
    );
    assert.equal(deniedPermission, 'denied');
    assert.equal(
      report.foreground.permissions.length,
      permissionsBeforeBackground,
      'Background permission reached the foreground UI delegate',
    );
    const foregroundDownloadsBefore = report.foreground.downloads.length;
    let downloadObservation;
    const unclaimedDownload = new Promise(resolve => {
      downloadObservation = (_event, item, origin) => {
        if (origin?.id !== cronGuest.id) return;
        const value = { guestId: origin.id, state: item.getState(), path: item.getSavePath() };
        integration.unclaimedDownload = value;
        item.once('done', (_done, state) => {
          value.state = state;
          resolve(value);
        });
        if (value.state === 'cancelled') resolve(value);
      };
      cronGuest.session.on('will-download', downloadObservation);
    });
    try {
      cronGuest.downloadURL(new URL('/download', url).href);
      assert.equal(
        (await bounded(unclaimedDownload, 'unclaimed background download denial')).state,
        'cancelled',
      );
      assert.ok(
        !integration.unclaimedDownload.path || !fs.existsSync(integration.unclaimedDownload.path),
      );
    } finally {
      cronGuest.session.removeListener('will-download', downloadObservation);
    }
    assert.equal(report.foreground.downloads.length, foregroundDownloadsBefore);
    checked(
      'shared policy preserves foreground permission/download delegates while denying background prompts and cancelling unclaimed background downloads',
    );

    const lateMainEffects = [];
    let released = false;
    // Observation only: every native command is forwarded unchanged. This
    // records privileged upload/dialog effects while a page timer races release.
    const nativeSend = desktopGuest.debugger.sendCommand.bind(desktopGuest.debugger);
    desktopGuest.debugger.sendCommand = (method, parameters, ...rest) => {
      if (released && ['DOM.setFileInputFiles', 'Page.handleJavaScriptDialog'].includes(method)) {
        lateMainEffects.push(method);
      }
      return nativeSend(method, parameters, ...rest);
    };
    await request(desktopRun, { action: 'upload', targetId: desktopTarget, paths: [uploadName] });
    const armedDialog = await request(desktopRun, {
      action: 'dialog',
      targetId: desktopTarget,
      accept: true,
      promptText: 'must-not-apply-after-release',
    });
    assert.equal(armedDialog.armed, true);
    await read(
      desktopGuest,
      `setTimeout(()=>{
      localStorage.setItem('synthetic-released-page-timer','unexpected');
      document.querySelector('#file').click();prompt('synthetic released page prompt');
    },500);true`,
    );

    const beforeCancel = integration.executions.length;
    const waiting = begin(desktopRun, {
      action: 'act',
      request: {
        targetId: desktopTarget,
        kind: 'wait',
        fn: '() => { const root=document.documentElement; root.dataset.mainWaitPolls=String((Number(root.dataset.mainWaitPolls)||0)+1); return false; }',
        timeoutMs: 10000,
      },
    });
    await until(() => integration.executions.length > beforeCancel, 'Main wait admission');
    await until(
      async () =>
        Number(await read(desktopGuest, 'document.documentElement.dataset.mainWaitPolls || 0')) > 0,
      'the real guest begins polling the Main wait condition',
    );
    const waitingExecution = integration.executions.at(-1);
    controller.handleEvent({
      event: CANCELLED,
      payload: {
        requestId: waiting.requestId,
        sessionKey: desktopRun.sessionKey,
        run: desktopRun,
        toolCallId: 'synthetic-wrong-tool-call',
      },
    });
    await until(
      async () =>
        Number(await read(desktopGuest, 'document.documentElement.dataset.mainWaitPolls || 0')) >=
        2,
      'a mismatched cancellation leaves the actual wait running',
    );
    assert.equal(waitingExecution.completed, false);
    released = true;
    controller.handleEvent({
      event: CANCELLED,
      payload: {
        requestId: waiting.requestId,
        sessionKey: desktopRun.sessionKey,
        run: desktopRun,
        toolCallId: waiting.event.payload.toolCallId,
      },
    });
    await until(() => waitingExecution.completed, 'Main cancellation drain');
    assert.equal(waitingExecution.aborted, true);
    assert.equal(
      responses.has(waiting.requestId),
      false,
      'Cancelled input produced a late resolve',
    );
    waiters.delete(waiting.requestId);

    release(desktopRun, 'revoked');
    await until(() => desktopGuest.isDestroyed(), 'revoked desktop guest destruction');
    assert.equal(
      cronGuest.isDestroyed(),
      false,
      'Revoking an ordinary run destroyed a sibling cron page',
    );
    sharedProfile.assertLogin(
      await evaluate(cronRun, cronOpen.targetId, sharedProfile.stateExpression),
      'headless-updated',
    );
    integration.profileAfterUserRelease = await foreground.profileAlive();
    await foreground.permission();
    await foreground.download();
    await new Promise(resolve => setTimeout(resolve, 550));
    assert.equal(
      await foreground.read('localStorage.getItem("synthetic-released-page-timer")'),
      null,
    );
    assert.equal(responses.has(waiting.requestId), false, 'Cancelled input resolved after cleanup');
    assert.deepEqual(lateMainEffects, []);
    integration.lateMainEffects = lateMainEffects;
    const releasedRequest = begin(desktopRun, { action: 'snapshot', targetId: desktopTarget });
    assert.equal((await bounded(releasedRequest.response, 'released run rejection')).ok, false);
    checked(
      'Main exact-call cancellation produces no late resolve; revoked page clears armed upload/dialog and page timers while the sidebar and sibling cron stay live',
    );

    release(cronRun, 'settled');
    await until(() => cronGuest.isDestroyed(), 'settled cron guest destruction');
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    integration.profileAfterCronRelease = await foreground.profileAlive();
    sharedProfile.assertLogin(
      await foreground.read(sharedProfile.stateExpression),
      'headless-updated',
    );
    checked(
      'settled cron release destroys only its page and preserves sidebar worker, CacheStorage and the existing profile connection',
    );

    const nextCronRun = {
      ...cronRun,
      sessionId: 'synthetic-native-cron-next',
      runId: 'synthetic-cron-next',
    };
    const nextOpen = await request(nextCronRun, { action: 'open', url });
    const nextGuest = guestsByTarget.get(nextOpen.targetId);
    assert.notEqual(nextGuest.id, cronGuest.id);
    assert.equal(
      implementation.isSameBrowserSession(nextGuest.session, foreground.browserSession),
      true,
    );
    const nextState = await evaluate(nextCronRun, nextOpen.targetId, sharedProfile.stateExpression);
    sharedProfile.assertLogin(nextState, 'headless-updated');
    assert.equal(nextState.sessionStorage, null);
    assert.equal(nextState.pageMemory, null);
    assert.equal(await read(nextGuest, 'globalThis.syntheticPageMemory ?? null'), null);
    assert.equal(
      await read(
        nextGuest,
        'navigator.serviceWorker.getRegistrations().then(registrations=>registrations.length)',
      ),
      1,
    );
    assert.equal(
      await read(nextGuest, "fetch('/profile-worker-value').then(response=>response.text())"),
      'synthetic-sidebar-worker',
    );
    release(cronRun, 'settled');
    assert.equal(nextGuest.isDestroyed(), false, 'An older release closed the next cron run');
    release(nextCronRun, 'settled');
    await until(() => nextGuest.isDestroyed(), 'next settled cron guest destruction');
    assert.equal(nextOpen.headless, true);
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    assert.deepEqual(integration.rendererCalls, []);
    integration.profileAfterAllTasks = await foreground.profileAlive();
    await foreground.permission();
    await foreground.download();
    checked(
      'next cron opens a fresh page in the same live sidebar profile; older releases cannot close it and foreground policies continue after all task pages close',
    );
  } finally {
    controller.revoke();
    await browser.stop();
    await until(
      () => BrowserWindow.getAllWindows().every(window => window.id === foreground.carrier.id),
      'all Main-owned windows are destroyed',
    );
    await foreground.close();
    waiters.clear();
  }
};
