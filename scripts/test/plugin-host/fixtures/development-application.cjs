const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { app, BrowserWindow } = require('electron');

const context = JSON.parse(fs.readFileSync(process.env.APP_PLUGIN_TEST_CONTEXT, 'utf8'));
const { repo, root, profile, origin, gatewayPort, resultFile, profileStore } = context;
const checks = [];
const completeBody = () => {
  try { process.send?.(context.bodyCompleteSignal); } catch { /* Close remains authoritative. */ }
};
const appRoot = context.appRoot ?? repo;
const runtimeProjection = context.runtimeProjection;
assert.equal(path.dirname(root), path.join(repo, '.work'));
assert.ok(path.basename(root).startsWith('app-plugin-hot-'));
assert.ok(Number.isInteger(gatewayPort) && gatewayPort > 1024 && gatewayPort <= 65535);
assert.equal(path.resolve(appRoot), runtimeProjection ? path.join(root, 'application') : repo);
if (runtimeProjection) {
  assert.equal(fs.realpathSync(path.join(appRoot, 'vendor/openclaw-runtime/current')),
    fs.realpathSync(path.join(root, 'runtime')));
  assert.equal(path.resolve(runtimeProjection.runtimeRoot), path.join(root, 'runtime'));
}
const children = [];
let nativeOutput = '';
const spawn = childProcess.spawn;
childProcess.spawn = function (entry, args, ...rest) {
  const gatewayEntry = args?.find(value => /gateway-launcher\.cjs|gateway-bundle\.mjs/u.test(value));
  if (gatewayEntry)
    assert.equal(args[args.indexOf('--port') + 1], String(gatewayPort),
      'Gateway must use the private reserved port');
  if (gatewayEntry && runtimeProjection)
    assert.equal(path.dirname(fs.realpathSync(gatewayEntry)),
      fs.realpathSync(runtimeProjection.runtimeRoot), 'Gateway code belongs to the private runtime');
  const child = Reflect.apply(spawn, this, [entry, args, ...rest]);
  if (args?.some(value => /gateway-launcher\.cjs|gateway-bundle\.mjs/u.test(value))) {
    children.push(child);
    for (const stream of [child.stdout, child.stderr])
      stream?.on('data', data => {
        nativeOutput += data;
      });
  }
  return child;
};
try {
  app.setAppPath(appRoot);
  app.setPath('userData', profile);
  assert.equal(path.resolve(profileStore), path.join(root, 'profile-store.cjs'));
  const { SqliteStore, classifyInstallation } = require(profileStore);
  const seededStore = SqliteStore.create(profile);
  // A chosen language avoids unrelated first-language config writes during boot.
  seededStore.set('app_config', { language: 'zh', language_initialized: true });
  seededStore.close();
  assert.equal(classifyInstallation(profile).route, 'normal');
  app.disableHardwareAcceleration();
  app.on('browser-window-created', (_event, window) => {
    window.webContents.setBackgroundThrottling(false);
    window.on('show', () => window.hide());
  });
  require(path.join(repo, 'dist-electron/main.js'));
} catch (error) {
  fs.writeFileSync(resultFile, JSON.stringify({ success: false, checks, phase: 'startup',
    error: error?.stack ?? String(error) }));
  completeBody();
  app.exit(1);
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (name, details = {}) => {
  checks.push(name);
  process.send?.({ type: 'app-plugin-test-check', name, ...details });
};
const assertGatewayOwner = async pid => {
  const script = `Get-NetTCPConnection -LocalPort ${gatewayPort} -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique`;
  const owners = await new Promise((resolve, reject) => {
    childProcess.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
        if (error) reject(error);
        else resolve([...new Set(stdout.trim().split(/\s+/u).filter(Boolean).map(Number))]);
      });
  });
  assert.deepEqual(owners, [pid], 'The private listening socket belongs to this probe Gateway');
};

