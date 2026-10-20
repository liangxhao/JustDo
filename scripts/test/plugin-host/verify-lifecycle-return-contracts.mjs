// Real registries with deferred plugin callbacks; no database, Gateway or user state.
import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import { buildSync } from 'esbuild';

const filename = path.resolve('scripts/test/plugin-host/lifecycle-return-fixture.cjs');
const output = buildSync({
  stdin: {
    resolveDir: process.cwd(),
    loader: 'ts',
    contents: `
export {AppPluginRegistry} from './src/main/plugins/app/registry';
export {AppBrowserRegistry} from './src/renderer/features/plugins/app/browserRegistry';
`,
  },
  write: false,
  bundle: true,
  platform: 'node',
  format: 'cjs',
}).outputFiles[0].text;
const module = new Module(filename);
module.paths = Module._nodeModulePaths(path.dirname(filename));
module._compile(output, filename);
const { AppPluginRegistry, AppBrowserRegistry } = module.exports;
const artifact = {
  root: process.cwd(),
  artifact: {
    hash: 'a'.repeat(64),
    files: {},
    manifest: {
      manifestVersion: 1,
      apiVersion: 1,
      id: 'fixture',
      nativePluginId: 'fixture',
      version: '1.0.0',
      entries: { main: 'unused.mjs', browser: 'browser.mjs' },
      commands: [],
      capabilities: [],
      slots: [],
    },
  },
};
const snapshot = {
  id: 'fixture',
  hash: 'a'.repeat(64),
  epoch: 'epoch',
  version: '1.0.0',
  state: 'active',
  commands: [],
  slots: ['workspace.tab'],
  browserEntry: `/assets/app-plugins/${'a'.repeat(64)}/epoch/browser.mjs`,
};
const unhandled = [];
const observe = error => unhandled.push(String(error));
const flush = () => new Promise(resolve => setImmediate(resolve));
const checks = {};
const binding = { pluginId: 'fixture', registrationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', processId: 123, gatewayMethods: [] };
process.on('unhandledRejection', observe);
try {
  for (const name of ['activate', 'onEnable']) {
    const baseline = unhandled.length;
    const registry = new AppPluginRegistry(() => ({ enabled: true, confirmed: true, binding }));
    try {
      await registry.prepare(artifact, {}, async () => ({
        register: () => ({
          commands: [],
          [name]: async () => {
            await 0;
            throw new Error(`late ${name}`);
          },
        }),
      }));
      try {
        await registry.activate();
      } catch {
        /* Supporting async rejection may propagate safely. */
      }
      await flush();
      checks[`${name}FailureBlocksMainInstance`] = registry.snapshot()[0].state === 'blocked';
      checks[`${name}RejectionObserved`] = unhandled.length === baseline;
    } finally {
      registry.dispose();
    }
  }
  {
    let effects = 0;
    const registry = new AppPluginRegistry(() => ({ enabled: true, confirmed: true, binding }));
    try {
      await registry.prepare(
        artifact,
        {
          getSessions: () => ({
            deleteSession: () => {
              effects++;
            },
          }),
        },
        async () => ({
          register: host => ({
            commands: [],
            activate: async () => {
              await 0;
              host.getSessions().deleteSession('late-after-invalid-activate');
            },
          }),
        }),
      );
      registry.activate();
      await flush();
      checks.invalidAsyncActivateCannotKeepCleanupEffects = effects === 0;
    } finally {
      registry.dispose();
    }
  }
  {
    const baseline = unhandled.length;
    const registry = new AppPluginRegistry(() => ({ enabled: true, confirmed: true, binding }));
    try {
      await assert.rejects(
        registry.prepare(artifact, {}, async () => ({
          register: async () => {
            await 0;
            throw new Error('late Main register');
          },
        })),
      );
      await flush();
      checks.mainAsyncRegisterRejectionObserved = unhandled.length === baseline;
    } finally {
      registry.dispose();
    }
  }
  {
    const baseline = unhandled.length;
    const registry = new AppPluginRegistry(() => ({ enabled: true, confirmed: true, binding }));
    await registry.prepare(artifact, {}, async () => ({
      register: () => ({
        commands: [],
        dispose: async () => {
          await 0;
          throw new Error('late Main dispose');
        },
      }),
    }));
    registry.dispose();
    await flush();
    checks.mainAsyncDisposeRejectionObserved = unhandled.length === baseline;
  }
  {
    const registry = new AppPluginRegistry(() => ({ enabled: true, confirmed: true, binding }));
    let ownerPreserved = false;
    const registration = {
      commands: [],
      async beforePackageMutation() {
        ownerPreserved = this === registration;
      },
    };
    try {
      await registry.prepare(artifact, {}, async () => ({ register: () => registration }));
      await registry.preparePackageMutation();
      checks.packagePreflightPreservesRegistrationOwner = ownerPreserved;
    } finally {
      registry.dispose();
    }
  }
  {
    const baseline = unhandled.length;
    const outcomes = [];
    let lateAttempts = 0;
    let lateDenied = 0;
    const effects = { requests: 0, deletes: 0, writes: 0 };
    for (const mode of ['true', 'owner', 'false', 'truthy', 'promise', 'async-tail']) {
      const registry = new AppPluginRegistry(() => ({ enabled: false, confirmed: true }));
      try {
        await registry.prepare(
          artifact,
          {
            getSessions: () => ({ deleteSession: () => effects.deletes++ }),
            getDatabase: () => ({
              prepare: () => ({ readonly: false, run: () => effects.writes++ }),
            }),
            requestConnectedGateway: async () => {
              effects.requests++;
              return { success: true };
            },
          },
          async () => ({
            register: host => ({
              commands: [],
              cleanupGatewayMethods: ['fixture.cleanup'],
              allowCleanupGatewayRequest(method) {
                if (mode === 'true') return true;
                if (mode === 'owner') return this.cleanupGatewayMethods.includes(method);
                if (mode === 'false') return false;
                if (mode === 'truthy') return 1;
                if (mode === 'promise') return Promise.resolve(true);
                return (async () => {
                  await 0;
                  for (const effect of [
                    () => host.getSessions().deleteSession('source'),
                    () => host.getDatabase().prepare('write').run(),
                    () => host.requestConnectedGateway('fixture.cleanup', {}),
                  ]) {
                    lateAttempts++;
                    try {
                      effect();
                    } catch {
                      lateDenied++;
                    }
                  }
                  throw new Error('late cleanup predicate');
                })();
              },
              resources: {
                expandResources: ids => [...ids],
                acquireDeletion: () => () => {},
                isDeleting: () => false,
                isManaged: () => false,
                prepareDelete: async () => host.requestConnectedGateway('fixture.cleanup', {}),
                deleteManaged: async () => false,
              },
            }),
          }),
        );
        try {
          await registry.registrations()[0].resources.prepareDelete(['source']);
          outcomes.push(mode);
        } catch {
          /* Invalid decisions deny the request. */
        }
        await flush();
      } finally {
        registry.dispose();
      }
    }
    checks.cleanupPredicateRequiresSynchronousStrictTrue =
      JSON.stringify(outcomes) === '["true","owner"]' && effects.requests === 2;
    checks.cleanupPredicateAsyncTailCannotEffect =
      lateAttempts === 3 && lateDenied === 3 && effects.deletes === 0 && effects.writes === 0;
    checks.cleanupPredicateAsyncRejectionObserved = unhandled.length === baseline;
  }
  {
    const baseline = unhandled.length;
    const effects = { creates: 0, deletes: 0, writes: 0, requests: 0, reads: 0 };
    let synchronousDenied = 0;
    let lateDenied = 0;
    let lateAttempts = 0;
    const projectArtifact = {
      ...artifact,
      artifact: {
        ...artifact.artifact,
        manifest: { ...artifact.artifact.manifest, commands: ['project'] },
      },
    };
    for (const asynchronous of [false, true]) {
      const registry = new AppPluginRegistry(() => ({ enabled: true, confirmed: true, binding }));
      const resources = {
        getSessions: () => ({
          createSession: () => effects.creates++,
          deleteSession: () => effects.deletes++,
        }),
        getDatabase: () => ({
          prepare: query => ({
            readonly: query === 'read',
            run: () => effects.writes++,
            get: () => {
              effects.reads++;
              return { value: 1 };
            },
          }),
        }),
        requestGateway: async () => {
          effects.requests++;
          return {};
        },
      };
      try {
        await registry.prepare(projectArtifact, resources, async () => ({
          register: host => {
            const privileged = [
              () => host.getSessions().createSession('source'),
              () => host.getSessions().deleteSession('source'),
              () => host.getDatabase().prepare('write').run(),
              () => host.requestGateway('fixture.effect', {}),
            ];
            return {
              commands: [{ id: 'project', invoke: () => registry.projectNativeConfig([]) }],
              cleanupGatewayMethods: ['fixture.effect'],
              resources: {
                expandResources: ids => [...ids],
                acquireDeletion: () => () => {},
                isDeleting: () => false,
                isManaged: () => false,
                prepareDelete: async () => registry.projectNativeConfig([]),
                deleteManaged: async () => false,
              },
              projectNativeConfig: () => {
                if (asynchronous)
                  return (async () => {
                    await 0;
                    for (const effect of privileged) {
                      lateAttempts++;
                      try {
                        effect();
                      } catch {
                        lateDenied++;
                      }
                    }
                    throw new Error('late config projection');
                  })();
                for (const effect of privileged) {
                  try {
                    effect();
                  } catch {
                    synchronousDenied++;
                  }
                }
                host.getDatabase().prepare('read').get();
                return { allowed: true };
              },
            };
          },
        }));
        registry.activate();
        const result = await registry.invoke({
          id: 'fixture',
          epoch: registry.snapshot()[0].epoch,
          command: 'project',
          args: [],
        });
        await flush();
        if (asynchronous)
          checks.asyncConfigProjectionRejectsAdmission =
            result.success === false && registry.snapshot()[0].state === 'blocked';
        else {
          checks.configProjectionCannotInheritBusinessScope =
            synchronousDenied === 4 &&
            JSON.stringify(result) === '{"fixture":{"config":{"allowed":true}}}';
          await registry.registrations()[0].resources.prepareDelete(['source']);
          checks.configProjectionCannotInheritCleanupScope = synchronousDenied === 8;
        }
      } finally {
        registry.dispose();
      }
    }
    checks.configProjectionRetainsReadonlyMetadata = effects.reads === 2;
    checks.configProjectionAsyncTailCannotEffect =
      lateAttempts === 4 &&
      lateDenied === 4 &&
      [effects.creates, effects.deletes, effects.writes, effects.requests].every(
        count => count === 0,
      );
    checks.configProjectionAsyncRejectionObserved = unhandled.length === baseline;
  }
  const bridge = { snapshot: async () => [], onChanged: () => () => {}, invoke: async () => ({}) };
  const services = {
    t: key => key,
    translations: () => () => {},
    components: {},
    renderHistory: () => null,
  };
  {
    const baseline = unhandled.length;
    let host;
    const registry = new AppBrowserRegistry(bridge, services, async () => ({
      register: async value => {
        host = value;
        await 0;
        throw new Error('late Browser register');
      },
    }));
    try {
      await registry.update([snapshot]);
      await flush();
      checks.browserAsyncRegisterFailsClosed = host.signal.aborted;
      checks.browserAsyncRegisterRejectionObserved = unhandled.length === baseline;
    } finally {
      registry.dispose();
    }
  }
  {
    const baseline = unhandled.length;
    const registry = new AppBrowserRegistry(bridge, services, async () => ({
      register: host => {
        host.registerView({
          id: 'workspace',
          slot: 'workspace.tab',
          labelKey: 'workspace',
          component: () => null,
        });
        return async () => {
          await 0;
          throw new Error('late Browser dispose');
        };
      },
    }));
    try {
      await registry.update([snapshot]);
      checks.synchronousBrowserRegistrationStillWorks = registry.getViews().length === 1;
      await registry.update([]);
      await flush();
      checks.browserAsyncDisposeRejectionObserved = unhandled.length === baseline;
    } finally {
      registry.dispose();
    }
  }
  console.log(
    JSON.stringify({
      realMainRegistry: true,
      realBrowserRegistry: true,
      fixturePluginCallbacks: true,
      checks,
    }),
  );
  assert.ok(
    Object.values(checks).every(Boolean),
    'Deferred lifecycle failures must stay observed and fail closed',
  );
} finally {
  await flush();
  process.off('unhandledRejection', observe);
}
