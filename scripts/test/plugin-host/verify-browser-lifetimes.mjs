// Real browser registry with delayed application effect boundaries; no application state.
import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import { build } from 'esbuild';

const built = await build({
  entryPoints: ['src/renderer/features/plugins/app/browserRegistry.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['react'],
  write: false,
  logLevel: 'silent',
});
const compiled = new Module(path.resolve('.tmp/browser-lifetime-review.cjs'));
compiled.filename = compiled.id;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(built.outputFiles[0].text, compiled.filename);
const { AppBrowserRegistry } = compiled.exports;
const deferred = () => {
  let resolve;
  return {
    promise: new Promise(value => {
      resolve = value;
    }),
    release: () => resolve(),
  };
};
const load = deferred(),
  transition = deferred(),
  send = deferred();
let host,
  selected = null,
  onSelected = 0,
  sends = 0,
  navigations = 0,
  drafts = 0,
  dispose = 0;
const registry = new AppBrowserRegistry(
  { snapshot: async () => [], onChanged: () => () => {}, invoke: async () => ({ success: true }) },
  {
    t: key => key,
    translations: () => () => {},
    components: {},
    renderHistory: () => null,
    application: {
      metadata: { getSnapshot: () => ({}), subscribe: () => () => {} },
      sessions: {
        async loadSession(id, options = {}) {
          await load.promise;
          if (options.canSelect?.() === false) return null;
          selected = id;
          options.onSelected?.();
          return { id };
        },
        onChanged: () => () => {},
      },
      drafts: { addQuote: () => drafts++, setPrompt: () => drafts++ },
      files: {},
      stageAudio: async () => ({ success: true }),
    },
  },
  async () => ({
    register(value) {
      host = value;
      host.registerView({
        id: 'view',
        slot: 'workspace.tab',
        labelKey: 'fixture',
        component: () => null,
      });
      return () => dispose++;
    },
  }),
);
const snapshot = epoch => ({
  id: 'fixture',
  version: '1',
  hash: 'a'.repeat(64),
  epoch,
  state: 'active',
  browserEntry: `/assets/app-plugins/${'a'.repeat(64)}/${epoch}/browser.mjs`,
  slots: ['workspace.tab'],
  commands: [],
});
const context = () =>
  registry.getViews()[0].component({
    session: { id: 'source' },
    onClose: () => navigations++,
    draft: { append: () => drafts++, focus: () => drafts++ },
    navigation: {
      showChat: () => navigations++,
      async requestTransition(options) {
        await transition.promise;
        if (options?.canCommit?.() === false) return false;
        navigations++;
        return true;
      },
    },
    submitUserTurn: {
      assertReady: () => {},
      supportsImages: () => true,
      outcomeUnknown: () => false,
      async send(input) {
        await send.promise;
        input.assertCurrent?.();
        sends++;
        return true;
      },
    },
  }).props;
const checks = {};
try {
  await registry.update([snapshot('first')]);
  const oldHost = host,
    oldContext = context();
  const pendingLoad = host.application.sessions
    .loadSession('target', { onSelected: () => onSelected++ })
    .catch(() => null);
  const pendingTransition = oldContext.navigation.requestTransition();
  const pendingSend = oldContext.submitUserTurn
    .send({
      display: 'synthetic',
      gateway: 'synthetic',
      attachments: [],
      clientTurnId: 'synthetic',
    })
    .catch(() => false);
  host.openWorkspace('view', 'source', { key: 'synthetic' });
  assert.equal(registry.getWorkspaceRequests().length, 1);
  await registry.update([]);
  load.release();
  transition.release();
  send.release();
  await Promise.all([pendingLoad, pendingTransition, pendingSend]);
  assert.equal(selected, null);
  assert.equal(onSelected, 0);
  checks.retiredSessionLoadCannotNavigate = true;
  assert.equal(navigations, 0);
  checks.retiredNavigationCannotCommit = true;
  assert.equal(sends, 0);
  checks.retiredUserTurnCannotSend = true;
  assert.equal(registry.getWorkspaceRequests().length, 0);
  checks.retiredWorkspaceRequestsRemoved = true;
  assert.throws(() => oldContext.draft.append('late'), /appPluginRetired/);
  assert.throws(() => oldContext.draft.focus(), /appPluginRetired/);
  assert.throws(() => oldContext.navigation.showChat(), /appPluginRetired/);
  assert.throws(() => oldContext.onClose(), /appPluginRetired/);
  assert.equal(drafts, 0);
  checks.retiredContextCallbacksBlocked = true;
  await registry.update([snapshot('second')]);
  assert.throws(() => oldHost.openWorkspace('view', 'source'), /appPluginRetired/);
  assert.throws(() => oldContext.submitUserTurn.send({}), /appPluginRetired/);
  checks.oldEpochNeverBorrowsReenabledHost = true;
  assert.equal(
    await context().submitUserTurn.send({
      display: 'synthetic',
      gateway: 'synthetic',
      attachments: [],
      clientTurnId: 'new',
    }),
    true,
  );
  assert.equal(sends, 1);
  checks.newEpochContextStillWorks = true;
  assert.equal(dispose, 1);
  console.log(JSON.stringify({ realBrowserRegistry: true, checks }));
} finally {
  registry.dispose();
}