(async () => {
  try {
    let window;
    let readiness;
    let deadline = Date.now() + 150_000;
    while (Date.now() < deadline) {
      const candidates = BrowserWindow.getAllWindows().filter(value =>
        value.webContents.getURL().startsWith(origin),
      );
      for (const candidate of candidates) {
        try {
          readiness = await candidate.webContents.executeJavaScript(`(async()=>{
            const bridge=window.electron;
            if(!bridge?.initialization?.getState)return {ready:false};
            const initialization=await bridge.initialization.getState();
            if(bridge.initialization.isTransientWindow!==false||!bridge.appPlugins)
              return {ready:false,initialization};
            if(initialization.phase!=='ready'||document.querySelector('.initialization-overlay')
              ||!document.querySelector('button[aria-label]'))return {ready:false,initialization};
            const snapshots=await bridge.appPlugins.snapshot();
            return {initialization,snapshots,ready:
              ['agent-team','swarm-workflow'].every(id=>snapshots.some(item=>item.id===id))};
          })()`);
        } catch {
          /* Navigation still in progress. */
          continue;
        }
        if (readiness.initialization?.phase === 'failed')
          throw new Error(`Application initialization failed: ${JSON.stringify(readiness.initialization)}`);
        if (readiness.ready) { window = candidate; break; }
      }
      if (window) break;
      await delay(100);
    }
    assert.ok(window, `Real ready application window: ${JSON.stringify(readiness)}`);
    const evaluate = code => window.webContents.executeJavaScript(code);
    const discovered = await evaluate('window.electron.appPlugins.snapshot()');
    assert.deepEqual(
      discovered.map(({ id }) => id).sort(),
      ['agent-team', 'swarm-workflow'],
      'Main discovers both companions after the product store is available',
    );
    check('startup-discovers-both-companions');
    const read = () =>
      evaluate(`(async()=>{
      const snapshots=await window.electron.appPlugins.snapshot();
      const {appBrowserRegistry:r}=await import('/features/plugins/app/runtime.tsx');
      return {snapshots,views:r.getViews().map(({pluginId,id,slot})=>({pluginId,id,slot})),
        modes:r.getModes().map(({pluginId,id})=>({pluginId,id})),
        status:(await window.electron.openclaw.engine.getStatus()).status};
    })()`);
    const expected = new Map([
      ['agent-team', true],
      ['swarm-workflow', true],
    ]);
    const requiredViews = new Map([
      ['agent-team', [
        ['session-observer', 'application.page'], ['session-details', 'session.details'],
        ['page', 'application.page'], ['history', 'plugin.history'], ['team', 'workspace.tab'],
        ['team-summary', 'session.summary'], ['settings', 'plugin.settings'],
      ]],
      ['swarm-workflow', [
        ['workflow-observer', 'application.page'], ['workflow', 'workspace.tab'],
        ['workflow-summary', 'session.summary'],
      ]],
    ]);
    const requiredModes = new Map([['agent-team', ['group', 'task']], ['swarm-workflow', ['auto']]]);
    const assertContributions = state => {
      const views = [];
      const modes = [];
      for (const [pluginId, enabled] of expected) {
        const snapshot = state.snapshots.find(item => item.id === pluginId);
        assert.ok(snapshot, `Current Main snapshot exists: ${pluginId}`);
        // Main only publishes active after its Native receipt matches the owned PID.
        assert.equal(snapshot.state, enabled ? 'active' : 'cleanup');
        for (const [id, slot] of requiredViews.get(pluginId)) {
          assert.ok(snapshot.slots.includes(slot), `Required view slot is declared: ${pluginId}/${id}/${slot}`);
          if (enabled) views.push(`${pluginId}/${id}/${slot}`);
        }
        assert.ok(snapshot.slots.includes('composer.mode'));
        if (enabled) modes.push(...requiredModes.get(pluginId).map(id => `${pluginId}/${id}`));
      }
      assert.deepEqual(state.views.map(({ pluginId, id, slot }) => `${pluginId}/${id}/${slot}`).sort(),
        views.sort(), 'Every current plugin view is registered in its owning declared slot');
      assert.deepEqual(state.modes.map(({ pluginId, id }) => `${pluginId}/${id}`).sort(), modes.sort(),
        'Every current composer mode is registered');
    };
    const settled = async () => {
      const until = Date.now() + 150_000;
      let state;
      while (Date.now() < until) {
        state = await read();
        if (
          state.status?.phase === 'running' &&
          [...expected].every(
            ([id, enabled]) => state.modes.some(mode => mode.pluginId === id) === enabled,
          )
        )
          return state;
        await delay(200);
      }
      throw new Error('Application contributions did not converge: ' + JSON.stringify(state));
    };
    let state = await settled();
    if (runtimeProjection) {
      assert.equal(state.status.version, runtimeProjection.runtimeVersion,
        'Real Main reports the explicitly selected prepared runtime version');
      check('isolated-prepared-runtime', { version: state.status.version,
        runtimeRoot: runtimeProjection.runtimeRoot });
    }
    assertContributions(state);
    const baseline = children.map(child => child.pid);
    assert.equal(baseline.length, 1);
    await assertGatewayOwner(baseline[0]);
    check('private-gateway-owner', { gatewayPort, gatewayPid: baseline[0] });
    check('actual-main-preload-vite-browser-startup', { views: state.views.length, modes: state.modes.length });
    const clickLabel = async label => {
      await waitFor(
        `(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===${JSON.stringify(label)}&&b.getBoundingClientRect().width>0&&b.getBoundingClientRect().height>0);if(!button)return false;button.scrollIntoView({block:'center'});const rect=button.getBoundingClientRect();const top=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);return !!top&&button.contains(top);})()`,
        `Button did not become clickable: ${label}`,
      );
      return evaluate(
        `(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===${JSON.stringify(label)}&&b.getBoundingClientRect().width>0&&b.getBoundingClientRect().height>0);if(!button)throw Error('Missing visible button: '+${JSON.stringify(label)});button.scrollIntoView({block:'center'});const rect=button.getBoundingClientRect();const top=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);if(!top||!button.contains(top))throw Error('Button is obstructed: '+${JSON.stringify(label)});button.click();return true;})()`,
      );
    };
    const labels = await evaluate(
      `(async()=>{const{i18nService:t}=await import('/services/i18n.ts');return{settings:t.t('agentTeamSettings'),historyAction:t.t('teamAllRecords'),historyDialog:t.t('teamRecords'),plugins:t.t('plugins'),home:t.t('sidebarHome'),features:t.t('composerFeatures'),team:t.t('teamTitle'),task:t.t('teamTask'),group:t.t('teamGroup'),workflow:t.t('swarmWorkflowTitle')};})()`,
    );
    const waitFor = async (expression, description) => {
      const until = Date.now() + 30_000;
      while (Date.now() < until) {
        if (await evaluate(expression)) return;
        await delay(100);
      }
      throw new Error(description);
    };
    const visibleButton = label =>
      `!![...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===${JSON.stringify(label)}&&b.getBoundingClientRect().width>0&&b.getBoundingClientRect().height>0)`;
    const escape = () =>
      evaluate(
        `(document.querySelector('[role="dialog"]') ?? document).dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`,
      );
    const noDialog = `!document.querySelector('[role="dialog"]')`;
    const actionLabel = kind => labels[kind === 'history' ? 'historyAction' : kind];
    const dialog = kind =>
      `!![...document.querySelectorAll('[role="dialog"] h2')].find(h=>h.innerText===${JSON.stringify(labels[kind === 'history' ? 'historyDialog' : kind])}&&h.getBoundingClientRect().width>0&&h.getBoundingClientRect().height>0)`;
    const openDialog = async kind => {
      await waitFor(visibleButton(actionLabel(kind)), `Missing visible ${kind} action`);
      await clickLabel(actionLabel(kind));
      await waitFor(dialog(kind), `The real ${kind} dialog did not open`);
      check('real-extension-dialog', { kind });
    };
    const closeDialog = async () => {
      await escape();
      await waitFor(noDialog, 'Plugin dialog did not close');
    };
    const showPlugins = async () => {
      await clickLabel(labels.plugins);
      await waitFor(
        `!![...document.querySelectorAll('article h3')].find(h=>h.innerText==='Agent Team')`,
        'Plugin cards did not render',
      );
      const collapsed = await evaluate(`
        [...document.querySelectorAll('button[aria-expanded="false"]')]
          .filter(button=>button.parentElement?.tagName==='SECTION'&&button.getBoundingClientRect().width>0)
          .map(button=>button.getAttribute('aria-label')).filter(Boolean)
      `);
      for (const label of collapsed) await clickLabel(label);
      await waitFor(
        `!![...document.querySelectorAll('article h3')].find(h=>h.innerText==='Agent Team'&&h.getBoundingClientRect().width>0)`,
        'Agent Team card did not become visible',
      );
      for (const kind of ['settings', 'history'])
        await waitFor(
          `(${visibleButton(actionLabel(kind))})===${expected.get('agent-team')}`,
          `Plugin ${kind} action did not settle`,
        );
    };
    const verifyComposerMenu = async () => {
      await clickLabel(labels.home);
      await waitFor(visibleButton(labels.features), 'Missing visible composer + trigger');
      await clickLabel(labels.features);
      await waitFor(
        `!![...document.querySelectorAll('[role="menu"]')].find(menu=>menu.getBoundingClientRect().width>0&&menu.getBoundingClientRect().height>0)`,
        'The real composer + menu did not open',
      );
      const entries = await evaluate(`
        [...document.querySelectorAll('[role="menu"] button')]
          .filter(button=>button.getBoundingClientRect().width>0&&button.getBoundingClientRect().height>0)
          .map(button=>button.getAttribute('aria-label'))
      `);
      assert.equal(entries.includes(labels.team), expected.get('agent-team'), 'Agent Team + entry');
      assert.equal(
        entries.includes(labels.workflow),
        expected.get('swarm-workflow'),
        'Workflow + entry',
      );
      if (expected.get('agent-team')) {
        await clickLabel(labels.team);
        await waitFor(visibleButton(labels.task), 'Missing task option in Agent Team submenu');
        await waitFor(visibleButton(labels.group), 'Missing group option in Agent Team submenu');
      }
      await escape();
      check('real-composer-menu', {
        enabled: Object.fromEntries(expected),
        entries,
      });
    };
    await verifyComposerMenu();
    await showPlugins();
    for (const kind of ['settings', 'history']) {
      await openDialog(kind);
      await closeDialog();
    }
    for (const [id, enabled, heldDialog] of [
      ['agent-team', false, 'history'],
      ['swarm-workflow', false],
      ['agent-team', true],
      ['swarm-workflow', true],
      ['agent-team', false, 'settings'],
      ['agent-team', true],
    ]) {
      if (heldDialog) await openDialog(heldDialog);
      const result = await evaluate(
        `window.electron.extensions.setEnabled(${JSON.stringify({ extensionId: id, enabled })})`,
      );
      assert.equal(result.success, true, JSON.stringify(result));
      expected.set(id, enabled);
      state = await settled();
      assertContributions(state);
      // Assert before any navigation, since navigation itself dismisses Team history.
      await waitFor(noDialog, 'A retired plugin dialog remained open or reopened in a new epoch');
      if (heldDialog) check('open-dialog-withdrawn', { kind: heldDialog });
      if (id === 'agent-team') {
        assert.equal(
          state.views.some(view => view.pluginId === id && view.slot === 'plugin.settings'),
          enabled,
        );
        assert.equal(
          state.views.some(view => view.pluginId === id && view.slot === 'plugin.history'),
          enabled,
        );
        assert.equal(
          await evaluate(
            `!![...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===${JSON.stringify(labels.settings)})`,
          ),
          enabled,
        );
        assert.equal(await evaluate(visibleButton(labels.historyAction)), enabled, 'History card action');
      }
      await verifyComposerMenu();
      await showPlugins();
      await waitFor(noDialog, 'Plugin navigation reopened an old dialog');
      if (id === 'agent-team' && enabled) {
        for (const kind of ['settings', 'history']) {
          await openDialog(kind);
          await closeDialog();
        }
        check('reenabled-card-dialogs-work');
      }
      assert.deepEqual(
        children.map(child => child.pid),
        baseline,
      );
      assert.equal(children[0].exitCode, null);
      await assertGatewayOwner(baseline[0]);
      assert.equal(
        (nativeOutput.match(/\[gateway\] ready\s*(?:\r?\n|$)/gu) ?? []).length,
        1,
        'No in-process Gateway restart',
      );
      check('hot-toggle', {
        id,
        enabled,
        gatewayPid: baseline[0],
        gatewayPort,
        ...(runtimeProjection ? { runtimeVersion: runtimeProjection.runtimeVersion,
          runtimeRoot: runtimeProjection.runtimeRoot } : {}),
        gatewayStarts: children.length,
      });
    }
    fs.writeFileSync(
      resultFile,
      JSON.stringify({
        success: true,
        checks,
        gatewayStarts: 1,
        gatewayPid: baseline[0],
        gatewayPort,
        ...(runtimeProjection ? { runtimeVersion: runtimeProjection.runtimeVersion,
          runtimeRoot: runtimeProjection.runtimeRoot } : {}),
      }),
    );
  } catch (error) {
    fs.writeFileSync(resultFile, JSON.stringify({ success: false, checks, error: error.stack }));
    const window = BrowserWindow.getAllWindows().find(value =>
      value.webContents.getURL().startsWith(origin),
    );
    if (window) {
      await Promise.allSettled([
        window.webContents.capturePage().then(image =>
          fs.writeFileSync(path.join(root, 'failure.png'), image.toPNG())),
        window.webContents.executeJavaScript(`({text:document.body.innerText,
          buttons:[...document.querySelectorAll('button')].map(button=>{
            const rect=button.getBoundingClientRect(), style=getComputedStyle(button);
            const hit=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);
            return {text:button.innerText,label:button.getAttribute('aria-label'),
              rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},
              display:style.display,visibility:style.visibility,opacity:style.opacity,
              hitTest:!!hit&&button.contains(hit)};
          })})`).then(dom => fs.writeFileSync(path.join(root, 'failure-dom.json'), JSON.stringify(dom))),
      ]);
    }
  } finally {
    if (fs.existsSync(resultFile)) completeBody();
    app.quit();
  }
})();
