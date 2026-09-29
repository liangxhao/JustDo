import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as esbuild from 'esbuild';
import { afterEach, expect, test } from 'vitest';

const {
  createSharedSdkModulesPlugin,
} = require('../../../scripts/openclaw/openclaw-shared-sdk-modules.cjs');
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
    import * as broken from './broken-bundle.mjs';
    import * as host from './gateway-bundle.mjs';
    import * as nativeOwners from './dist/owners.js';
    import * as nativeErrors from './dist/errors.js';
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

test('fails clearly when the pinned SDK entry is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'missing-native-sdk-'));
  roots.push(root);
  expect(() => createSharedSdkModulesPlugin(root, esbuild)).toThrow('Missing native');
});
