import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ root: null as string | null, execute: vi.fn() }));
vi.mock('./pythonRuntime', () => ({ getBundledPythonRoot: () => mocks.root }));
vi.mock('node:child_process', () => ({ execFile: mocks.execute }));
import { APP_PLUGIN_PYTHON_RUNTIME_ENV } from '../../../../plugins/sdk/app-plugin-sdk/runtimes';
import { appendPluginPythonRuntimeToEnv, getPluginPythonRuntime } from './pluginPythonRuntime';

let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-python-host-')));
  mocks.root = root;
  fs.mkdirSync(path.join(root, 'Lib', 'site-packages'), { recursive: true });
  for (const file of ['python.exe', 'python3.dll', 'python312.dll', 'python312.zip', 'python312._pth',
    path.join('Lib', 'site-packages', 'sitecustomize.py')])
    fs.writeFileSync(path.join(root, file), file);
  mocks.execute.mockReset().mockImplementation((_exe, _args, _options, done) => {
    done(null, JSON.stringify({ implementation: 'cpython', version: '3.12.10', platform: 'win32',
      bits: 64, executable: path.join(root, 'python.exe') }));
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  mocks.root = null;
  fs.rmSync(root, { recursive: true, force: true });
});

test('publishes only managed runtime metadata after a bounded isolated version probe', async () => {
  vi.stubEnv('PYTHONPATH', 'untrusted');
  vi.stubEnv('JUSTDO_PYTHON_USER_SITE', 'user-packages');
  const env: Record<string, string | undefined> = { app_plugin_python_runtime: 'spoofed' };
  await appendPluginPythonRuntimeToEnv(env);
  const runtime = JSON.parse(env[APP_PLUGIN_PYTHON_RUNTIME_ENV]!);
  expect(runtime.version).toBe('3.12.10');
  expect(runtime.standardLibraryPaths).toEqual([path.join(root, 'python312.zip'), root]);
  expect(runtime.files.map((file: { path: string }) => file.path)).toContain(path.join(root, 'Lib', 'site-packages', 'sitecustomize.py'));
  expect(env.app_plugin_python_runtime).toBeUndefined();
  const [executable, args, options] = mocks.execute.mock.calls[0];
  expect(executable).toBe(path.join(root, 'python.exe'));
  expect(args.slice(0, 3)).toEqual(['-I', '-B', '-c']);
  expect(options).toMatchObject({ windowsHide: true, timeout: 10000, maxBuffer: 16384 });
  expect(options.env.PYTHONPATH).toBeUndefined();
  expect(options.env.JUSTDO_PYTHON_USER_SITE).toBeUndefined();
  await getPluginPythonRuntime();
  expect(mocks.execute).toHaveBeenCalledTimes(1);
});

test('removes inherited claims when unavailable and allows a later explicit read after transient failure', async () => {
  mocks.root = null;
  const env: Record<string, string | undefined> = { [APP_PLUGIN_PYTHON_RUNTIME_ENV]: 'spoofed', app_plugin_python_runtime: 'spoofed' };
  await appendPluginPythonRuntimeToEnv(env);
  expect(env).toEqual({});
  mocks.root = root;
  mocks.execute.mockImplementationOnce((_exe, _args, _options, done) => done(new Error('timeout')));
  expect(await getPluginPythonRuntime()).toBeNull();
  expect((await getPluginPythonRuntime())?.version).toBe('3.12.10');
  expect(mocks.execute).toHaveBeenCalledTimes(2);
});

test('rejects a runtime replaced while its availability probe is pending', async () => {
  mocks.execute.mockImplementationOnce((_exe, _args, _options, done) => {
    fs.writeFileSync(path.join(root, 'python312._pth'), 'replacement configuration');
    done(null, JSON.stringify({ implementation: 'cpython', version: '3.12.10', platform: 'win32',
      bits: 64, executable: path.join(root, 'python.exe') }));
  });
  expect(await getPluginPythonRuntime()).toBeNull();
});
