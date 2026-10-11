import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as esbuild from 'esbuild';
import { afterEach, expect, test } from 'vitest';

const {
  createSharedSdkModulesPlugin,
} = require('../../../scripts/openclaw/openclaw-shared-sdk-modules.cjs');
const {
  transform: detachPeerDispatcher,
} = require('../../../scripts/patches/v2026.9.8/039-peer-transcript-write-scope.cjs').__testing;
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

test('Gateway and separately loaded SDK share activation, rotation, revocation and transitive state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-native-sdk-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'dist/plugin-sdk'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(
    path.join(root, 'dist/owners.js'),
    `import { isSecretResolutionError } from './errors.js';
    export const revoked = new Set();
    export function isSecretOwnerAvailable(owner) { return !revoked.has(owner); }
    export const classify = error => isSecretResolutionError(error) ? 'unavailable' : 'unknown';`,
  );
  fs.writeFileSync(
    path.join(root, 'dist/errors.js'),
    `export class SecretResolutionError extends Error {}
    export function isSecretResolutionError(value) { return value instanceof SecretResolutionError; }
    export const createError = () => new SecretResolutionError('synthetic');`,
  );
  fs.writeFileSync(
    path.join(root, 'dist/state.js'),
    `
    import { revoked } from './owners.js';
    let snapshot;
    export function getActiveSecretsRuntimeConfigSnapshot() { return snapshot; }
    export const activate = value => { snapshot = value; };
    export const read = owner => revoked.has(owner) ? undefined : snapshot?.[owner];
  `,
  );
  fs.writeFileSync(
    path.join(root, 'dist/plugin-sdk/secret-input-runtime.js'),
    `
    export { read } from '../state.js';
    export * from '../config.js';
    export * from '../auth.js';
    export * from '../scope.js';
    export * from '../config-state.js';
    export * from '../auth-owners.js';
  `,
  );
  fs.writeFileSync(
    path.join(root, 'dist/config.js'),
    'export function getRuntimeConfigSnapshot() {} export function getAuthoredConfigSecretRef() {}',
  );
  fs.writeFileSync(
    path.join(root, 'dist/auth.js'),
    'export function getRuntimeAuthProfileStoreCredentialsRevision() {}',
  );
  fs.writeFileSync(
    path.join(root, 'dist/scope.js'),
    `import { AsyncLocalStorage } from 'node:async_hooks';
    const scope = new AsyncLocalStorage();
    export function getScopedConfigSnapshotPreparation() { return scope.getStore(); }
    export const withPreparation = (value, run) => scope.run(value, run);`,
  );
  fs.writeFileSync(
    path.join(root, 'dist/config-state.js'),
    `const retained = new WeakMap();
    let published;
    const paths = new Map();
    export function getRetainedLegacyDefaultAgentId(config) { return retained.get(config); }
    export const retain = (config, id) => retained.set(config, id);
    export function getPublishedConfigRuntimeEnvState() { return published; }
    export const publish = value => { published = value; };
    export function clearExecutablePathCache() { paths.clear(); }
    export const rememberPath = (key, value) => paths.set(key, value);
    export const readPath = key => paths.get(key);`,
  );
  fs.writeFileSync(
    path.join(root, 'dist/auth-owners.js'),
    `const owners = new Map();
    const pool = new Set();
    const handoffs = new Set();
    const migration = new Map();
    export class AuthStoreError extends Error {}
    export function closeAuthProfileReadPool() { pool.clear(); }
    export const openRead = handle => pool.add(handle);
    export const hasRead = handle => pool.has(handle);
    export function resolveSharedAuthStoreOwnership(key) { return owners.get(key); }
    export const setOwner = (key, value) => owners.set(key, value);
    export function registerFreshSharedAuthStoreHandoff(value) { handoffs.add(value); }
    export const hasHandoff = value => handoffs.has(value);
    export function markAuthProfileMigrationRequired(key, error) { migration.set(key, error); }
    export function loadPersistedAuthProfileStoreAtDatabasePath(key) { throw migration.get(key) || new AuthStoreError(); }`,
  );
  fs.writeFileSync(
    path.join(root, 'dist/plugin-sdk/reply-runtime.js'),
    "export * from '../admitted-run-context.js'; export * from '../gateway-context-binding-owner.js'; export * from '../transcript-write-context.js'; export * from '../cli-history-boundary.js';",
  );
  fs.writeFileSync(
    path.join(root, 'dist/cli-history-boundary.js'),
    `import { AsyncLocalStorage } from 'node:async_hooks';
    const cliHistoryWriter = new AsyncLocalStorage();
    export function runWithCliHistoryWriter(writer, run) {
      return writer ? cliHistoryWriter.run(writer, run) : cliHistoryWriter.exit(run);
    }
    export function getCliHistoryWriter(target) {
      const writer = cliHistoryWriter.getStore();
      return writer && writer.target.agentId === target.agentId &&
        writer.target.sessionId === target.sessionId &&
        writer.target.sessionKey === target.sessionKey &&
        writer.target.storePath === target.storePath ? writer : undefined;
    }`,
  );
  fs.writeFileSync(
    path.join(root, 'dist/transcript-write-context.js'),
    `import { AsyncLocalStorage } from 'node:async_hooks';
    import { runWithCliHistoryWriter } from './cli-history-boundary.js';
    const writers = new AsyncLocalStorage();
    export const getWriter = () => writers.getStore();
    export const withWriter = (writer, run) => writers.run(writer, run);
    export const withoutWriter = run => writers.exit(() => runWithCliHistoryWriter(undefined, run));
    export function captureOwnedTranscriptWriteAssertion(target) {
      const writer = writers.getStore();
      return () => {
        if (writer && (writer.target !== target || writer.revoked)) throw new Error('writer rebound');
      };
    }`,
  );
  fs.writeFileSync(
    path.join(root, 'dist/peer-dispatch.js'),
    detachPeerDispatcher(`import { AsyncLocalStorage } from 'node:async_hooks';
    const runBoundInProcessGatewayCall = run => run();
    const withInProcessAgentRuntimeIdentity = () => undefined;
    const dispatchGatewayMethodInProcess = (method, params) => params.run();
    async function callAgentToolGatewayRequestBound(request, resolver, identity, assertCaller, forceTransport = false, revalidate = true) {
      const signal = request.signal;
      const guard = request.sessionMutationCommitGuard;
      request.assertDispatchCurrent?.();
      assertCaller?.();
      guard?.();
      signal?.throwIfAborted();
      return runBoundInProcessGatewayCall(() => dispatchGatewayMethodInProcess(request.method, request.params, withInProcessAgentRuntimeIdentity()));
    }
    export function bindPeerDispatcher() {
      const snapshot = AsyncLocalStorage.snapshot();
      return request => snapshot(() => callAgentToolGatewayRequestBound(request, {}, {}, () => undefined));
    }`, '<fixture>', { module: './transcript-write-context.js', exportName: 'withoutWriter' }),
  );
  fs.writeFileSync(
    path.join(root, 'dist/gateway-context-binding-owner.js'),
    `const key = Symbol('gatewayContextBindingOwner');
    class Owner {
      #owner;
      constructor(owner) { this.#owner = owner; }
      static read(value, owner) { return typeof value === 'object' && value !== null && #owner in value && value.#owner === owner ? value : undefined; }
    }
    export function prepareGatewayContextBindingOwner(owner) {
      if (!Owner.read(owner[key], owner)) Object.defineProperty(owner, key, { value: new Owner(owner) });
      return owner;
    }`,
  );
  fs.writeFileSync(
    path.join(root, 'dist/admitted-run-context.js'),
    `const issued = new WeakSet();
    export function createAdmittedRunOperatorAuthority(source) {
      const authority = Object.freeze({ assertCurrent: source.assertCurrent });
      issued.add(authority);
      return authority;
    }
    export function assertAdmittedRunOperatorAuthority(authority) {
      if (!issued.has(authority)) throw new Error('operator run authority must be issued by the host');
      authority.assertCurrent();
    }`,
  );
  fs.writeFileSync(
    path.join(root, 'dist/gateway.js'),
    `
    export { activate } from './state.js';
    export { revoked } from './owners.js';
    import { classify } from './owners.js';
    import { createError } from './errors.js';
    export const classifyCreatedError = () => classify(createError());
    export { createError };
    export { classify };
    export * from './scope.js';
    export * from './config-state.js';
    export * from './auth-owners.js';
    export * from './admitted-run-context.js';
    export * from './gateway-context-binding-owner.js';
    export * from './transcript-write-context.js';
    export * from './cli-history-boundary.js';
    export * from './peer-dispatch.js';
  `,
  );
  const original = fs.readFileSync(path.join(root, 'dist/state.js'), 'utf8');
  for (const shared of [false, true]) {
    await esbuild.build({
      entryPoints: [path.join(root, 'dist/gateway.js')],
      outfile: path.join(root, shared ? 'gateway-bundle.mjs' : 'broken-bundle.mjs'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      plugins: shared ? [createSharedSdkModulesPlugin(root, esbuild)] : [],
    });
  }
  fs.writeFileSync(
    path.join(root, 'verify.mjs'),
    `
    import assert from 'node:assert/strict';
    import * as sdk from './dist/plugin-sdk/secret-input-runtime.js';
    import * as replySdk from './dist/plugin-sdk/reply-runtime.js';
    import * as broken from './broken-bundle.mjs';
    import * as host from './gateway-bundle.mjs';
    import * as nativeOwners from './dist/owners.js';
    import * as nativeErrors from './dist/errors.js';
    const sourceTarget = { agentId:'main', sessionId:'source-sid', sessionKey:'agent:main:source', storePath:'source-store' };
    const peerTarget = { agentId:'peer', sessionId:'peer-sid', sessionKey:'agent:peer:target', storePath:'peer-store' };
    let sourceActive = true;
    const sourceCli = { target: sourceTarget, assertCurrent() { if (!sourceActive) throw new Error('source stopped'); } };
    const peerCli = { target: peerTarget, assertCurrent() {} };
    const peerWriter = { target: 'peer' };
    const scopedSourceWriter = { target: 'organizer' };
    // Both native private carriers must be shared. Sharing only transcript
    // ownership leaves the bundled CLI producer outside the SDK detach scope.
    await broken.runWithCliHistoryWriter(sourceCli, async () => {
      await replySdk.withoutWriter(async () => {
        await Promise.resolve();
        assert.equal(broken.getCliHistoryWriter(sourceTarget), sourceCli);
      });
    });
    let releasePeer;
    let peerTail;
    await host.withWriter(scopedSourceWriter, () => host.runWithCliHistoryWriter(sourceCli, async () => {
      const call = host.bindPeerDispatcher();
      await call({ method:'sessions.patch', params:{ run:async () => {
        await Promise.resolve();
        assert.equal(host.getWriter(), scopedSourceWriter);
        assert.equal(replySdk.getCliHistoryWriter(sourceTarget), sourceCli);
      } } });
      await call({ method:'agent', params:{ run:async () => {
        await Promise.resolve();
        assert.equal(host.getWriter(), undefined);
        assert.equal(host.getCliHistoryWriter(sourceTarget), undefined);
        assert.equal(replySdk.getCliHistoryWriter(sourceTarget), undefined);
        await replySdk.withWriter(peerWriter, () => replySdk.runWithCliHistoryWriter(peerCli, async () => {
          assert.equal(host.getWriter(), peerWriter);
          assert.equal(host.getCliHistoryWriter(peerTarget), peerCli);
          peerTail = (async () => {
            await new Promise(resolve => { releasePeer = resolve; });
            assert.equal(host.getWriter(), peerWriter);
            assert.equal(host.getCliHistoryWriter(peerTarget), peerCli);
            assert.equal(host.getCliHistoryWriter(sourceTarget), undefined);
            replySdk.captureOwnedTranscriptWriteAssertion('peer')();
            host.getCliHistoryWriter(peerTarget).assertCurrent();
          })();
        }));
        assert.equal(host.getWriter(), undefined);
        assert.equal(host.getCliHistoryWriter(peerTarget), undefined);
      } } });
      assert.equal(host.getWriter(), scopedSourceWriter);
      assert.equal(replySdk.getCliHistoryWriter(sourceTarget), sourceCli);
      sourceActive = false;
      scopedSourceWriter.revoked = true;
      assert.throws(() => host.getCliHistoryWriter(sourceTarget).assertCurrent(), /source stopped/);
      assert.throws(replySdk.captureOwnedTranscriptWriteAssertion('organizer'), /writer rebound/);
    }));
    releasePeer();
    await peerTail;
    assert.equal(host.getWriter(), undefined);
    assert.equal(host.getCliHistoryWriter(sourceTarget), undefined);
    const sourceWriter = { target: 'organizer' };
    await broken.withWriter(sourceWriter, async () => {
      await replySdk.withoutWriter(async () => {
        await Promise.resolve();
        assert.equal(broken.getWriter(), sourceWriter);
        assert.throws(broken.captureOwnedTranscriptWriteAssertion('peer'), /writer rebound/);
      });
    });
    await host.withWriter(sourceWriter, async () => {
      await replySdk.withoutWriter(async () => {
        await Promise.resolve();
        assert.equal(host.getWriter(), undefined);
        host.captureOwnedTranscriptWriteAssertion('peer')();
      });
      assert.equal(replySdk.getWriter(), sourceWriter);
      assert.throws(replySdk.captureOwnedTranscriptWriteAssertion('peer'), /writer rebound/);
      const assertOriginalWriter = replySdk.captureOwnedTranscriptWriteAssertion('organizer');
      assertOriginalWriter();
      sourceWriter.revoked = true;
      assert.throws(assertOriginalWriter, /writer rebound/);
    });
    assert.equal(host.getWriter(), undefined);
    const foreignContext = Object.freeze(broken.prepareGatewayContextBindingOwner({}));
    assert.throws(() => replySdk.prepareGatewayContextBindingOwner(foreignContext), /not extensible/);
    const context = Object.freeze(host.prepareGatewayContextBindingOwner({}));
    assert.equal(replySdk.prepareGatewayContextBindingOwner(context), context);
    const brokenAuthority = broken.createAdmittedRunOperatorAuthority({ assertCurrent() {} });
    assert.throws(() => replySdk.assertAdmittedRunOperatorAuthority(brokenAuthority), /issued by the host/);
    let revoked = false;
    const authority = host.createAdmittedRunOperatorAuthority({ assertCurrent() { if (revoked) throw new Error('revoked'); } });
    replySdk.assertAdmittedRunOperatorAuthority(authority);
    host.assertAdmittedRunOperatorAuthority(replySdk.createAdmittedRunOperatorAuthority({ assertCurrent() {} }));
    assert.throws(() => replySdk.assertAdmittedRunOperatorAuthority({ ...authority }), /issued by the host/);
    revoked = true;
    assert.throws(() => replySdk.assertAdmittedRunOperatorAuthority(authority), /revoked/);
    assert.equal(nativeOwners.classify(broken.createError()), 'unknown');
    assert.equal(host.classifyCreatedError(), 'unavailable');
    assert.equal(nativeOwners.classify(host.createError()), 'unavailable');
    assert.equal(host.classify(nativeErrors.createError()), 'unavailable');
    await host.withPreparation('active', async () => {
      await Promise.resolve();
      assert.equal(sdk.getScopedConfigSnapshotPreparation(), 'active');
    });
    assert.equal(sdk.getScopedConfigSnapshotPreparation(), undefined);
    const config = {};
    host.retain(config, 'main');
    assert.equal(sdk.getRetainedLegacyDefaultAgentId(config), 'main');
    host.publish('first');
    assert.equal(sdk.getPublishedConfigRuntimeEnvState(), 'first');
    sdk.publish('rotated');
    assert.equal(host.getPublishedConfigRuntimeEnvState(), 'rotated');
    host.rememberPath('python', 'cached');
    sdk.clearExecutablePathCache();
    assert.equal(host.readPath('python'), undefined);
    host.openRead('db');
    sdk.closeAuthProfileReadPool();
    assert.equal(host.hasRead('db'), false);
    host.setOwner('db', 'main');
    assert.equal(sdk.resolveSharedAuthStoreOwnership('db'), 'main');
    host.registerFreshSharedAuthStoreHandoff('db');
    assert.equal(sdk.hasHandoff('db'), true);
    const authError = new host.AuthStoreError();
    host.markAuthProfileMigrationRequired('db', authError);
    assert.throws(() => sdk.loadPersistedAuthProfileStoreAtDatabasePath('db'), error => error === authError && error instanceof sdk.AuthStoreError);
    broken.activate({ typesafe: 'test-old' });
    assert.equal(sdk.read('typesafe'), undefined);
    host.activate({ typesafe: 'test-first' });
    assert.equal(sdk.read('typesafe'), 'test-first');
    host.activate({ typesafe: 'test-rotated' });
    assert.equal(sdk.read('typesafe'), 'test-rotated');
    host.revoked.add('typesafe');
    assert.equal(sdk.read('typesafe'), undefined);
    host.revoked.clear();
    host.activate(undefined);
    assert.equal(sdk.read('typesafe'), undefined);
  `,
  );
  execFileSync(process.execPath, [path.join(root, 'verify.mjs')], { windowsHide: true });
  expect(fs.readFileSync(path.join(root, 'dist/state.js'), 'utf8')).toBe(original);
  expect(fs.readFileSync(path.join(root, 'gateway-bundle.mjs'), 'utf8')).not.toContain(
    'let snapshot',
  );
});

test.each(['secret-input-runtime', 'reply-runtime'])(
  'fails clearly when the pinned %s SDK entry is missing', missing => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'missing-native-sdk-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'dist/plugin-sdk'), { recursive: true });
    for (const name of ['secret-input-runtime', 'reply-runtime'])
      if (name !== missing) fs.writeFileSync(path.join(root, 'dist/plugin-sdk', `${name}.js`), '');
    expect(() => createSharedSdkModulesPlugin(root, esbuild)).toThrow(`Missing native ${missing}`);
  },
);
