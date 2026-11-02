import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import {
  APP_PLUGIN_PYTHON_RUNTIME_ENV,
  assertHostPythonRuntimeCurrent,
  createHostPythonEnvironment,
  parseHostPythonRuntime,
  resolveHostPythonRuntime,
} from '../runtimes';

let root: string;
let descriptor: Record<string, unknown>;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-python-sdk-')));
  const executable = path.join(root, 'python.exe');
  const standardLibrary = path.join(root, 'python312.zip');
  for (const file of [executable, standardLibrary]) fs.writeFileSync(file, path.basename(file));
  descriptor = { schemaVersion: 1, implementation: 'cpython', version: '3.12.10',
    platform: process.platform, architecture: process.arch, executable,
    standardLibraryPaths: [standardLibrary, root], files: [executable, standardLibrary].map(file => ({
      path: file, bytes: fs.statSync(file).size,
      sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    })) };
  vi.stubEnv(APP_PLUGIN_PYTHON_RUNTIME_ENV, JSON.stringify(descriptor));
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

test('resolves immutable public metadata and rejects changed runtime bytes or identity', () => {
  const runtime = resolveHostPythonRuntime()!;
  expect(runtime.version).toBe('3.12.10');
  expect(Object.isFrozen(runtime)).toBe(true);
  expect(Object.isFrozen(runtime.standardLibraryPaths)).toBe(true);
  assertHostPythonRuntimeCurrent(runtime);
  const executable = runtime.executable;
  fs.renameSync(executable, executable + '.old');
  fs.copyFileSync(executable + '.old', executable);
  expect(() => assertHostPythonRuntimeCurrent(runtime)).toThrow('changed');
  const replacement = resolveHostPythonRuntime()!;
  expect(replacement).not.toBeNull();
  fs.writeFileSync(executable, 'changed interpreter');
  expect(resolveHostPythonRuntime()).toBeNull();
});

test('rejects malformed, foreign, oversized and changed transport descriptors', () => {
  for (const value of [{ ...descriptor, extra: true }, { ...descriptor, version: '3.12' },
    { ...descriptor, executable: 'python' }, { ...descriptor, files: [] },
    { ...descriptor, standardLibraryPaths: [path.dirname(root)] }]) {
    expect(parseHostPythonRuntime(value)).toBeNull();
  }
  const runtime = resolveHostPythonRuntime()!;
  vi.stubEnv(APP_PLUGIN_PYTHON_RUNTIME_ENV, JSON.stringify({ ...descriptor, architecture: 'other' }));
  expect(resolveHostPythonRuntime()).toBeNull();
  expect(() => assertHostPythonRuntimeCurrent(runtime)).toThrow();
  vi.stubEnv(APP_PLUGIN_PYTHON_RUNTIME_ENV, ' '.repeat(65537));
  expect(resolveHostPythonRuntime()).toBeNull();
  vi.stubEnv(APP_PLUGIN_PYTHON_RUNTIME_ENV, 'invalid-json');
  expect(resolveHostPythonRuntime()).toBeNull();
});

test('constructs a minimal environment without ambient package paths, secrets or loaders', () => {
  vi.stubEnv('PYTHONPATH', 'untrusted-packages');
  vi.stubEnv('JUSTDO_PYTHON_USER_SITE', 'user-packages');
  vi.stubEnv('NODE_OPTIONS', '--require untrusted');
  vi.stubEnv('MODEL_API_KEY', 'private');
  vi.stubEnv('PATH', 'untrusted-bin');
  const env = createHostPythonEnvironment();
  expect(env.PYTHONPATH).toBeUndefined();
  expect(env.JUSTDO_PYTHON_USER_SITE).toBeUndefined();
  expect(env.NODE_OPTIONS).toBeUndefined();
  expect(env.MODEL_API_KEY).toBeUndefined();
  expect(env[APP_PLUGIN_PYTHON_RUNTIME_ENV]).toBeUndefined();
  expect(env.PATH).not.toContain('untrusted');
});
