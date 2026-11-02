import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  APP_PLUGIN_PYTHON_RUNTIME_ENV,
  type AppPythonRuntime,
  createHostPythonEnvironment,
  parseHostPythonRuntime,
  verifyHostPythonRuntime,
} from '../../../../plugins/sdk/app-plugin-sdk/runtimes';
import { getBundledPythonRoot } from './pythonRuntime';

const SITE_CUSTOMIZE = path.join('Lib', 'site-packages', 'sitecustomize.py');
const PROBE_SOURCE = 'import json,sys;print(json.dumps({"implementation":sys.implementation.name,"version":".".join(map(str,sys.version_info[:3])),"platform":sys.platform,"bits":64 if sys.maxsize>2**32 else 32,"executable":sys.executable}))';
let cached: { fingerprint: string; runtime: Promise<AppPythonRuntime | null> } | undefined;

function inventory(root: string): string[] {
  return [...fs.readdirSync(root).filter(name => /\.(?:exe|dll|pyd|zip|_pth)$/iu.test(name)), SITE_CUSTOMIZE]
    .map(file => path.join(root, file)).sort();
}

function fingerprint(files: string[]): string {
  return JSON.stringify(files.map(file => {
    const info = fs.lstatSync(file, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || fs.realpathSync(file) !== file)
      throw new Error('Managed Python runtime is unavailable');
    return [file, info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String);
  }));
}

async function probe(root: string, files: string[], before: string): Promise<AppPythonRuntime | null> {
  try {
    const executable = path.join(root, 'python.exe');
    const raw = await new Promise<string>((resolve, reject) => {
      execFile(executable, ['-I', '-B', '-c', PROBE_SOURCE], {
        cwd: root, env: createHostPythonEnvironment(), windowsHide: true, encoding: 'utf8',
        timeout: 10_000, maxBuffer: 16 * 1024,
      }, (error, stdout) => error ? reject(error) : resolve(stdout));
    });
    const info = JSON.parse(raw);
    if (info.implementation !== 'cpython' || info.platform !== 'win32' || info.bits !== 64 ||
      typeof info.version !== 'string' || !/^3\.\d+\.\d+$/u.test(info.version) ||
      fs.realpathSync(info.executable) !== executable || before !== fingerprint(files)) return null;
    const tag = info.version.split('.').slice(0, 2).join('');
    const required = ['python.exe', 'python3.dll', `python${tag}.dll`, `python${tag}.zip`, `python${tag}._pth`, SITE_CUSTOMIZE];
    if (!required.every(file => files.includes(path.join(root, file)))) return null;
    const runtime = parseHostPythonRuntime({ schemaVersion: 1, implementation: 'cpython',
      version: info.version, platform: 'win32', architecture: 'x64', executable,
      standardLibraryPaths: [path.join(root, `python${tag}.zip`), root],
      files: files.map(file => ({ path: file, bytes: fs.statSync(file).size,
        sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') })),
    });
    if (!runtime || before !== fingerprint(files)) return null;
    verifyHostPythonRuntime(runtime);
    return runtime;
  } catch { return null; }
}

/** Resolve only the application-managed interpreter. This never searches PATH or downloads anything. */
export async function getPluginPythonRuntime(): Promise<AppPythonRuntime | null> {
  if (process.platform !== 'win32' || process.arch !== 'x64') return null;
  try {
    const candidate = getBundledPythonRoot();
    if (!candidate) return null;
    const root = fs.realpathSync(candidate);
    const files = inventory(root);
    const current = fingerprint(files);
    if (cached?.fingerprint !== current) cached = { fingerprint: current, runtime: probe(root, files, current) };
    const pending = cached;
    const runtime = await pending.runtime;
    if (!runtime && cached === pending) cached = undefined;
    if (runtime) verifyHostPythonRuntime(runtime);
    return runtime;
  } catch { return null; }
}

/** The managed launcher owns this transport; inherited values never establish provenance. */
export async function appendPluginPythonRuntimeToEnv(env: Record<string, string | undefined>): Promise<void> {
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === APP_PLUGIN_PYTHON_RUNTIME_ENV) delete env[key];
  }
  const runtime = await getPluginPythonRuntime();
  if (runtime) env[APP_PLUGIN_PYTHON_RUNTIME_ENV] = JSON.stringify(runtime);
}
