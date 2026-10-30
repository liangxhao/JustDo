'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BrowserWindow, ipcMain, nativeImage, webContents } = require('electron');

// Real Chromium webviews, production Main actions and real sandboxed IPC. The
// Native admission and React sidebar are synthetic here; co-located Renderer
// tests verify the real selection, mounting and interaction-mask implementation.
exports.run = async ({ implementation, output, runRoot, url, report, checked, bounded, until }) => {
  const { BrowserIpc } = implementation;
  const observations = (report.sidebarTabs = {
    boundary:
      'real webviews, production Main and DOM focus helper; synthetic Native ingress, sidebar composition and initial owner-document focus',
    commands: [],
    commandFocus: [],
    screenshots: [],
    focusRequests: [],
    nativeKeyEvents: [],
    hoverDelivery: [],
    guestFocusEvents: [],
    nativeMenus: [],
    inputProtocol: [],
    selectionChecks: [],
  });
  const ownerSessionId = 'synthetic-sidebar-chat-A';
  const workspace = path.join(runRoot, 'synthetic-sidebar-workspace');
  fs.mkdirSync(workspace);
  const resource = agent => `synthetic-sidebar-member-${agent}`;
  const preload = path.join(output, 'sidebar-preload.cjs');
  const inbound = [
    BrowserIpc.AgentEnsureTab,
    BrowserIpc.AgentFocusTab,
    BrowserIpc.AgentCloseTab,
    BrowserIpc.AgentInteractionState,
  ];
  const outbound = [
    BrowserIpc.AgentRegisterTab,
    BrowserIpc.AgentUnregisterTab,
    BrowserIpc.AgentInteractionReady,
    BrowserIpc.UserInteractionState,
  ];
  fs.writeFileSync(
    preload,
    `const {contextBridge,ipcRenderer}=require('electron');
    const inbound=${JSON.stringify(inbound)},outbound=${JSON.stringify(outbound)};
    contextBridge.exposeInMainWorld('sidebarProbe',{
      onEvent:callback=>{for(const channel of inbound)ipcRenderer.on(channel,(_event,value)=>callback(channel,value));},
      send:(channel,value)=>{if(!outbound.includes(channel))throw new Error('Unexpected fixture IPC');ipcRenderer.send(channel,value);}
    });`,
  );
  const carrier = new BrowserWindow({
    show: false,
    focusable: false,
    skipTaskbar: true,
    width: 1280,
    height: 800,
    webPreferences: {
      preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: true,
      backgroundThrottling: false,
    },
  });
  carrier.webContents.on('will-attach-webview', (_event, preferences) => {
    delete preferences.preload;
    preferences.nodeIntegration = false;
    preferences.nodeIntegrationInSubFrames = false;
    preferences.contextIsolation = true;
    preferences.sandbox = true;
    preferences.webSecurity = true;
    preferences.webviewTag = false;
    preferences.backgroundThrottling = false;
  });
  carrier.webContents.on('did-attach-webview', (_event, guest) => {
    guest.setWindowOpenHandler(() => ({ action: 'deny' }));
    for (const name of ['focus', 'blur'])
      guest.on(name, () => {
        observations.guestFocusEvents.push({
          name,
          guestId: guest.id,
          command: observations.commands.at(-1),
        });
      });
    const dispatch = guest.debugger.sendCommand.bind(guest.debugger);
    guest.debugger.sendCommand = async (method, params, ...rest) => {
      const entry = method.startsWith('Input.')
        ? {
            guestId: guest.id,
            method,
            type: params?.type,
            key: params?.key,
            buttons: params?.buttons,
            x: params?.x,
            y: params?.y,
            completed: false,
          }
        : null;
      if (entry) observations.inputProtocol.push(entry);
      try {
        return await dispatch(method, params, ...rest);
      } finally {
        if (entry) entry.completed = true;
      }
    };
    guest.on('before-input-event', (event, input) => {
      observations.nativeKeyEvents.push({
        guestId: guest.id,
        type: input.type,
        key: input.key,
        control: input.control,
        shift: input.shift,
        alt: input.alt,
        meta: input.meta,
        automating: bridge.isAutomatingGuest(guest.id),
      });
      // Observe the same native interception path as application shortcuts,
      // while preventing Chromium's default print dialog in this private UI.
      if (input.control && input.key.toLowerCase() === 'p') event.preventDefault();
    });
    guest.on('context-menu', () =>
      observations.nativeMenus.push({
        guestId: guest.id,
        automating: bridge.isAutomatingGuest(guest.id),
      }),
    );
  });
  const bridge = new implementation.BrowserAgentBridge(
    (channel, value) => {
      if (channel === BrowserIpc.AgentFocusTab) observations.focusRequests.push(value);
      carrier.webContents.send(channel, value);
    },
    id => id === carrier.webContents.id,
    () => workspace,
    true,
  );
  const focusImplementation = fs.readFileSync(
    path.join(output, 'sidebar-focus.browser.js'),
    'utf8',
  );
  const script = `${focusImplementation}\nconst ipc=${JSON.stringify(BrowserIpc)},partition=${JSON.stringify(implementation.browserPartitionForProfile('embedded'))};
    const state=window.fixture={active:'X',tabs:[],busy:[],focusRequests:0,focusEvents:[]};
    const focusBinding=BrowserPanelFocus.retainBrowserPanelFocus(document,document);
    const panel=document.getElementById('browser-panel'),workspace=document.getElementById('workspace-content'),x=document.getElementById('X');
    function show(target){
      state.active=target;
      for(const container of [workspace,panel]){
        container.style.visibility='visible';container.style.opacity=target==='X'?'0':'1';
        container.style.pointerEvents=target==='X'?'none':'auto';container.inert=target==='X';
      }
      x.style.display=target==='X'?'block':'none';
      for(const tab of state.tabs){
        const view=document.getElementById(tab.targetId),selected=tab.targetId===target;
        view.style.opacity=selected?'1':'0';view.style.pointerEvents=selected?'auto':'none';
        view.inert=!selected;view.tabIndex=selected?0:-1;view.setAttribute('aria-hidden',String(!selected));
      }
    }
    window.selectSidebarTab=target=>{show(target);document.getElementById(target==='X'?'user-draft':'tab-selection-anchor').focus();};
    window.sidebarProbe.onEvent((channel,value)=>{
      if(channel===ipc.AgentInteractionState){
        state.busy=state.busy.filter(item=>item.operationId!==value.operationId);
        if(value.busy){state.busy.push(value);focusBinding.refresh();window.sidebarProbe.send(ipc.AgentInteractionReady,value);}
        else focusBinding.refresh();
      }else if(channel===ipc.AgentEnsureTab){
        if(state.tabs.some(tab=>tab.targetId===value.targetId))return;
        const tab={sessionId:value.sessionId,targetId:value.targetId,profile:value.profile||'embedded'};
        const view=document.createElement('webview');view.id=tab.targetId;view.setAttribute('partition',partition);
        view.style='position:absolute;inset:0;width:100%;height:100%;opacity:0;pointer-events:none';
        view.inert=true;view.tabIndex=-1;view.setAttribute('aria-hidden','true');
        focusBinding.registerGuest(view,()=>state.active===tab.targetId&&!state.busy.some(item=>
          item.sessionId===tab.sessionId&&(item.targetId===tab.targetId||item.targetId===${JSON.stringify(implementation.BROWSER_AGENT_PANEL_TARGET_ID)})));
        for(const name of ['did-focus','did-blur','focus','blur'])view.addEventListener(name,()=>{
          state.focusEvents.push({name,target:tab.targetId,active:document.activeElement?.id});
        });
        view.addEventListener('dom-ready',()=>{
          tab.webContentsId=view.getWebContentsId();window.sidebarProbe.send(ipc.AgentRegisterTab,tab);
        });
        state.tabs.push(tab);view.src=value.url||'about:blank';panel.append(view);
      }else if(channel===ipc.AgentFocusTab){state.focusRequests++;show(value.targetId);}
      else if(channel===ipc.AgentCloseTab){
        const tab=state.tabs.find(tab=>tab.targetId===value.targetId&&tab.sessionId===value.sessionId);
        if(!tab)return;window.sidebarProbe.send(ipc.AgentUnregisterTab,tab);focusBinding.unregisterGuest(document.getElementById(tab.targetId));document.getElementById(tab.targetId).remove();
        state.tabs=state.tabs.filter(item=>item!==tab);if(state.active===tab.targetId)show('X');
      }
    });
    for(const name of ['focus','focusin'])document.addEventListener(name,event=>{
      const id=document.activeElement?.id;state.focusEvents.push({name,target:event.target?.id,active:id});
    },true);
    window.selectSidebarTab('X');`;
  const markup = `<!doctype html><meta charset="UTF-8"><style>body{margin:0}#workspace-content{position:absolute;inset:0;width:1200px;height:750px;opacity:0;pointer-events:none}#browser-panel{position:absolute;inset:0;width:100%;height:100%;display:flex;opacity:0;pointer-events:none}#X{padding:20px}</style>
    <button id="tab-selection-anchor" style="position:relative;z-index:2">Selected sidebar Tab</button>
    <section id="X"><h1>Discussion X</h1><input id="user-draft" value="keep user draft"></section>
    <section id="workspace-content"><section id="browser-panel"></section></section><script>${script}</script>`;
  const read = expression =>
    bounded(carrier.webContents.executeJavaScript(expression), 'sidebar fixture observation');
  const guestFor = async targetId => {
    const id = await read(
      `window.fixture.tabs.find(tab=>tab.targetId===${JSON.stringify(targetId)})?.webContentsId`,
    );
    const guest = webContents.fromId(id);
    assert.ok(guest && !guest.isDestroyed(), 'Missing real sidebar webview');
    assert.equal(guest.getType(), 'webview');
    return guest;
  };
  const scopeFor = agent => ({
    sessionId: resource(agent),
    ownerSessionId,
    runId: `synthetic-sidebar-run-${agent}`,
    workspaceDir: workspace,
    headlessOnly: false,
    allowLocalFiles: true,
  });
  const command = async (agent, value) => {
    observations.commands.push({ agent, action: value.action, kind: value.request?.kind });
    const { targetId, ...remaining } = value;
    const input =
      value.action === 'act'
        ? { ...remaining, request: { ...value.request, ...(targetId ? { targetId } : {}) } }
        : value;
    try {
      const result = await bounded(
        bridge.executeCommand(
          `agent:fixture:sidebar:${agent}`,
          {
            ...input,
            sessionKey: `agent:fixture:sidebar:${agent}`,
          },
          undefined,
          scopeFor(agent),
        ),
        `sidebar ${agent} ${value.action} ${value.request?.kind ?? ''}`,
        12000,
      );
      const focusRecord = {
        agent,
        action: value.action,
        kind: value.request?.kind,
        ...(await read(
          `({focused:document.activeElement?.id,hasFocus:document.hasFocus(),focusEvents:fixture.focusEvents.length})`,
        )),
      };
      observations.commandFocus.push(focusRecord);
      const target = targetId ?? value.request?.targetId ?? result?.targetId;
      if (target && value.action !== 'close') {
        const tab = await read(`fixture.tabs.find(tab=>tab.targetId===${JSON.stringify(target)})`);
        const guest = tab?.webContentsId ? webContents.fromId(tab.webContentsId) : null;
        if (guest && !guest.isDestroyed())
          focusRecord.guest = await guest.executeJavaScript(`({
          active:document.activeElement?.id,hasFocus:document.hasFocus(),value:document.getElementById('text')?.value,
          keyUps:window.fixture?.keyUps,submissions:window.fixture?.submissions})`);
      }
      return result;
    } catch (error) {
      const tab = await read(
        `fixture.tabs.find(tab=>tab.sessionId===${JSON.stringify(resource(agent))})`,
      );
      const guest = tab?.webContentsId ? webContents.fromId(tab.webContentsId) : null;
      if (guest && !guest.isDestroyed()) {
        try {
          observations.failedCommandState = await bounded(
            guest.executeJavaScript(`({
          width:innerWidth,height:innerHeight,visibility:document.visibilityState,focused:document.hasFocus(),
          active:document.activeElement?.id,clicks:fixture.clicks,hovers:fixture.hovers,
          drags:fixture.drags,lastDrag:fixture.lastDrag,keyUps:fixture.keyUps,
          input:document.getElementById('text').value,submissions:fixture.submissions})`),
            'read-only failed sidebar command diagnostics',
            1000,
          );
        } catch (diagnosticError) {
          observations.failedCommandDiagnosticError = diagnosticError.message;
        }
      }
      throw error;
    }
  };
  const assertSelection = async (targetId, label, requireUserFocus = false) => {
    const snapshot = await read(`({active:fixture.active,focusRequests:fixture.focusRequests,
      focused:document.activeElement?.id,draft:document.getElementById('user-draft').value,
      panelDisplay:getComputedStyle(document.getElementById('browser-panel')).display,
      panelVisibility:getComputedStyle(document.getElementById('browser-panel')).visibility,
      focusEvents:fixture.focusEvents})`);
    observations.selectionChecks.push({ label, ...snapshot });
    assert.equal(snapshot.active, targetId, `${label}: selected sidebar Tab changed`);
    assert.equal(snapshot.focusRequests, 0, `${label}: Agent requested foreground selection`);
    assert.equal(snapshot.draft, 'keep user draft');
    if (requireUserFocus)
      assert.equal(snapshot.focused, 'user-draft', `${label}: user draft lost focus`);
    if (targetId !== 'X')
      assert.equal(
        snapshot.focused,
        'tab-selection-anchor',
        `${label}: user-selected Tab lost focus`,
      );
  };
  const screenshot = async (agent, targetId) => {
    const result = await command(agent, { action: 'screenshot', targetId, type: 'png' });
    const image = result.content?.find(item => item.type === 'image');
    assert.ok(image?.data, 'Hidden sidebar screenshot did not return an image');
    const decoded = nativeImage.createFromBuffer(Buffer.from(image.data, 'base64'));
    assert.equal(decoded.isEmpty(), false, 'Hidden sidebar screenshot is empty');
    const size = decoded.getSize();
    assert.ok(size.width > 100 && size.height > 100, 'Hidden sidebar viewport collapsed');
    const bitmap = decoded.toBitmap();
    const firstPixel = bitmap.readUInt32LE(0);
    let nonblank = false;
    for (let offset = 4; offset < bitmap.length; offset += 4) {
      if (bitmap.readUInt32LE(offset) !== firstPixel) {
        nonblank = true;
        break;
      }
    }
    assert.equal(nonblank, true, 'Hidden sidebar screenshot has no rendered page content');
    fs.writeFileSync(
      path.join(runRoot, `sidebar-${agent}-${observations.screenshots.length}.png`),
      decoded.toPNG(),
    );
    observations.screenshots.push({ agent, size });
  };
  try {
    bridge.registerIpc();
    await carrier.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(markup)}`);
    await until(() => read('Boolean(window.fixture)'), 'sidebar script initialization');
    // The fixture has no active OS window. Model only the owner's UI focus;
    // Agent guests never receive focus emulation or a replacement transport.
    carrier.webContents.debugger.attach('1.3');
    await carrier.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {
      enabled: true,
    });
    observations.rootUiFocus =
      'emulated active owner document; no OS window activation or Agent guest emulation';
    observations.initialRootFocus = await read(`(()=>{
      document.getElementById('user-draft').blur();window.selectSidebarTab('X');
      return {hasFocus:document.hasFocus(),active:document.activeElement?.id};})()`);
    assert.equal(observations.initialRootFocus.hasFocus, true);
    assert.equal(observations.initialRootFocus.active, 'user-draft');
    checked('fixture emulates an active owner document without showing or focusing an OS window');
    const [b, c] = await Promise.all([
      command('B', { action: 'open', url: `${url}?member=B` }),
      command('C', { action: 'open', url: `${url}?member=C` }),
    ]);
    await assertSelection('X', 'both pages opened behind discussion X', true);
    const guestB = await guestFor(b.targetId);
    const guestC = await guestFor(c.targetId);
    await until(() => !guestB.isLoading() && !guestC.isLoading(), 'two hidden webview documents');
    observations.initialLayouts = await Promise.all(
      [guestB, guestC].map(guest =>
        guest.executeJavaScript(`(()=>{const element=document.getElementById('click'),rect=element.getBoundingClientRect();
        return {width:innerWidth,height:innerHeight,visibility:document.visibilityState,focused:document.hasFocus(),
          click:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},hit:document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)?.id};})()`),
      ),
    );
    for (const [agent, tab, guest] of [
      ['B', b, guestB],
      ['C', c, guestC],
    ]) {
      const hoverStarted = Date.now();
      await command(agent, {
        action: 'act',
        targetId: tab.targetId,
        request: { kind: 'hover', selector: '#hover' },
      });
      const delivery = {
        agent,
        immediateCount: await guest.executeJavaScript('fixture.hovers'),
      };
      observations.hoverDelivery.push(delivery);
      // Native input is queued by sendInputEvent; a later executeJavaScript
      // round trip does not acknowledge that independent input IPC. Observe
      // this one input's actual effect under the existing fixture deadline.
      try {
        await until(async () => {
          delivery.observedCount = await guest.executeJavaScript('fixture.hovers');
          return delivery.observedCount >= 1;
        }, 'single hidden sidebar hover delivery');
      } finally {
        delivery.elapsedMs = Date.now() - hoverStarted;
      }
      await command(agent, {
        action: 'act',
        targetId: tab.targetId,
        request: { kind: 'click', selector: '#click' },
      });
      assert.equal(
        await guest.executeJavaScript('fixture.clicks'),
        1,
        'Hidden page did not receive its click',
      );
      await command(agent, {
        action: 'act',
        targetId: tab.targetId,
        request: { kind: 'type', selector: '#text', text: `member-${agent}` },
      });
      await command(agent, {
        action: 'act',
        targetId: tab.targetId,
        request: { kind: 'press', key: 'End' },
      });
      await command(agent, {
        action: 'act',
        targetId: tab.targetId,
        request: { kind: 'press', key: 'Shift+1' },
      });
      await command(agent, {
        action: 'act',
        targetId: tab.targetId,
        request: { kind: 'press', key: 'Enter' },
      });
      await command(agent, {
        action: 'act',
        targetId: tab.targetId,
        request: { kind: 'drag', startSelector: '#drag', endSelector: '#drop' },
      });
      const value = await guest.executeJavaScript(
        '({clicks:fixture.clicks,hovers:fixture.hovers,drags:fixture.drags.length,submissions:fixture.submissions})',
      );
      assert.equal(value.clicks, 1);
      assert.ok(value.hovers >= 1);
      assert.equal(value.drags, 1);
      assert.deepEqual(value.submissions, [`member-${agent}!`]);
      await screenshot(agent, tab.targetId);
      await command(agent, {
        action: 'act',
        targetId: tab.targetId,
        request: { kind: 'press', key: 'Control+P' },
      });
      await assertSelection('X', `${agent} input and capture behind discussion X`, true);
    }
    checked(
      'two real sidebar webviews complete hover, click, typing, native keys, drag and screenshot while discussion X and its draft retain selection and focus',
    );

    await Promise.all(
      [
        ['B', b],
        ['C', c],
      ].map(async ([agent, tab]) => {
        await command(agent, {
          action: 'act',
          targetId: tab.targetId,
          request: { kind: 'type', selector: '#text', text: `concurrent-${agent}?` },
        });
        for (const key of ['Control+A', 'ArrowRight', 'Backspace', 'Shift+1', 'Enter'])
          await command(agent, {
            action: 'act',
            targetId: tab.targetId,
            request: { kind: 'press', key },
          });
      }),
    );
    for (const [agent, guest] of [
      ['B', guestB],
      ['C', guestC],
    ]) {
      assert.deepEqual(await guest.executeJavaScript('fixture.submissions'), [
        `member-${agent}!`,
        `concurrent-${agent}!`,
      ]);
    }
    await assertSelection('X', 'concurrent B/C key input remains in the original targets', true);
    checked(
      'concurrent B and C type, edit and submit only their own form while the user keeps discussion X focus',
    );

    await read(`window.selectSidebarTab(${JSON.stringify(b.targetId)})`);
    await read(`document.getElementById(${JSON.stringify(b.targetId)}).focus();true`);
    assert.equal(
      await read('document.activeElement?.id'),
      b.targetId,
      'Fixture user did not focus idle B',
    );
    const focusedRun = command('B', {
      action: 'act',
      targetId: b.targetId,
      request: { kind: 'wait', timeMs: 500 },
    });
    void focusedRun.catch(() => undefined);
    await until(
      () => read(`fixture.busy.some(item=>item.sessionId===${JSON.stringify(resource('B'))})`),
      'B starts with an already-focused guest',
    );
    const duringOwnRun = await read(`(()=>{let element=document.activeElement;const chain=[];
      while(element){chain.push({id:element.id,tag:element.tagName,shadowRoot:Boolean(element.shadowRoot),
        nativeBlur:element.blur===HTMLElement.prototype.blur});element=element.shadowRoot?.activeElement;}
      return {active:fixture.active,focused:document.activeElement?.id,chain,busy:fixture.busy};})()`);
    observations.alreadyFocusedGuest = duringOwnRun;
    assert.equal(duringOwnRun.active, b.targetId, 'Starting B changed the selected Tab');
    assert.notEqual(duringOwnRun.focused, b.targetId, 'Busy B kept the user keyboard focus');
    await focusedRun;
    // A new explicit user selection supplies the current safe focus anchor.
    await read(`window.selectSidebarTab(${JSON.stringify(b.targetId)})`);
    // While C has a genuine pending operation, a visible peer must not inherit
    // C's resource lock. The production Renderer predicate is tested separately.
    const waiting = command('C', {
      action: 'act',
      targetId: c.targetId,
      request: { kind: 'wait', timeMs: 500 },
    });
    void waiting.catch(() => undefined);
    await until(
      () => read(`fixture.busy.some(item=>item.sessionId===${JSON.stringify(resource('C'))})`),
      'C interaction lock',
    );
    const visibleBusy = await read(
      `fixture.busy.filter(item=>item.sessionId===${JSON.stringify(resource('B'))})`,
    );
    assert.deepEqual(visibleBusy, [], 'C operation locked the visible peer resource');
    await waiting;
    await command('C', { action: 'focus', targetId: c.targetId });
    await assertSelection(b.targetId, 'explicit Agent focus remains logical');
    await command('C', {
      action: 'act',
      targetId: c.targetId,
      request: { kind: 'press', key: 'Control+P' },
    });
    observations.shortcutBeforeInput = observations.nativeKeyEvents.filter(
      event => event.guestId === guestC.id && event.control && event.key.toLowerCase() === 'p',
    );
    await command('C', { action: 'navigate', targetId: c.targetId, url: `${url}?member=C-next` });
    await command('C', {
      action: 'act',
      targetId: c.targetId,
      request: { kind: 'click', selector: '#click' },
    });
    assert.equal(await guestC.executeJavaScript('fixture.clicks'), 1);
    assert.equal(await guestB.executeJavaScript('fixture.clicks'), 1);
    await screenshot('C', c.targetId);
    await command('C', {
      action: 'act',
      targetId: c.targetId,
      request: { kind: 'click', selector: '#hover', button: 'right' },
    });
    assert.ok(
      observations.nativeMenus.some(event => event.guestId === guestC.id && event.automating),
      'Native context menu did not retain its exact automation lease',
    );
    assert.ok(
      observations.nativeKeyEvents.some(
        event => event.control && event.key.toLowerCase() === 'p' && event.automating,
      ),
      'Native shortcut did not retain its exact automation lease',
    );
    assert.ok(
      observations.nativeKeyEvents
        .filter(event => event.type === 'keyDown')
        .every(event => event.automating),
      'A native key-down escaped its exact automation lease',
    );
    await assertSelection(b.targetId, 'C navigation, input and capture while user watches B');
    await command('C', { action: 'close', targetId: c.targetId });
    await until(() => guestC.isDestroyed(), 'C close destroys only its own webview');
    assert.equal(guestB.isDestroyed(), false);
    await assertSelection(b.targetId, 'C closes without disturbing visible B');
    assert.deepEqual(observations.focusRequests, []);
    assert.deepEqual(
      observations.inputProtocol,
      [],
      'Sidebar tools must use the production native input path',
    );
    checked(
      'busy B relinquishes stale guest focus; user-selected B stays visible and unlocked while C operates its own real webview',
    );
  } finally {
    await bridge.stop();
    ipcMain.removeHandler(implementation.BrowserInterventionIpc);
    if (!carrier.isDestroyed()) carrier.destroy();
  }
};
