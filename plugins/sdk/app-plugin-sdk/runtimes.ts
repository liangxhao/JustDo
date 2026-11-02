import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

/** Host-owned availability metadata, never tool, file or execution authorization. */
export interface AppPythonRuntime {
  readonly schemaVersion: 1;
  readonly implementation: 'cpython';
  readonly version: string;
  readonly platform: 'win32' | 'darwin' | 'linux';
  readonly architecture: 'x64' | 'arm64';
  readonly executable: string;
  readonly standardLibraryPaths: readonly string[];
  readonly files: readonly { readonly path: string; readonly bytes: number; readonly sha256: string }[];
}

export const APP_PLUGIN_PYTHON_RUNTIME_ENV = 'APP_PLUGIN_PYTHON_RUNTIME';
const snapshots = new WeakMap<AppPythonRuntime, Map<string, string>>();
const hashes = new Map<string, { identity: string; sha256: string }>();
const MAX_DESCRIPTOR_BYTES = 64 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function absolute(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 &&
    !value.includes('\0') && path.isAbsolute(value) && path.normalize(value) === value;
}

function contained(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}

/** Validate an exact host descriptor without searching PATH or installing packages. */
export function parseHostPythonRuntime(value: unknown): AppPythonRuntime | null {
  if (!record(value) || !exactKeys(value, ['schemaVersion', 'implementation', 'version', 'platform',
    'architecture', 'executable', 'standardLibraryPaths', 'files']) || value.schemaVersion !== 1 ||
    value.implementation !== 'cpython' || typeof value.version !== 'string' ||
    !/^3\.(?:0|[1-9]\d?)\.(?:0|[1-9]\d{0,2})$/u.test(value.version) ||
    !['win32', 'darwin', 'linux'].includes(String(value.platform)) ||
    !['x64', 'arm64'].includes(String(value.architecture)) || !absolute(value.executable) ||
    !Array.isArray(value.standardLibraryPaths) || !value.standardLibraryPaths.length ||
    value.standardLibraryPaths.length > 8 || !value.standardLibraryPaths.every(absolute) ||
    new Set(value.standardLibraryPaths).size !== value.standardLibraryPaths.length ||
    !Array.isArray(value.files) || !value.files.length || value.files.length > 96) return null;
  const root = path.dirname(value.executable);
  if (!value.standardLibraryPaths.every(file => contained(root, file))) return null;
  const files: Array<AppPythonRuntime['files'][number]> = [];
  for (const item of value.files) {
    if (!record(item) || !exactKeys(item, ['path', 'bytes', 'sha256']) || !absolute(item.path) ||
      !contained(root, item.path) || !Number.isSafeInteger(item.bytes) || Number(item.bytes) <= 0 ||
      Number(item.bytes) > 128 * 1024 * 1024 || typeof item.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(item.sha256)) return null;
    files.push(Object.freeze({ path: item.path, bytes: Number(item.bytes), sha256: item.sha256 }));
  }
  if (new Set(files.map(file => file.path)).size !== files.length ||
    !files.some(file => file.path === value.executable) ||
    !value.standardLibraryPaths.every(file => file === root || files.some(entry => entry.path === file))) return null;
  return Object.freeze({ schemaVersion: 1, implementation: 'cpython', version: value.version,
    platform: value.platform as AppPythonRuntime['platform'],
    architecture: value.architecture as AppPythonRuntime['architecture'], executable: value.executable,
    standardLibraryPaths: Object.freeze([...value.standardLibraryPaths]), files: Object.freeze(files) });
}

function identity(file: string): string {
  const info = lstatSync(file, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || realpathSync(file) !== file)
    throw new Error('Host Python runtime is unavailable');
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
}

/** Validate current host files; retain a file-identity fence on this descriptor object. */
export function verifyHostPythonRuntime(runtime: AppPythonRuntime): void {
  if (!parseHostPythonRuntime(runtime) || runtime.platform !== process.platform || runtime.architecture !== process.arch)
    throw new Error('Host Python runtime is unavailable');
  const previous = snapshots.get(runtime);
  const current = new Map<string, string>();
  for (const file of runtime.files) {
    const before = identity(file.path);
    if (previous && previous.get(file.path) !== before) throw new Error('Host Python runtime changed');
    const cached = hashes.get(file.path);
    let sha256 = cached?.identity === before ? cached.sha256 : undefined;
    if (!sha256) {
      const content = readFileSync(file.path);
      if (content.byteLength !== file.bytes) throw new Error('Host Python runtime is unavailable');
      sha256 = createHash('sha256').update(content).digest('hex');
      if (before !== identity(file.path)) throw new Error('Host Python runtime changed');
      if (hashes.size >= 192) hashes.clear();
      hashes.set(file.path, { identity: before, sha256 });
    }
    if (sha256 !== file.sha256 || statSync(file.path).size !== file.bytes || before !== identity(file.path))
      throw new Error('Host Python runtime is unavailable');
    current.set(file.path, before);
  }
  for (const directory of runtime.standardLibraryPaths.filter(file => !runtime.files.some(entry => entry.path === file))) {
    if (directory !== path.dirname(runtime.executable) || realpathSync(directory) !== directory || !statSync(directory).isDirectory())
      throw new Error('Host Python runtime is unavailable');
  }
  snapshots.set(runtime, current);
}

/** Read the descriptor published by this managed Gateway's host. Missing means unavailable. */
export function resolveHostPythonRuntime(): AppPythonRuntime | null {
  try {
    const raw = process.env[APP_PLUGIN_PYTHON_RUNTIME_ENV];
    if (!raw || Buffer.byteLength(raw) > MAX_DESCRIPTOR_BYTES) return null;
    const runtime = parseHostPythonRuntime(JSON.parse(raw));
    if (!runtime) return null;
    verifyHostPythonRuntime(runtime);
    return runtime;
  } catch { return null; }
}

/** Recheck after asynchronous preparation, immediately before launch and before accepting output. */
export function assertHostPythonRuntimeCurrent(runtime: AppPythonRuntime): void {
  const raw = process.env[APP_PLUGIN_PYTHON_RUNTIME_ENV];
  if (!raw || Buffer.byteLength(raw) > MAX_DESCRIPTOR_BYTES ||
    JSON.stringify(parseHostPythonRuntime(JSON.parse(raw))) !== JSON.stringify(runtime))
    throw new Error('Host Python runtime changed');
  verifyHostPythonRuntime(runtime);
}

/** Minimal launch environment. Pass as an explicit base environment, not an inherited-env overlay. */
export function createHostPythonEnvironment(): Record<string, string> {
  const result: Record<string, string> = {};
  const allowed = new Set(['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PROCESSOR_ARCHITECTURE', 'TEMP', 'TMP']);
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && allowed.has(key.toUpperCase())) result[key.toUpperCase()] = value;
  }
  if (process.platform === 'win32') {
    const windows = result.SYSTEMROOT ?? result.WINDIR;
    if (windows) result.PATH = path.join(windows, 'System32');
  } else result.PATH = '/usr/bin:/bin';
  return result;
}
