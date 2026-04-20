import { execSync, spawn, spawnSync } from 'child_process';
import { app, BrowserWindow } from 'electron';
import fs from 'fs';
import yaml from 'js-yaml';
import path from 'path';

import { cpRecursiveSync } from './fsCompat';
import { getElectronNodeRuntimePath } from './libs/coworkUtil';
import { appendPythonRuntimeToEnv } from './libs/pythonRuntime';
import { SqliteStore } from './sqliteStore';

/**
 * Resolve the user's login shell PATH on macOS/Linux.
 * Packaged Electron apps on macOS don't inherit the user's shell profile,
 * so node/npm won't be in PATH unless we resolve it explicitly.
 */
function resolveUserShellPath(): string | null {
  if (process.platform === 'win32') return null;

  try {
    const shell = process.env.SHELL || '/bin/bash';
    // Use non-interactive login shell to avoid side effects in interactive startup scripts.
    const result = execSync(`${shell} -lc 'echo __PATH__=$PATH'`, {
      encoding: 'utf-8',
      timeout: 5000,
      env: { ...process.env },
    });
    const match = result.match(/__PATH__=(.+)/);
    return match ? match[1].trim() : null;
  } catch (error) {
    console.warn('[skills] Failed to resolve user shell PATH:', error);
    return null;
  }
}

/**
 * Check if a command exists in the given environment.
 */
function hasCommand(command: string, env: NodeJS.ProcessEnv): boolean {
  const isWin = process.platform === 'win32';
  const checker = isWin ? 'where' : 'which';
  // On Windows, use shell: true so cmd.exe resolves PATH correctly
  // (avoids issues with duplicated PATH/Path keys in env)
  const result = spawnSync(checker, [command], {
    stdio: 'pipe',
    env,
    shell: isWin,
    timeout: 5000,
  });
  if (result.status !== 0) {
    console.log(
      `[skills] hasCommand('${command}'): not found (status=${result.status}, error=${result.error?.message || 'none'})`,
    );
  }
  return result.status === 0;
}

/**
 * Normalize the PATH key in an env object on Windows.
 * Windows env vars are case-insensitive, but JS objects are case-sensitive.
 * After spreading process.env, the key might be "Path" or "PATH".
 * We normalize to "PATH" to avoid issues with duplicate keys.
 */
function normalizePathKey(env: Record<string, string | undefined>): void {
  if (process.platform !== 'win32') return;

  const pathKeys = Object.keys(env).filter(k => k.toLowerCase() === 'path');
  if (pathKeys.length <= 1) return;

  // Merge all PATH-like values (separated by ;), then remove duplicates
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const key of pathKeys) {
    const value = env[key];
    if (!value) continue;
    for (const entry of value.split(';')) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const normalized = trimmed.toLowerCase().replace(/[\\/]+$/, '');
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      merged.push(trimmed);
    }
    if (key !== 'PATH') {
      delete env[key];
    }
  }
  env.PATH = merged.join(';');
}

/**
 * Resolve the latest Windows system PATH from the registry.
 * When an Electron app is launched from Start Menu or Explorer,
 * process.env.PATH may be stale (missing tools installed after Explorer started).
 */
function resolveWindowsRegistryPath(): string | null {
  if (process.platform !== 'win32') return null;

  try {
    const machinePath = execSync(
      'reg query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" /v Path',
      { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const userPath = execSync('reg query "HKCU\\Environment" /v Path', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    const extract = (output: string): string => {
      const match = output.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.+)/i);
      return match ? match[1].trim() : '';
    };

    const combined = [extract(machinePath), extract(userPath)].filter(Boolean).join(';');
    return combined || null;
  } catch {
    return null;
  }
}

/**
 * Build an environment for spawning skill scripts.
 * Merges the user's shell PATH with the current process environment.
 */
function buildSkillEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };

  // Normalize PATH key casing on Windows to avoid duplicate PATH/Path issues
  normalizePathKey(env);

  if (app.isPackaged) {
    // Ensure HOME is set (crucial for npm to find its config)
    if (!env.HOME) {
      env.HOME = app.getPath('home');
    }

    if (process.platform === 'win32') {
      // On Windows, merge the latest PATH from the registry to pick up
      // tools installed after the Electron app (or Explorer) was started.
      const registryPath = resolveWindowsRegistryPath();
      if (registryPath) {
        const currentPath = env.PATH || '';
        const seen = new Set(
          currentPath
            .toLowerCase()
            .split(';')
            .map(s => s.trim().replace(/[\\/]+$/, ''))
            .filter(Boolean),
        );
        const extra: string[] = [];
        for (const entry of registryPath.split(';')) {
          const trimmed = entry.trim();
          if (!trimmed) continue;
          const key = trimmed.toLowerCase().replace(/[\\/]+$/, '');
          if (!seen.has(key)) {
            seen.add(key);
            extra.push(trimmed);
          }
        }
        if (extra.length > 0) {
          env.PATH = currentPath ? `${currentPath};${extra.join(';')}` : extra.join(';');
          console.log('[skills] Merged registry PATH entries for skill scripts');
        }
      }

      // Append common Windows Node.js installation paths as fallback
      const commonWinPaths = [
        'C:\\Program Files\\nodejs',
        'C:\\Program Files (x86)\\nodejs',
        `${env.APPDATA || ''}\\npm`,
        `${env.LOCALAPPDATA || ''}\\Programs\\nodejs`,
      ].filter(Boolean);

      const pathSet = new Set(
        (env.PATH || '')
          .toLowerCase()
          .split(';')
          .map(s => s.trim().replace(/[\\/]+$/, '')),
      );
      const missingPaths = commonWinPaths.filter(
        p => !pathSet.has(p.toLowerCase().replace(/[\\/]+$/, '')),
      );
      if (missingPaths.length > 0) {
        env.PATH = env.PATH ? `${env.PATH};${missingPaths.join(';')}` : missingPaths.join(';');
      }
    } else {
      // Resolve user's shell PATH to find npm/node (macOS/Linux)
      const userPath = resolveUserShellPath();
      if (userPath) {
        env.PATH = userPath;
        console.log('[skills] Resolved user shell PATH for skill scripts');
      } else {
        // Fallback: append common node installation paths
        const commonPaths = [
          '/usr/local/bin',
          '/opt/homebrew/bin',
          `${env.HOME}/.nvm/current/bin`,
          `${env.HOME}/.volta/bin`,
          `${env.HOME}/.fnm/current/bin`,
        ];
        env.PATH = [env.PATH, ...commonPaths].filter(Boolean).join(':');
        console.log('[skills] Using fallback PATH for skill scripts');
      }
    }
  }

  // Expose Electron executable so skill scripts can run JS with ELECTRON_RUN_AS_NODE
  // even when system Node.js is not installed.
  env.GUCCIAI_ELECTRON_PATH = getElectronNodeRuntimePath();
  appendPythonRuntimeToEnv(env);

  // Re-normalize after appendPythonRuntimeToEnv may have added a PATH key
  normalizePathKey(env);

  return env;
}

export type SkillRecord = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  isOfficial: boolean;
  isBuiltIn: boolean;
  updatedAt: number;
  prompt: string;
  skillPath: string;
  version?: string;
};

type SkillStateMap = Record<string, { enabled: boolean }>;

