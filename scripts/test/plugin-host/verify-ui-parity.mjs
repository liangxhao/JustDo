// Real Chromium, real host menu/sidebar and separately built plugin CSS; no Gateway or user data.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from 'tailwindcss';

import { buildAppPlugin } from '../../plugins/build-app-plugins.mjs';

const require = createRequire(import.meta.url);
const repo = path.resolve(import.meta.dirname, '../../..');
const output = path.join(repo, 'build/plugin-ui-parity');
await mkdir(output, { recursive: true });
const ref = process.env.APP_PLUGIN_UI_BASELINE_REF ?? '594cc79da';
const baseline = execFileSync(
  'git',
  ['show', `${ref}:src/renderer/features/cowork/components/composer/AgentTeamSelector.tsx`],
  { cwd: repo, encoding: 'utf8' },
);
const ts = require('typescript');
const parsed = ts.createSourceFile(
  'baseline.tsx',
  baseline,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const factory = parsed.statements.find(
  node => ts.isFunctionDeclaration(node) && node.name?.text === 'buildAgentTeamFeature',
);
assert.ok(factory, 'Read the real pre-plugin menu factory');
const baselineModule = path.join(output, 'baseline.tsx');
await writeFile(
  baselineModule,
  `import { UserGroupIcon } from '@heroicons/react/24/outline';
import { i18nService } from '@/services/i18n';
const OpenClawExtensionId={AGENT_TEAM:'agent-team'};
const AGENT_TEAM_MODE={GROUP:'group',TASK:'task'};
${factory.getText(parsed)}\n`,
);

const artifacts = [];
for (const id of ['agent-team', 'swarm-workflow']) {
  const artifact = await buildAppPlugin(
    path.join(repo, 'plugins/extensions', id),
    path.join(output, 'artifacts'),
  );
  artifacts.push({
    ...artifact,
    manifest: JSON.parse(await readFile(path.join(artifact.root, 'app.artifact.json'), 'utf8'))
      .manifest,
  });
}
// The previous compiler emitted this one-layer value instead of the host's full shadow.
const shadowRule = '.shadow-elevated { --tw-shadow: 0 4px 12px rgba(0,0,0,0.1); }';
const runtime = path.join(repo, 'tests/plugin-host/ui-parity/runtime.tsx');
const harness = await build({
  entryPoints: [path.join(repo, 'tests/plugin-host/ui-parity/surface.tsx')],
  outfile: path.join(output, 'surface.js'),
  bundle: true,
  format: 'iife',
  tsconfig: path.join(repo, 'tsconfig.json'),
  metafile: true,
  plugins: [
    {
      name: 'isolated-ui-registry',
      setup(builder) {
        builder.onResolve(
          { filter: /^(?:\.\/runtime|@\/features\/plugins\/app\/runtime)$/ },
          args => {
            if (
              args.path.startsWith('@/') ||
              args.importer.replaceAll('\\', '/').includes('/features/plugins/app/')
            )
              return { path: runtime };
          },
        );
        builder.onResolve({ filter: /^ui-baseline-menu$/ }, () => ({ path: baselineModule }));
      },
    },
  ],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  loader: {
    '.woff': 'file',
    '.woff2': 'file',
    '.ttf': 'file',
    '.png': 'file',
    '.webp': 'file',
    '.md': 'text',
  },
  logOverride: { 'empty-import-meta': 'silent' },
  logLevel: 'silent',
});
const loadConfig = require('tailwindcss/loadConfig');
const config = loadConfig(path.join(repo, 'tailwind.config.js'));
const css = await postcss([
  tailwind({
    ...config,
    content: [
      path.join(repo, 'src/**/*.{ts,tsx,html}'),
      path.join(repo, 'tests/plugin-host/ui-parity/*.tsx'),
    ],
  }),
]).process(await readFile(path.join(repo, 'src/renderer/index.css'), 'utf8'), {
  from: path.join(repo, 'src/renderer/index.css'),
});
const hostStyles = await build({
  stdin: { contents: css.css, loader: 'css', resolveDir: path.join(repo, 'src/renderer') },
  bundle: true,
  outfile: path.join(output, 'host.css'),
  metafile: true,
  loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file', '.png': 'file', '.webp': 'file' },
  logLevel: 'silent',
});
const hostCss = await readFile(path.join(output, 'host.css'), 'utf8');
assert.ok(
  !hostCss.includes('.border-l-\\[3px\\]'),
  'Do not mask the plugin-only border with a host fixture utility',
);
assert.ok(
  !hostCss.includes('.aria-pressed\\:bg-primary-muted'),
  'Do not mask the plugin-only state with a host fixture utility',
);

const snapshots = artifacts.map(({ id, hash, manifest }) => ({
  ...manifest,
  id,
  hash,
  installed: true,
  epoch: 'ui-parity',
  state: 'active',
  browserEntry: `/plugins/${hash}/ui-parity/${manifest.entries.browser}`,
  browserStyle: `/plugins/${hash}/ui-parity/browser.css`,
  ...(manifest.entries.presentation ? {
    presentationEntry: `/assets/app-plugins/${hash}/presentation/${manifest.entries.presentation}`,
  } : {}),
}));
// Registry admission requires its normal immutable asset prefix.
for (const item of snapshots) {
  item.browserEntry = item.browserEntry.replace('/plugins/', '/assets/app-plugins/');
  item.browserStyle = item.browserStyle.replace('/plugins/', '/assets/app-plugins/');
}
const routes = {
  '/host.css': path.join(output, 'host.css'),
  ...Object.fromEntries(
    Object.keys(harness.metafile.outputs).map(file => [
      `/${path.basename(file)}`,
      path.resolve(file),
    ]),
  ),
  ...Object.fromEntries(
    Object.keys(hostStyles.metafile.outputs).map(file => [
      `/${path.basename(file)}`,
      path.resolve(file),
    ]),
  ),
  ...Object.fromEntries(
    artifacts.flatMap(item => [
      [
        `/assets/app-plugins/${item.hash}/ui-parity/${item.manifest.entries.browser}`,
        path.join(item.root, item.manifest.entries.browser),
      ],
      [
        `/assets/app-plugins/${item.hash}/ui-parity/browser.css`,
        path.join(item.root, 'browser.css'),
      ],
        ...(item.manifest.entries.presentation ? [[
          `/assets/app-plugins/${item.hash}/presentation/${item.manifest.entries.presentation}`,
          path.join(item.root, item.manifest.entries.presentation),
        ]] : []),
    ]),
  ),
};
const runner = path.join(output, 'runner.cjs');
const browserCode = callback => `(${callback.toString()})()`;
const stylesReady = browserCode(() => {
  const links = [...document.querySelectorAll('link[href*="/assets/app-plugins/"]')];
  return links.length === 2 && links.every(link => !!link.sheet);
});
const tokenState = browserCode(() => {
  const read = kind => {
    const button = document.querySelector(`[data-ui-token="${kind}"] button`);
    const icon = button.querySelector('svg')?.getBoundingClientRect();
    return {
      label: button.textContent,
      remove: button.getAttribute('aria-label'),
      iconSize: icon ? [icon.width, icon.height] : null,
      icons: [...button.querySelectorAll('svg path')].map(path => path.getAttribute('d')),
    };
  };
  return { baseline: read('baseline'), plugin: read('plugin') };
});
const teamTab = browserCode(() => !!document.querySelector('[role="tab"][title="Agent Team"]'));
const sidebarBounds = browserCode(() => {
  const panel = document.querySelector('section[aria-label="Agent Team"]');
  const chat = document.querySelector('[data-ui-chat]');
  const a = panel.getBoundingClientRect();
  return {
    panel: { x: a.x, y: a.y, width: a.width, height: a.height },
    chatRight: chat.getBoundingClientRect().right,
    viewport: innerWidth,
    dialogs: document.querySelectorAll('[role="dialog"]').length,
  };
});
const sidebarSettled = browserCode(() => {
  const panel = document.querySelector('section[aria-label="Agent Team"]');
  const chat = document.querySelector('[data-ui-chat]');
  if (!panel || !chat) return false;
  const a = panel.getBoundingClientRect();
  const frame = document.getElementById('cowork-display-panel');
  return (
    a.width >= 300 &&
    a.x >= chat.getBoundingClientRect().right - 1 &&
    a.right <= innerWidth + 1 &&
    Number(getComputedStyle(frame).opacity) >= 0.999
  );
});
const withdrawn = browserCode(
  () =>
    !document.querySelector('[role="tab"][title="Agent Team"]') &&
    !document.querySelector('[data-ui-menu="plugin"] button'),
);
const pluginOnlyUtilities = browserCode(() => {
  const owner = document.createElement('div');
  owner.dataset.uiStyleScope = 'agent-team';
  owner.style.setProperty('--justdo-primary-muted', 'rgb(23, 45, 67)');
  owner.style.position = 'fixed';
  owner.style.left = '-10000px';
  const button = document.createElement('button');
  button.className = 'aria-pressed:bg-primary-muted';
  button.setAttribute('aria-pressed', 'true');
  const quote = document.createElement('div');
  quote.className = 'border border-l-[3px]';
  owner.append(button, quote);
  document.body.append(owner);
  const result = {
    background: getComputedStyle(button).backgroundColor,
    border: getComputedStyle(quote).borderLeftWidth,
  };
  owner.remove();
  return result;
});
const reverseStyles = browserCode(() => {
  const links = [...document.querySelectorAll('link[href*="/assets/app-plugins/"]')];
  links.reverse().forEach(link => document.head.append(link));
});
const portalScope = browserCode(() => {
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) return null;
  const container = dialog.parentElement;
  const overlay = dialog.closest('[data-workspace-overlay]');
  return {
    scope: overlay?.closest('[data-ui-style-scope]')?.getAttribute('data-ui-style-scope'),
    portaled: !document.getElementById('root').contains(dialog),
    maxWidth: getComputedStyle(container).maxWidth,
    width: container.getBoundingClientRect().width,
    position: getComputedStyle(overlay).position,
  };
});
const summaryState = browserCode(() => {
  const body = document.querySelector('.session-summary-panel__body');
  const rows = [...body.querySelectorAll('button.session-summary-panel__action')];
  const output = body.querySelector('section').getBoundingClientRect();
  const bounds = rows.map(row => row.getBoundingClientRect());
  return {
    labels: rows.map(row => row.textContent),
    gaps: bounds.map((box, index) => box.top - (index ? bounds[index - 1].bottom : output.bottom)),
    heights: bounds.map(box => box.height),
    contentsFit: body.scrollWidth <= body.clientWidth,
  };
});
await writeFile(
  runner,
  `
const assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http');
const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(output, 'profile'))});app.disableHardwareAcceleration();
const routes=${JSON.stringify(routes)},snapshots=${JSON.stringify(snapshots)};let server,win;
const watchdog=setTimeout(()=>app.exit(1),45000);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{await app.whenReady();server=http.createServer((req,res)=>{
 if(req.url==='/'){res.setHeader('content-type','text/html');res.end('<!doctype html><html><head><link rel="stylesheet" href="/host.css"><link rel="stylesheet" href="/surface.css"></head><body style="margin:0"><div id="root"></div><script src="/surface.js"></script></body></html>');return;}
 const file=routes[req.url];if(!file){res.writeHead(404);res.end();return;}res.setHeader('content-type',file.endsWith('.css')?'text/css':file.endsWith('.js')||file.endsWith('.mjs')?'text/javascript':'application/octet-stream');res.end(fs.readFileSync(file));
});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 win=new BrowserWindow({show:false,width:1380,height:900,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
 win.webContents.setBackgroundThrottling(false);
 await win.loadURL('http://127.0.0.1:'+server.address().port+'/');
 const evaluate=code=>win.webContents.executeJavaScript(code);
 const until=async(code,label)=>{const end=Date.now()+10000;while(!await evaluate(code)){if(Date.now()>end)throw Error(label);await pause(25);}};
 await until('!!window.uiParity','Browser fixture loads');await evaluate('window.uiParity.mount()');await pause(50);
 const click=async(selector)=>{await until('!!document.querySelector('+JSON.stringify(selector)+')','Missing '+selector);await evaluate('document.querySelector('+JSON.stringify(selector)+').click()');await pause(40);};
 const baselineTrigger='[data-ui-menu="baseline"] button[aria-haspopup="menu"]';const pluginTrigger='[data-ui-menu="plugin"] button[aria-haspopup="menu"]';
 await click(baselineTrigger);const originalShadow=await evaluate('window.uiParity.menuState("baseline").shadow');await click(baselineTrigger);
 await evaluate('window.uiParity.admit('+JSON.stringify(snapshots)+')');await until(${JSON.stringify(stylesReady)},'Actual plugin styles load');
 const uniqueUtilities=await evaluate(${JSON.stringify(pluginOnlyUtilities)});assert.deepEqual(uniqueUtilities,{background:'rgb(23, 45, 67)',border:'3px'},'Plugin-only utilities beat host preflight without polluting host utilities');
 await evaluate(${JSON.stringify(reverseStyles)});
 await until(${JSON.stringify(stylesReady)},'Reordered plugin styles finish loading');
 const reversedUtilities=await evaluate(${JSON.stringify(pluginOnlyUtilities)});assert.deepEqual(reversedUtilities,uniqueUtilities,'Plugin utility isolation is independent of stylesheet loading order');
 await click(baselineTrigger);const baseline=await evaluate('window.uiParity.menuState("baseline")');fs.writeFileSync(${JSON.stringify(path.join(output, 'baseline-menu.png'))},(await win.webContents.capturePage()).toPNG());await click(baselineTrigger);
 await click(pluginTrigger);const plugin=await evaluate('window.uiParity.menuState("plugin")');
 assert.deepEqual(plugin,baseline,'Root menu labels, grouping and computed style match original');assert.equal(plugin.shadow,originalShadow,'Plugin CSS does not override host shadow');
 const unlayeredShadow=await evaluate('(()=>{const style=document.createElement("style");style.textContent='+JSON.stringify(${JSON.stringify(shadowRule)})+';document.head.append(style);const value=window.uiParity.menuState("plugin").shadow;style.remove();return value;})()');assert.notEqual(unlayeredShadow,originalShadow,'The prior unlayered plugin rule reproduces the visual regression');
 fs.writeFileSync(${JSON.stringify(path.join(output, 'plugin-menu.png'))},(await win.webContents.capturePage()).toPNG());
 await click('[data-ui-menu="plugin"] [aria-label="Agent Team"]');const pluginChildren=await evaluate('window.uiParity.menuState("plugin")');await click('[data-ui-menu="plugin"] [role="menuitemradio"]');
 await click(baselineTrigger);await click('[data-ui-menu="baseline"] [aria-label="Agent Team"]');const baselineChildren=await evaluate('window.uiParity.menuState("baseline")');assert.deepEqual(pluginChildren,baselineChildren,'Team submenu matches original');await click('[data-ui-menu="baseline"] [role="menuitemradio"]');
 const tokens=await evaluate(${JSON.stringify(tokenState)});assert.deepEqual(tokens.plugin,tokens.baseline,'Selected Team token label, icon and removal action match original');
 fs.writeFileSync(${JSON.stringify(path.join(output, 'selected-team.png'))},(await win.webContents.capturePage()).toPNG());
 await evaluate('window.uiParity.openTeam()');await until(${JSON.stringify(teamTab)},'Team opens in a real sidebar tab');
 await until(${JSON.stringify(sidebarSettled)},'The real sidebar finishes its opening transition');
 await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
 const bounds=await evaluate(${JSON.stringify(sidebarBounds)});
 fs.writeFileSync(${JSON.stringify(path.join(output, 'sidebar-bounds.json'))},JSON.stringify(bounds,null,2));
 fs.writeFileSync(${JSON.stringify(path.join(output, 'team-sidebar.png'))},(await win.webContents.capturePage()).toPNG());
 assert.ok(bounds.panel.width>=300&&bounds.panel.x>=bounds.chatRight-1,'Team content belongs to the right sidebar');assert.equal(bounds.dialogs,0,'Team workspace is not a modal');
 await evaluate('window.uiParity.openSummary()');await until('document.querySelectorAll(".session-summary-panel__body button.session-summary-panel__action").length === 2','Both real plugin summary rows load');
 const summary=await evaluate(${JSON.stringify(summaryState)});assert.ok(summary.labels[0].startsWith('Swarm Workflow')&&summary.labels[1].startsWith('Agent Team'),'Summary order matches original independent of registration order');assert.deepEqual(summary.gaps,[16,16],'Scope boundaries preserve the original summary section and row spacing');assert.ok(summary.heights.every(height=>height>=32)&&summary.contentsFit,'Summary rows retain natural height without overflowing');
 fs.writeFileSync(${JSON.stringify(path.join(output, 'summary-rows.png'))},(await win.webContents.capturePage()).toPNG());await evaluate('window.uiParity.closeSummary()');
 await evaluate('window.uiParity.openSettings()');await until('!!document.querySelector("[role=dialog] select")','Actual built settings dialog loads');
 const portal=await evaluate(${JSON.stringify(portalScope)});assert.deepEqual(portal,{scope:'agent-team',portaled:true,maxWidth:'540px',width:540,position:'fixed'},'Plugin-only dialog utilities retain scope across the real SDK portal and Core Modal');
 fs.writeFileSync(${JSON.stringify(path.join(output, 'team-settings.png'))},(await win.webContents.capturePage()).toPNG());await evaluate('window.uiParity.closeSettings()');
 await evaluate('window.uiParity.disable()');await until(${JSON.stringify(withdrawn)},'Disabling withdraws menu and tab');
 const errors=await evaluate('window.uiParity.errors');assert.deepEqual(errors,[]);const result={success:true,baselineRef:${JSON.stringify(ref)},actualPluginCss:true,priorCssRegressionDetected:true,uniqueUtilities,menu:plugin,submenu:pluginChildren,token:tokens.plugin,sidebar:bounds,summary,portal,disableWithdraws:true,errors};fs.writeFileSync(${JSON.stringify(path.join(output, 'result.json'))},JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 clearTimeout(watchdog);win.destroy();server.close(()=>app.exit(0));
})().catch(error=>{console.error(error.stack);if(win)win.destroy();if(server)server.close();app.exit(1);});
`,
);
execFileSync(process.execPath, ['--check', runner], { stdio: 'pipe' });
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [runner], {
  cwd: repo,
  env: environment,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', data => {
  log += data;
});
child.stderr.on('data', data => {
  log += data;
});
const code = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('close', resolve);
});
await writeFile(path.join(output, 'browser.log'), log);
assert.equal(code, 0, log);
process.stdout.write(log);