type EmailConnectivityCheckCode = 'imap_connection' | 'smtp_connection';
type EmailConnectivityCheckLevel = 'pass' | 'fail';
type EmailConnectivityVerdict = 'pass' | 'fail';

type EmailConnectivityCheck = {
  code: EmailConnectivityCheckCode;
  level: EmailConnectivityCheckLevel;
  message: string;
  durationMs: number;
};

type EmailConnectivityTestResult = {
  testedAt: number;
  verdict: EmailConnectivityVerdict;
  checks: EmailConnectivityCheck[];
};

type SkillDefaultConfig = {
  order?: number;
  enabled?: boolean;
};

type SkillsConfig = {
  version: number;
  description?: string;
  defaults: Record<string, SkillDefaultConfig>;
};

const SKILLS_DIR_NAME = 'skills';
const SKILL_FILE_NAME = 'SKILL.md';
const SKILLS_CONFIG_FILE = 'skills.config.json';
const SKILL_STATE_KEY = 'skills_state';
const WATCH_DEBOUNCE_MS = 250;

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

const parseFrontmatter = (
  raw: string,
): { frontmatter: Record<string, unknown>; content: string } => {
  const normalized = raw.replace(/^\uFEFF/, '');
  const match = normalized.match(FRONTMATTER_RE);
  if (!match) {
    return { frontmatter: {}, content: normalized };
  }

  let frontmatter: Record<string, unknown> = {};
  try {
    const parsed = yaml.load(match[1]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      frontmatter = parsed as Record<string, unknown>;
    }
  } catch (e) {
    console.warn('[skills] Failed to parse YAML frontmatter:', e);
  }

  const content = normalized.slice(match[0].length);
  return { frontmatter, content };
};

const isTruthy = (value?: unknown): boolean => {
  if (value === true) return true;
  if (!value) return false;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === 'yes' || normalized === '1';
};

const extractDescription = (content: string): string => {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    return trimmed.replace(/^#+\s*/, '');
  }
  return '';
};

const normalizeFolderName = (name: string): string => {
  const normalized = name.replace(/[^a-zA-Z0-9-_]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'skill';
};

const isZipFile = (filePath: string): boolean => path.extname(filePath).toLowerCase() === '.zip';

/**
 * Compare two semver-like version strings (e.g. "1.0.0" vs "1.0.1").
 * Returns 1 if a > b, -1 if a < b, 0 if equal.
 * Non-numeric segments are treated as 0.
 */
const compareVersions = (a: string, b: string): number => {
  const pa = a.split('.').map(s => parseInt(s, 10) || 0);
  const pb = b.split('.').map(s => parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
};

const resolveWithin = (root: string, target: string): string => {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(root, target);
  if (resolvedTarget === resolvedRoot) return resolvedTarget;
  if (!resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    throw new Error('Invalid target path');
  }
  return resolvedTarget;
};

const appendEnvPath = (current: string | undefined, entries: string[]): string => {
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const existing = (current || '').split(delimiter).filter(Boolean);
  const merged = [...existing];
  entries.forEach(entry => {
    if (!entry || merged.includes(entry)) return;
    merged.push(entry);
  });
  return merged.join(delimiter);
};

const listWindowsCommandPaths = (command: string): string[] => {
  if (process.platform !== 'win32') return [];

  try {
    const result = spawnSync('cmd.exe', ['/d', '/s', '/c', command], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status !== 0) return [];
    return result.stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
};

const resolveWindowsGitExecutable = (): string | null => {
  if (process.platform !== 'win32') return null;

  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA || '';
  const userProfile = process.env.USERPROFILE || '';

  const installedCandidates = [
    path.join(programFiles, 'Git', 'cmd', 'git.exe'),
    path.join(programFiles, 'Git', 'bin', 'git.exe'),
    path.join(programFilesX86, 'Git', 'cmd', 'git.exe'),
    path.join(programFilesX86, 'Git', 'bin', 'git.exe'),
    path.join(localAppData, 'Programs', 'Git', 'cmd', 'git.exe'),
    path.join(localAppData, 'Programs', 'Git', 'bin', 'git.exe'),
    path.join(userProfile, 'scoop', 'apps', 'git', 'current', 'cmd', 'git.exe'),
    path.join(userProfile, 'scoop', 'apps', 'git', 'current', 'bin', 'git.exe'),
    'C:\\Git\\cmd\\git.exe',
    'C:\\Git\\bin\\git.exe',
  ];

  for (const candidate of installedCandidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const whereCandidates = listWindowsCommandPaths('where git');
  for (const candidate of whereCandidates) {
    const normalized = candidate.trim();
    if (!normalized) continue;
    if (normalized.toLowerCase().endsWith('git.exe') && fs.existsSync(normalized)) {
      return normalized;
    }
  }

  const bundledRoots = app.isPackaged
    ? [path.join(process.resourcesPath, 'mingit')]
    : [
        path.join(__dirname, '..', '..', 'resources', 'mingit'),
        path.join(process.cwd(), 'resources', 'mingit'),
      ];

  for (const root of bundledRoots) {
    const bundledCandidates = [
      path.join(root, 'cmd', 'git.exe'),
      path.join(root, 'bin', 'git.exe'),
      path.join(root, 'mingw64', 'bin', 'git.exe'),
      path.join(root, 'usr', 'bin', 'git.exe'),
    ];
    for (const candidate of bundledCandidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
};

const resolveGitCommand = (): { command: string; env?: NodeJS.ProcessEnv } => {
  if (process.platform !== 'win32') {
    return { command: 'git' };
  }

  const gitExe = resolveWindowsGitExecutable();
  if (!gitExe) {
    return { command: 'git' };
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  const gitDir = path.dirname(gitExe);
  const gitRoot = path.dirname(gitDir);
  const candidateDirs = [
    gitDir,
    path.join(gitRoot, 'cmd'),
    path.join(gitRoot, 'bin'),
    path.join(gitRoot, 'mingw64', 'bin'),
    path.join(gitRoot, 'usr', 'bin'),
  ].filter(dir => fs.existsSync(dir));

  env.PATH = appendEnvPath(env.PATH, candidateDirs);
  return { command: gitExe, env };
};

/**
 * On Windows, ensure a Node.js --require init script that monkey-patches
 * child_process so all descendant processes inherit windowsHide: true.
 * Returns the script path, or null on non-Windows / failure.
 */
const WINDOWS_HIDE_SCRIPT = [
  "'use strict';",
  'if (process.platform === "win32") {',
  '  const cp = require("child_process");',
  '  const hide = (o) => {',
  '    if (o == null) return { windowsHide: true };',
  '    if (typeof o !== "object") return o;',
  '    if (Object.prototype.hasOwnProperty.call(o, "windowsHide")) return o;',
  '    return { ...o, windowsHide: true };',
  '  };',
  '  for (const fn of ["spawn", "spawnSync", "exec", "execFile", "fork"]) {',
  '    const orig = cp[fn];',
  '    if (typeof orig !== "function") continue;',
  '    cp[fn] = function (...a) {',
  '      const optsIdx = fn === "exec" ? 1 : fn === "fork" || fn === "spawn" || fn === "spawnSync" || fn === "execFile" ? 2 : 1;',
  '      if (a.length > optsIdx && typeof a[optsIdx] === "object" && a[optsIdx] !== null) {',
  '        a[optsIdx] = hide(a[optsIdx]);',
  '      } else if (a.length === optsIdx) {',
  '        a.push(hide(undefined));',
  '      }',
  '      return orig.apply(this, a);',
  '    };',
  '  }',
  '}',
].join('\n');

let _windowsHideScriptPath: string | null | undefined;

const ensureWindowsHideScript = (): string | null => {
  if (process.platform !== 'win32') return null;
  if (_windowsHideScriptPath !== undefined) return _windowsHideScriptPath;
  try {
    const dir = path.join(app.getPath('userData'), 'bin');
    fs.mkdirSync(dir, { recursive: true });
    const scriptPath = path.join(dir, 'skill_windows_hide.cjs');
    const existing = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, 'utf8') : '';
    if (existing !== WINDOWS_HIDE_SCRIPT) {
      fs.writeFileSync(scriptPath, WINDOWS_HIDE_SCRIPT, 'utf8');
    }
    _windowsHideScriptPath = scriptPath;
    return scriptPath;
  } catch {
    _windowsHideScriptPath = null;
    return null;
  }
};

const runCommand = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options?.cwd,
      env: options?.env,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.on('error', error => reject(error));
    child.on('close', code => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `Command failed with exit code ${code}`));
    });
  });

type SkillScriptRunResult = {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  error?: string;
  spawnErrorCode?: string;
};

const runScriptWithTimeout = (options: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<SkillScriptRunResult> =>
  new Promise(resolve => {
    const startedAt = Date.now();
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let timedOut = false;
    let stdout = '';
    let stderr = '';
    let forceKillTimer: NodeJS.Timeout | null = null;

    const settle = (result: SkillScriptRunResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, 2000);
    }, options.timeoutMs);

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      settle({
        success: false,
        exitCode: null,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        durationMs: Date.now() - startedAt,
        timedOut,
        error: error.message,
        spawnErrorCode: error.code,
      });
    });

    child.on('close', exitCode => {
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      settle({
        success: !timedOut && exitCode === 0,
        exitCode,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        durationMs: Date.now() - startedAt,
        timedOut,
        error: timedOut ? `Command timed out after ${options.timeoutMs}ms` : undefined,
      });
    });
  });

const cleanupPathSafely = (targetPath: string | null): void => {
  if (!targetPath) return;
  try {
    fs.rmSync(targetPath, {
      recursive: true,
      force: true,
      maxRetries: process.platform === 'win32' ? 5 : 0,
      retryDelay: process.platform === 'win32' ? 200 : 0,
    });
  } catch (error) {
    console.warn('[skills] Failed to cleanup temporary directory:', targetPath, error);
  }
};

const listSkillDirs = (root: string): string[] => {
  if (!fs.existsSync(root)) return [];
  const skillFile = path.join(root, SKILL_FILE_NAME);
  if (fs.existsSync(skillFile)) {
    return [root];
  }

  const entries = fs.readdirSync(root);
  return entries
    .map(entry => path.join(root, entry))
    .filter(entryPath => {
      try {
        const stat = fs.lstatSync(entryPath);
        if (!stat.isDirectory() && !stat.isSymbolicLink()) {
          return false;
        }
        return fs.existsSync(path.join(entryPath, SKILL_FILE_NAME));
      } catch {
        return false;
      }
    });
};

const isWebSearchSkillBroken = (skillRoot: string): boolean => {
  const startServerScript = path.join(skillRoot, 'scripts', 'start-server.sh');
  const searchScript = path.join(skillRoot, 'scripts', 'search.sh');
  const serverEntry = path.join(skillRoot, 'dist', 'server', 'index.js');
  const requiredPaths = [
    startServerScript,
    searchScript,
    serverEntry,
    path.join(skillRoot, 'node_modules', 'iconv-lite', 'encodings', 'index.js'),
  ];

  if (requiredPaths.some(requiredPath => !fs.existsSync(requiredPath))) {
    return true;
  }

  try {
    const startScript = fs.readFileSync(startServerScript, 'utf-8');
    const searchScriptContent = fs.readFileSync(searchScript, 'utf-8');
    const serverEntryContent = fs.readFileSync(serverEntry, 'utf-8');
    if (!startScript.includes('WEB_SEARCH_FORCE_REPAIR')) {
      return true;
    }
    if (!startScript.includes('detect_healthy_bridge_server')) {
      return true;
    }
    if (!searchScriptContent.includes('ACTIVE_SERVER_URL')) {
      return true;
    }
    if (!searchScriptContent.includes('try_switch_to_local_server')) {
      return true;
    }
    if (!searchScriptContent.includes('build_search_payload')) {
      return true;
    }
    if (!searchScriptContent.includes('@query_file')) {
      return true;
    }
    if (!serverEntryContent.includes('decodeJsonRequestBody')) {
      return true;
    }
    if (!serverEntryContent.includes("TextDecoder('gb18030'")) {
      return true;
    }
    if (
      serverEntryContent.includes('scoreDecodedJsonText') &&
      serverEntryContent.includes('Request body decoded using gb18030 (score')
    ) {
      return true;
    }
  } catch {
    return true;
  }

  return false;
};

export class SkillManager {
  private watchers: fs.FSWatcher[] = [];
  private notifyTimer: NodeJS.Timeout | null = null;
  private changeListeners: Array<() => void> = [];

  constructor(private getStore: () => SqliteStore) {}

  getSkillsRoot(): string {
    // User imported skills are stored in Gateway managed directory
    // userData/openclaw/state/skills
    return this.getGatewayManagedSkillsDir();
  }

  /**
   * Get the Gateway managed skills directory.
   * Gateway loads skills from stateDir/skills where stateDir = userData/openclaw/state.
   * Imported skills should be placed here so Gateway can discover them.
   */
  getGatewayManagedSkillsDir(): string {
    // Gateway's stateDir is userData/openclaw/state (same as openclawEngineManager)
    const userDataPath = app.getPath('userData');
    const stateDir = path.join(userDataPath, 'openclaw', 'state');
    return path.join(stateDir, 'skills');
  }

  ensureSkillsRoot(): string {
    const root = this.getSkillsRoot();
    // Don't auto-create this directory anymore.
    // Skills are now managed by Gateway via skills.status RPC.
    // This path is kept for backward compatibility with getSkillRoots().
    return root;
  }

  ensureGatewayManagedSkillsDir(): string {
    const root = this.getGatewayManagedSkillsDir();
    if (!fs.existsSync(root)) {
      fs.mkdirSync(root, { recursive: true });
    }
    return root;
  }

  syncBundledSkillsToUserData(): void {
    // Deprecated: Skills are now managed by Gateway via skills.status RPC.
    // Bundled skills are loaded directly from Resources/skills by Gateway.
    // This function no longer creates the userData/skills directory.
    console.log('[skills] syncBundledSkillsToUserData: deprecated, skipping');
  }

  /**
   * Check if a skill's runtime is healthy by comparing with bundled version.
   * Returns false if bundled has dependencies but target doesn't.
   */
  private isSkillRuntimeHealthy(targetDir: string, bundledDir: string): boolean {
    const bundledNodeModules = path.join(bundledDir, 'node_modules');
    const targetNodeModules = path.join(targetDir, 'node_modules');
    const targetPackageJson = path.join(targetDir, 'package.json');

    // If target has no package.json, it's a simple skill (no deps needed)
    if (!fs.existsSync(targetPackageJson)) {
      return true;
    }

    // If bundled doesn't have node_modules, no deps to sync
    if (!fs.existsSync(bundledNodeModules)) {
      return true;
    }

    // If bundled has node_modules but target doesn't, needs repair
    if (!fs.existsSync(targetNodeModules)) {
      return false;
    }

    return true;
  }

  private getSkillVersion(skillDir: string): string {
    try {
      const raw = fs.readFileSync(path.join(skillDir, SKILL_FILE_NAME), 'utf8');
      const { frontmatter } = parseFrontmatter(raw);
      const meta = frontmatter.metadata as Record<string, unknown> | undefined;
      const v = frontmatter.version ?? meta?.version;
      return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
    } catch {
      return '';
    }
  }

  private mergeSkillsConfig(bundledPath: string, targetPath: string): void {
    try {
      const bundled = JSON.parse(fs.readFileSync(bundledPath, 'utf-8'));
      const target = JSON.parse(fs.readFileSync(targetPath, 'utf-8'));
      if (!bundled.defaults || !target.defaults) return;
      let changed = false;
      for (const [id, config] of Object.entries(bundled.defaults)) {
        if (!(id in target.defaults)) {
          target.defaults[id] = config;
          changed = true;
        }
      }
      if (changed) {
        // Write to temp file first, then rename for atomic update
        const tmpPath = targetPath + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(target, null, 2) + '\n', 'utf-8');
        fs.renameSync(tmpPath, targetPath);
        console.log('[skills] mergeSkillsConfig: merged new skill entries into user config');
      }
    } catch (e) {
      console.warn('[skills] Failed to merge skills config:', e);
    }
  }

  listSkills(): SkillRecord[] {
    // Use Gateway managed skills directory as primary root
    const gatewayRoot = this.getGatewayManagedSkillsDir();
    const state = this.loadSkillStateMap();
    const roots = this.getSkillRoots(gatewayRoot);
    // Gateway root is last in priority (bundled skills override user skills if same ID)
    const orderedRoots = roots.filter(root => root !== gatewayRoot).concat(gatewayRoot);
    const defaults = this.loadSkillsDefaults(roots);
    const builtInSkillIds = this.listBuiltInSkillIds();
    const skillMap = new Map<string, SkillRecord>();

    orderedRoots.forEach(root => {
      if (!fs.existsSync(root)) return;
      const skillDirs = listSkillDirs(root);
      skillDirs.forEach(dir => {
        const skill = this.parseSkillDir(
          dir,
          state,
          defaults,
          builtInSkillIds.has(path.basename(dir)),
        );
        if (!skill) return;
        skillMap.set(skill.id, skill);
      });
    });

    const skills = Array.from(skillMap.values());

    skills.sort((a, b) => {
      const orderA = defaults[a.id]?.order ?? 999;
      const orderB = defaults[b.id]?.order ?? 999;
      if (orderA !== orderB) return orderA - orderB;
      return a.name.localeCompare(b.name);
    });
    return skills;
  }

  buildAutoRoutingPrompt(): string | null {
    const skills = this.listSkills();
    const enabled = skills.filter(s => s.enabled && s.prompt);
    if (enabled.length === 0) return null;

    const skillEntries = enabled
      .map(
        s =>
          `  <skill><id>${s.id}</id><name>${s.name}</name><description>${s.description}</description><location>${s.skillPath}</location></skill>`,
      )
      .join('\n');

    return [
      '## Skills (mandatory)',
      'Before replying: scan <available_skills> <description> entries.',
      '- If exactly one skill clearly applies: read its SKILL.md at <location> with the Read tool, then follow it.',
      '- If multiple could apply: choose the most specific one, then read/follow it.',
      '- If none clearly apply: do not read any SKILL.md.',
      '- IMPORTANT: If a description contains "Do NOT use" constraints, strictly respect them. If the user\'s request falls into a "Do NOT" category, treat that skill as non-matching — do NOT read its SKILL.md.',
      '- For the selected skill, treat <location> as the canonical SKILL.md path.',
      '- Resolve relative paths mentioned by that SKILL.md against its directory (dirname(<location>)), not the workspace root.',
      'Constraints: never read more than one skill up front; only read additional skills if the first one explicitly references them.',
      '',
      '<available_skills>',
      skillEntries,
      '</available_skills>',
    ].join('\n');
  }

  setSkillEnabled(id: string, enabled: boolean): SkillRecord[] {
    const state = this.loadSkillStateMap();
    state[id] = { enabled };
    this.saveSkillStateMap(state);
    this.notifySkillsChanged();
    return this.listSkills();
  }

  deleteSkill(id: string): SkillRecord[] {
    // Use Gateway managed skills directory for deletion
    const root = this.getGatewayManagedSkillsDir();
    if (id !== path.basename(id)) {
      throw new Error('Invalid skill id');
    }
    if (this.isBuiltInSkillId(id)) {
      throw new Error('Built-in skills cannot be deleted');
    }

    const targetDir = resolveWithin(root, id);
    if (!fs.existsSync(targetDir)) {
      throw new Error('Skill not found');
    }

    fs.rmSync(targetDir, { recursive: true, force: true });
    const state = this.loadSkillStateMap();
    delete state[id];
    this.saveSkillStateMap(state);
    this.startWatching();
    this.notifySkillsChanged();
    return this.listSkills();
  }

  /**
   * Import a skill from a compressed file (ZIP or TGZ).
   * Extracts the archive to the Gateway managed skills directory.
   */
  importSkill(archivePath: string): {
    success: boolean;
    skillId?: string;
    error?: string;
    skills?: SkillRecord[];
  } {
    try {
      // Use Gateway managed skills directory so imported skills are visible to Gateway
      const root = this.ensureGatewayManagedSkillsDir();

      // Validate archive exists
      if (!fs.existsSync(archivePath)) {
        return { success: false, error: 'Archive file not found' };
      }

      // Determine archive type
      const ext = path.extname(archivePath).toLowerCase();
      const isZip = ext === '.zip';
      const isTgz = ext === '.tgz' || archivePath.toLowerCase().endsWith('.tar.gz');

      if (!isZip && !isTgz) {
        return {
          success: false,
          error: 'Unsupported archive format. Only .zip and .tgz/.tar.gz are supported.',
        };
      }

      // Create temp directory for extraction with unique name
      // Extract to a subdirectory to avoid skillDir being tempDir itself
      const tempBase = path.join(
        root,
        `.import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      fs.mkdirSync(tempBase, { recursive: true });
      const extractDir = path.join(tempBase, 'extracted');
      fs.mkdirSync(extractDir, { recursive: true });

      try {
        // Extract archive to the nested extracted directory
        if (isZip) {
          this.extractZip(archivePath, extractDir);
        } else {
          this.extractTgz(archivePath, extractDir);
        }

        // Find skill directory (contains SKILL.md) - will be inside extractDir, not tempBase
        const skillDir = this.findSkillDirInExtracted(extractDir);
        if (!skillDir) {
          fs.rmSync(tempBase, { recursive: true, force: true });
          return {
            success: false,
            error: 'No valid skill found in archive. A skill must contain a SKILL.md file.',
          };
        }

        // Determine skill ID from SKILL.md name field (required for imports)
        const skillId = this.determineSkillIdFromFrontmatter(skillDir);
        if (!skillId) {
          fs.rmSync(tempBase, { recursive: true, force: true });
          return {
            success: false,
            error:
              'Could not determine skill ID. SKILL.md must have a valid "name" field in frontmatter.',
          };
        }

        // Validate skillId is not a temporary directory name
        if (skillId.startsWith('.') || skillId.startsWith('import-')) {
          fs.rmSync(tempBase, { recursive: true, force: true });
          return {
            success: false,
            error: `Invalid skill ID "${skillId}". SKILL.md name field must not produce hidden or temp names.`,
          };
        }

        // Check if skill already exists and remove it
        const targetDir = path.join(root, skillId);
        if (fs.existsSync(targetDir)) {
          // Stop watching temporarily to avoid EPERM on Windows
          this.stopWatching();
          try {
            fs.rmSync(targetDir, { recursive: true, force: true });
          } catch (rmError) {
            // On Windows, sometimes need retry after brief delay
            console.warn(`[skills] First removal attempt failed for ${skillId}, retrying...`);
            try {
              fs.rmSync(targetDir, { recursive: true, force: true });
            } catch (retryError) {
              // If still failing, restore watching and report error
              this.startWatching();
              throw new Error(
                `Failed to remove existing skill "${skillId}: ${retryError instanceof Error ? retryError.message : 'unknown error'}`,
              );
            }
          }
        }

        // Copy skill to target directory (more reliable than rename on Windows)
        // Using copy + remove avoids EPERM issues with locked directories
        fs.cpSync(skillDir, targetDir, { recursive: true, force: true });

        // Cleanup temp directory
        fs.rmSync(tempBase, { recursive: true, force: true });

        // Enable imported skill by default
        const state = this.loadSkillStateMap();
        state[skillId] = { enabled: true };
        this.saveSkillStateMap(state);

        // Refresh skill list (restart watching)
        this.startWatching();
        this.notifySkillsChanged();
        const skills = this.listSkills();

        return { success: true, skillId, skills };
      } catch (extractError) {
        // Cleanup on error and restore watching
        this.startWatching();
        if (fs.existsSync(tempBase)) {
          fs.rmSync(tempBase, { recursive: true, force: true });
        }
        throw extractError;
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to import skill';
      console.error('[skills] importSkill error:', errorMsg);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Import a skill directly from a folder (no archive extraction needed).
   * Copies the folder to the Gateway managed skills directory.
   */
  importSkillFromFolder(folderPath: string): {
    success: boolean;
    skillId?: string;
    error?: string;
    skills?: SkillRecord[];
  } {
    try {
      // Use Gateway managed skills directory so imported skills are visible to Gateway
      const root = this.ensureGatewayManagedSkillsDir();

      // Validate folder exists
      if (!fs.existsSync(folderPath)) {
        return { success: false, error: 'Folder not found' };
      }

      // Check if it's a directory
      try {
        const stat = fs.statSync(folderPath);
        if (!stat.isDirectory()) {
          return { success: false, error: 'Selected path is not a folder' };
        }
      } catch {
        return { success: false, error: 'Cannot access folder' };
      }

      // Check if folder contains SKILL.md
      const skillMdPath = path.join(folderPath, SKILL_FILE_NAME);
      if (!fs.existsSync(skillMdPath)) {
        return {
          success: false,
          error: 'No valid skill found in folder. A skill must contain a SKILL.md file.',
        };
      }

      // Determine skill ID from SKILL.md name field (required for imports)
      const skillId = this.determineSkillIdFromFrontmatter(folderPath);
      if (!skillId) {
        return {
          success: false,
          error:
            'Could not determine skill ID. SKILL.md must have a valid "name" field in frontmatter.',
        };
      }

      // Validate skillId is not a temporary directory name
      if (skillId.startsWith('.') || skillId.startsWith('import-')) {
        return {
          success: false,
          error: `Invalid skill ID "${skillId}". SKILL.md name field must not produce hidden or temp names.`,
        };
      }

      // Check if skill already exists and remove it
      const targetDir = path.join(root, skillId);
      if (fs.existsSync(targetDir)) {
        // Stop watching temporarily to avoid EPERM on Windows
        this.stopWatching();
        try {
          fs.rmSync(targetDir, { recursive: true, force: true });
        } catch (rmError) {
          // On Windows, sometimes need retry after brief delay
          console.warn(`[skills] First removal attempt failed for ${skillId}, retrying...`);
          try {
            fs.rmSync(targetDir, { recursive: true, force: true });
          } catch (retryError) {
            // If still failing, restore watching and report error
            this.startWatching();
            throw new Error(
              `Failed to remove existing skill "${skillId}: ${retryError instanceof Error ? retryError.message : 'unknown error'}`,
            );
          }
        }
      }

      // Copy skill folder to target directory
      fs.cpSync(folderPath, targetDir, { recursive: true, force: true });

      // Enable imported skill by default
      const state = this.loadSkillStateMap();
      state[skillId] = { enabled: true };
      this.saveSkillStateMap(state);

      // Refresh skill list (restart watching)
      this.startWatching();
      this.notifySkillsChanged();
      const skills = this.listSkills();

      return { success: true, skillId, skills };
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : 'Failed to import skill from folder';
      console.error('[skills] importSkillFromFolder error:', errorMsg);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Determine skill ID strictly from SKILL.md frontmatter name field.
   * Returns null if name field is missing or invalid (no fallback to directory name).
   */
  private determineSkillIdFromFrontmatter(skillDir: string): string | null {
    const skillMdPath = path.join(skillDir, SKILL_FILE_NAME);
    try {
      const content = fs.readFileSync(skillMdPath, 'utf8');
      // Parse YAML frontmatter for name
      const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
      if (frontmatterMatch) {
        const frontmatter = yaml.load(frontmatterMatch[1]) as Record<string, unknown> | undefined;
        if (frontmatter?.name && typeof frontmatter.name === 'string') {
          // Convert name to valid directory name (lowercase, replace spaces with hyphens)
          const normalized = frontmatter.name
            .toLowerCase()
            .replace(/[^a-z0-9_-]/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens
          if (normalized && !normalized.startsWith('.')) {
            return normalized;
          }
        }
      }
    } catch {
      // Fall through to return null
    }
    return null;
  }

  private extractZip(zipPath: string, targetDir: string): void {
    // Use PowerShell on Windows, unzip on macOS/Linux
    if (process.platform === 'win32') {
      execSync(
        `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${targetDir}' -Force"`,
        {
          timeout: 60000,
        },
      );
    } else {
      execSync(`unzip -o "${zipPath}" -d "${targetDir}"`, {
        timeout: 60000,
      });
    }
  }

  private extractTgz(tgzPath: string, targetDir: string): void {
    // Use tar (available on all platforms)
    execSync(`tar -xzf "${tgzPath}" -C "${targetDir}"`, {
      timeout: 60000,
    });
  }

  private findSkillDirInExtracted(dir: string): string | null {
    // Check if dir itself is a skill (contains SKILL.md)
    if (fs.existsSync(path.join(dir, SKILL_FILE_NAME))) {
      return dir;
    }

    // Search subdirectories for a skill
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      const entryPath = path.join(dir, entry);
      try {
        const stat = fs.statSync(entryPath);
        if (stat.isDirectory()) {
          if (fs.existsSync(path.join(entryPath, SKILL_FILE_NAME))) {
            return entryPath;
          }
          // Recursively search nested directories (handle archive with nested structure)
          const nested = this.findSkillDirInExtracted(entryPath);
          if (nested) return nested;
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  private determineSkillId(skillDir: string): string | null {
    // Try to read SKILL.md for name field
    const skillMdPath = path.join(skillDir, SKILL_FILE_NAME);
    try {
      const content = fs.readFileSync(skillMdPath, 'utf8');
      // Parse YAML frontmatter for name
      const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
      if (frontmatterMatch) {
        const frontmatter = yaml.load(frontmatterMatch[1]) as Record<string, unknown> | undefined;
        if (frontmatter?.name && typeof frontmatter.name === 'string') {
          // Convert name to valid directory name (lowercase, replace spaces with hyphens)
          return frontmatter.name
            .toLowerCase()
            .replace(/[^a-z0-9_-]/g, '-')
            .replace(/-+/g, '-');
        }
      }
    } catch {
      // Fall through to directory name
    }

    // Fallback: use directory name as skill ID
    return path.basename(skillDir);
  }

  startWatching(): void {
    this.stopWatching();
    const gatewayRoot = this.getGatewayManagedSkillsDir();
    const roots = this.getSkillRoots(gatewayRoot);

    // Root-level watch: only react to directory additions/removals (new/deleted skills).
    const rootWatchHandler = (_event: string, filename: string | null) => {
      if (!filename) {
        this.scheduleNotify();
        return;
      }
      // Ignore hidden files/dirs and known non-skill files
      if (filename.startsWith('.')) return;
      // Accept directory changes (new skill added/removed) and config file
      if (filename === SKILLS_CONFIG_FILE) {
        this.scheduleNotify();
        return;
      }
      // For other filenames, check if it looks like a skill directory entry
      // (no extension = likely a directory name)
      if (!path.extname(filename)) {
        this.scheduleNotify();
      }
    };

    // Skill-directory-level watch: only react to skill definition file changes.
    const skillDirWatchHandler = (_event: string, filename: string | null) => {
      if (!filename) {
        this.scheduleNotify();
        return;
      }
      if (filename === SKILL_FILE_NAME || filename === SKILLS_CONFIG_FILE) {
        this.scheduleNotify();
      }
      // Ignore cache files, data files, and any other non-definition files.
    };

    roots.forEach(root => {
      if (!fs.existsSync(root)) return;
      try {
        this.watchers.push(fs.watch(root, rootWatchHandler));
      } catch (error) {
        console.warn('[skills] Failed to watch skills root:', root, error);
      }

      const skillDirs = listSkillDirs(root);
      skillDirs.forEach(dir => {
        try {
          this.watchers.push(fs.watch(dir, skillDirWatchHandler));
        } catch (error) {
          console.warn('[skills] Failed to watch skill directory:', dir, error);
        }
      });
    });
  }

  stopWatching(): void {
    this.watchers.forEach(watcher => watcher.close());
    this.watchers = [];
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
    }
  }

  handleWorkingDirectoryChange(): void {
    this.startWatching();
    this.notifySkillsChanged();
  }

  private scheduleNotify(): void {
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
    }
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.startWatching();
      this.notifySkillsChanged();
    }, WATCH_DEBOUNCE_MS);
  }

  private notifySkillsChanged(): void {
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send('skills:changed');
      }
    });
    // Notify external listeners (e.g. OpenClaw AGENTS.md sync)
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch (error) {
        console.warn('[skills] onSkillsChanged listener error:', error);
      }
    }
  }

  onSkillsChanged(listener: () => void): () => void {
    this.changeListeners.push(listener);
    return () => {
      this.changeListeners = this.changeListeners.filter(l => l !== listener);
    };
  }

  private parseSkillDir(
    dir: string,
    state: SkillStateMap,
    defaults: Record<string, SkillDefaultConfig>,
    isBuiltIn: boolean,
  ): SkillRecord | null {
    const skillFile = path.join(dir, SKILL_FILE_NAME);
    if (!fs.existsSync(skillFile)) return null;
    try {
      const raw = fs.readFileSync(skillFile, 'utf8');
      const { frontmatter, content } = parseFrontmatter(raw);
      const name =
        (String(frontmatter.name || '') || path.basename(dir)).trim() || path.basename(dir);
      const description = (
        String(frontmatter.description || '') ||
        extractDescription(content) ||
        name
      ).trim();
      const isOfficial = isTruthy(frontmatter.official) || isTruthy(frontmatter.isOfficial);
      const meta = frontmatter.metadata as Record<string, unknown> | undefined;
      const v = frontmatter.version ?? meta?.version;
      const version = typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;
      const updatedAt = fs.statSync(skillFile).mtimeMs;
      const id = path.basename(dir);
      const prompt = content.trim();
      const defaultEnabled = defaults[id]?.enabled ?? true;
      const enabled = state[id]?.enabled ?? defaultEnabled;
      return {
        id,
        name,
        description,
        enabled,
        isOfficial,
        isBuiltIn,
        updatedAt,
        prompt,
        skillPath: skillFile,
        version,
      };
    } catch (error) {
      console.warn('[skills] Failed to parse skill:', dir, error);
      return null;
    }
  }

  private listBuiltInSkillIds(): Set<string> {
    const builtInRoot = this.getBundledSkillsRoot();
    if (!builtInRoot || !fs.existsSync(builtInRoot)) {
      return new Set();
    }
    return new Set(listSkillDirs(builtInRoot).map(dir => path.basename(dir)));
  }

  private isBuiltInSkillId(id: string): boolean {
    return this.listBuiltInSkillIds().has(id);
  }

  private loadSkillStateMap(): SkillStateMap {
    const store = this.getStore();
    const raw = store.get(SKILL_STATE_KEY) as SkillStateMap | SkillRecord[] | undefined;
    if (Array.isArray(raw)) {
      const migrated: SkillStateMap = {};
      raw.forEach(skill => {
        migrated[skill.id] = { enabled: skill.enabled };
      });
      store.set(SKILL_STATE_KEY, migrated);
      return migrated;
    }
    return raw ?? {};
  }

  private saveSkillStateMap(map: SkillStateMap): void {
    this.getStore().set(SKILL_STATE_KEY, map);
  }

  private loadSkillsDefaults(roots: string[]): Record<string, SkillDefaultConfig> {
    const merged: Record<string, SkillDefaultConfig> = {};

    // Load from roots in reverse order so higher priority roots override lower ones
    // roots[0] is user directory (highest priority), roots[1] is app-bundled (lower priority)
    const reversedRoots = [...roots].reverse();

    for (const root of reversedRoots) {
      const configPath = path.join(root, SKILLS_CONFIG_FILE);
      if (!fs.existsSync(configPath)) continue;

      try {
        const raw = fs.readFileSync(configPath, 'utf8');
        const config = JSON.parse(raw) as SkillsConfig;
        if (config.defaults && typeof config.defaults === 'object') {
          for (const [id, settings] of Object.entries(config.defaults)) {
            merged[id] = { ...merged[id], ...settings };
          }
        }
      } catch (error) {
        console.warn('[skills] Failed to load skills config:', configPath, error);
      }
    }

    return merged;
  }

  private getSkillRoots(primaryRoot?: string): string[] {
    const resolvedPrimary = primaryRoot ?? this.getSkillsRoot();
    const roots: string[] = [resolvedPrimary];

    const appRoot = this.getBundledSkillsRoot();
    if (appRoot !== resolvedPrimary && fs.existsSync(appRoot)) {
      roots.push(appRoot);
    }
    return roots;
  }

  private getBundledSkillsRoot(): string {
    if (app.isPackaged) {
      // In production, bundled skills are in Resources/skills.
      const resourcesRoot = path.resolve(process.resourcesPath, SKILLS_DIR_NAME);
      if (fs.existsSync(resourcesRoot)) {
        return resourcesRoot;
      }

      // Fallback for older packages where skills are inside app.asar.
      return path.resolve(app.getAppPath(), 'resources', SKILLS_DIR_NAME);
    }

    // In development, use resources/skills from the project root.
    // __dirname is dist-electron/, so we need to go up one level to get to project root
    const projectRoot = path.resolve(__dirname, '..');
    return path.resolve(projectRoot, 'resources', SKILLS_DIR_NAME);
  }

  getSkillConfig(skillId: string): {
    success: boolean;
    config?: Record<string, string>;
    error?: string;
  } {
    try {
      const skillDir = this.resolveSkillDir(skillId);
      const envPath = path.join(skillDir, '.env');
      if (!fs.existsSync(envPath)) {
        return { success: true, config: {} };
      }
      const raw = fs.readFileSync(envPath, 'utf8');
      const config: Record<string, string> = {};
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx < 0) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();
        // Strip surrounding quotes added by setSkillConfig / manual edits.
        // Double-quoted values may contain escape sequences (\", \\) that need reversal.
        // Single-quoted values are taken literally (no escape processing), matching dotenv behavior.
        if (value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        } else if (value.startsWith("'") && value.endsWith("'")) {
          value = value.slice(1, -1);
        }
        config[key] = value;
      }
      return { success: true, config };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to read skill config',
      };
    }
  }

  setSkillConfig(
    skillId: string,
    config: Record<string, string>,
  ): { success: boolean; error?: string } {
    try {
      const skillDir = this.resolveSkillDir(skillId);
      const envPath = path.join(skillDir, '.env');
      const lines = Object.entries(config)
        .filter(([key]) => key.trim())
        .map(([key, value]) => {
          // Wrap value in double quotes if it contains characters that dotenv
          // would misinterpret (e.g. # treated as inline comment, or spaces)
          if (
            value.includes('#') ||
            value.includes(' ') ||
            value.includes('"') ||
            value.includes("'")
          ) {
            // Escape any existing double quotes inside the value
            const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            return `${key}="${escaped}"`;
          }
          return `${key}=${value}`;
        });
      fs.writeFileSync(envPath, lines.join('\n') + '\n', 'utf8');
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to write skill config',
      };
    }
  }

  private repairSkillFromBundled(skillId: string, skillPath: string): boolean {
    if (!app.isPackaged) return false;

    const bundledRoot = this.getBundledSkillsRoot();
    if (!bundledRoot || !fs.existsSync(bundledRoot)) {
      return false;
    }

    const bundledPath = path.join(bundledRoot, skillId);
    if (!fs.existsSync(bundledPath) || bundledPath === skillPath) {
      return false;
    }

    // Check if bundled version has node_modules
    const bundledNodeModules = path.join(bundledPath, 'node_modules');
    if (!fs.existsSync(bundledNodeModules)) {
      console.log(`[skills] Bundled ${skillId} does not have node_modules, skipping repair`);
      return false;
    }

    try {
      console.log(`[skills] Repairing ${skillId} from bundled resources...`);
      fs.cpSync(bundledPath, skillPath, {
        recursive: true,
        dereference: true,
        force: true,
        errorOnExist: false,
      });
      console.log(`[skills] Repaired ${skillId} from bundled resources`);
      return true;
    } catch (error) {
      console.warn(`[skills] Failed to repair ${skillId} from bundled resources:`, error);
      return false;
    }
  }

  private ensureSkillDependencies(skillDir: string): { success: boolean; error?: string } {
    const nodeModulesPath = path.join(skillDir, 'node_modules');
    const packageJsonPath = path.join(skillDir, 'package.json');
    const skillId = path.basename(skillDir);

    console.log(`[skills] Checking dependencies for ${skillId}...`);
    console.log(`[skills]   node_modules exists: ${fs.existsSync(nodeModulesPath)}`);
    console.log(`[skills]   package.json exists: ${fs.existsSync(packageJsonPath)}`);
    console.log(`[skills]   skillDir: ${skillDir}`);

    // If node_modules exists, assume dependencies are installed
    if (fs.existsSync(nodeModulesPath)) {
      console.log(`[skills] Dependencies already installed for ${skillId}`);
      return { success: true };
    }

    // If no package.json, nothing to install
    if (!fs.existsSync(packageJsonPath)) {
      console.log(`[skills] No package.json found for ${skillId}, skipping install`);
      return { success: true };
    }

    // Try to repair from bundled resources first (works without npm)
    if (this.repairSkillFromBundled(skillId, skillDir)) {
      if (fs.existsSync(nodeModulesPath)) {
        console.log(`[skills] Dependencies restored from bundled resources for ${skillId}`);
        return { success: true };
      }
    }

    // Build environment with user's shell PATH (crucial for packaged apps)
    const env = buildSkillEnv() as NodeJS.ProcessEnv;
    const pathKeys = Object.keys(env).filter(k => k.toLowerCase() === 'path');
    console.log(`[skills]   PATH keys in env: ${JSON.stringify(pathKeys)}`);
    console.log(`[skills]   PATH (first 300 chars): ${env.PATH?.substring(0, 300)}`);

    // Check if npm is available
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    if (!hasCommand(npmCommand, env) && !hasCommand('npm', env)) {
      const errorMsg =
        'npm is not available and skill cannot be repaired from bundled resources. Please install Node.js from https://nodejs.org/';
      console.error(`[skills] ${errorMsg}`);
      return { success: false, error: errorMsg };
    }

    console.log(`[skills] npm is available`);

    // Try to install dependencies
    console.log(`[skills] Installing dependencies for ${skillId}...`);
    console.log(`[skills]   Working directory: ${skillDir}`);

    try {
      // On Windows, use shell: true so cmd.exe resolves npm.cmd correctly
      const isWin = process.platform === 'win32';
      const result = spawnSync('npm', ['install'], {
        cwd: skillDir,
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 120000, // 2 minute timeout
        env,
        shell: isWin,
      });

      console.log(`[skills] npm install exit code: ${result.status}`);
      if (result.stdout) {
        console.log(`[skills] npm install stdout: ${result.stdout.substring(0, 500)}`);
      }
      if (result.stderr) {
        console.log(`[skills] npm install stderr: ${result.stderr.substring(0, 500)}`);
      }

      if (result.status !== 0) {
        const errorMsg = result.stderr || result.stdout || 'npm install failed';
        console.error(`[skills] Failed to install dependencies for ${skillId}:`, errorMsg);
        return { success: false, error: `Failed to install dependencies: ${errorMsg}` };
      }

      // Verify node_modules was created
      if (!fs.existsSync(nodeModulesPath)) {
        const errorMsg = 'npm install appeared to succeed but node_modules was not created';
        console.error(`[skills] ${errorMsg}`);
        return { success: false, error: errorMsg };
      }

      console.log(`[skills] Dependencies installed successfully for ${skillId}`);
      return { success: true };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[skills] Error installing dependencies for ${skillId}:`, errorMsg);
      return { success: false, error: `Failed to install dependencies: ${errorMsg}` };
    }
  }

  async testEmailConnectivity(
    skillId: string,
    config: Record<string, string>,
  ): Promise<{ success: boolean; result?: EmailConnectivityTestResult; error?: string }> {
    try {
      const skillDir = this.resolveSkillDir(skillId);

      // Ensure dependencies are installed before running scripts
      const depsResult = this.ensureSkillDependencies(skillDir);
      if (!depsResult.success) {
        console.error('[email-connectivity] Dependency install failed:', depsResult.error);
        return { success: false, error: depsResult.error };
      }

      const imapScript = path.join(skillDir, 'scripts', 'imap.js');
      const smtpScript = path.join(skillDir, 'scripts', 'smtp.js');
      if (!fs.existsSync(imapScript) || !fs.existsSync(smtpScript)) {
        console.error('[email-connectivity] Scripts not found:', { imapScript, smtpScript });
        return { success: false, error: 'Email connectivity scripts not found' };
      }

      // Mask password for logging
      const safeConfig = { ...config };
      if (safeConfig.IMAP_PASS) safeConfig.IMAP_PASS = '***';
      if (safeConfig.SMTP_PASS) safeConfig.SMTP_PASS = '***';
      console.log('[email-connectivity] Testing with config:', JSON.stringify(safeConfig, null, 2));

      const envOverrides = Object.fromEntries(
        Object.entries(config ?? {})
          .filter(([key]) => key.trim())
          .map(([key, value]) => [key, String(value ?? '')]),
      );

      console.log('[email-connectivity] Running IMAP test (list-mailboxes)...');
      const imapResult = await this.runSkillScriptWithEnv(
        skillDir,
        imapScript,
        ['list-mailboxes'],
        envOverrides,
        20000,
      );
      console.log(
        '[email-connectivity] IMAP result:',
        JSON.stringify(
          {
            success: imapResult.success,
            exitCode: imapResult.exitCode,
            timedOut: imapResult.timedOut,
            durationMs: imapResult.durationMs,
            stdout: imapResult.stdout?.slice(0, 500),
            stderr: imapResult.stderr?.slice(0, 500),
            error: imapResult.error,
            spawnErrorCode: imapResult.spawnErrorCode,
          },
          null,
          2,
        ),
      );

      console.log('[email-connectivity] Running SMTP test (verify)...');
      const smtpResult = await this.runSkillScriptWithEnv(
        skillDir,
        smtpScript,
        ['verify'],
        envOverrides,
        20000,
      );
      console.log(
        '[email-connectivity] SMTP result:',
        JSON.stringify(
          {
            success: smtpResult.success,
            exitCode: smtpResult.exitCode,
            timedOut: smtpResult.timedOut,
            durationMs: smtpResult.durationMs,
            stdout: smtpResult.stdout?.slice(0, 500),
            stderr: smtpResult.stderr?.slice(0, 500),
            error: smtpResult.error,
            spawnErrorCode: smtpResult.spawnErrorCode,
          },
          null,
          2,
        ),
      );

      const checks: EmailConnectivityCheck[] = [
        this.buildEmailConnectivityCheck('imap_connection', imapResult),
        this.buildEmailConnectivityCheck('smtp_connection', smtpResult),
      ];
      const verdict: EmailConnectivityVerdict = checks.every(check => check.level === 'pass')
        ? 'pass'
        : 'fail';

      console.log(
        '[email-connectivity] Final verdict:',
        verdict,
        'checks:',
        JSON.stringify(checks, null, 2),
      );

      return {
        success: true,
        result: {
          testedAt: Date.now(),
          verdict,
          checks,
        },
      };
    } catch (error) {
      console.error('[email-connectivity] Unexpected error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to test email connectivity',
      };
    }
  }

  private resolveSkillDir(skillId: string): string {
    const skills = this.listSkills();
    const skill = skills.find(s => s.id === skillId);
    if (!skill) {
      throw new Error('Skill not found');
    }
    return path.dirname(skill.skillPath);
  }

  private getScriptRuntimeCandidates(
    env: NodeJS.ProcessEnv,
  ): Array<{ command: string; extraEnv?: NodeJS.ProcessEnv }> {
    const candidates: Array<{ command: string; extraEnv?: NodeJS.ProcessEnv }> = [];
    if (hasCommand('node', env)) {
      candidates.push({ command: 'node' });
    }
    candidates.push({
      command: getElectronNodeRuntimePath(),
      extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
    });
    return candidates;
  }

  private async runSkillScriptWithEnv(
    skillDir: string,
    scriptPath: string,
    scriptArgs: string[],
    envOverrides: Record<string, string>,
    timeoutMs: number,
  ): Promise<SkillScriptRunResult> {
    let lastResult: SkillScriptRunResult | null = null;

    // Build base environment with user's shell PATH
    const baseEnv = buildSkillEnv();

    for (const runtime of this.getScriptRuntimeCandidates(baseEnv as NodeJS.ProcessEnv)) {
      const env: NodeJS.ProcessEnv = {
        ...baseEnv,
        ...runtime.extraEnv,
        ...envOverrides,
      };
      const result = await runScriptWithTimeout({
        command: runtime.command,
        args: [scriptPath, ...scriptArgs],
        cwd: skillDir,
        env,
        timeoutMs,
      });
      lastResult = result;

      if (result.spawnErrorCode === 'ENOENT') {
        continue;
      }
      return result;
    }

    return (
      lastResult ?? {
        success: false,
        exitCode: null,
        stdout: '',
        stderr: '',
        durationMs: 0,
        timedOut: false,
        error: 'Failed to run skill script',
      }
    );
  }

  private parseScriptMessage(stdout: string): string | null {
    if (!stdout) {
      return null;
    }
    try {
      const parsed = JSON.parse(stdout);
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof parsed.message === 'string' &&
        parsed.message.trim()
      ) {
        return parsed.message.trim();
      }
      return null;
    } catch {
      return null;
    }
  }

  private getLastOutputLine(text: string): string {
    return (
      text
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .slice(-1)[0] || ''
    );
  }

  private buildEmailConnectivityCheck(
    code: EmailConnectivityCheckCode,
    result: SkillScriptRunResult,
  ): EmailConnectivityCheck {
    const label = code === 'imap_connection' ? 'IMAP' : 'SMTP';

    if (result.success) {
      const parsedMessage = this.parseScriptMessage(result.stdout);
      return {
        code,
        level: 'pass',
        message: parsedMessage || `${label} connection successful`,
        durationMs: result.durationMs,
      };
    }

    const message = result.timedOut
      ? `${label} connectivity check timed out`
      : result.error ||
        this.getLastOutputLine(result.stderr) ||
        this.getLastOutputLine(result.stdout) ||
        `${label} connection failed`;

    return {
      code,
      level: 'fail',
      message,
      durationMs: result.durationMs,
    };
  }
}

export const __skillManagerTestUtils = {
  parseFrontmatter,
  isTruthy,
  extractDescription,
};
