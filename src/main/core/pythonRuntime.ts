import { app } from 'electron';
import fs from 'fs';
import path from 'path';

const PYTHON_RUNTIME_DIR_NAME = 'python-win';
const PYTHON_USER_RUNTIME_DIR_NAME = 'runtimes';
const PYTHON_USER_BASE_DIR_NAME = 'python-user';
const PYTHON_USER_VERSION_DIR_NAME = 'Python312';
const SITE_CUSTOMIZE_REL_PATH = path.join('Lib', 'site-packages', 'sitecustomize.py');

export const JUSTDO_MANAGED_PYTHON_USER_BASE_ENV = 'JUSTDO_MANAGED_PYTHON_USER_BASE';

const REQUIRED_FILES = ['python.exe', 'python3.exe', SITE_CUSTOMIZE_REL_PATH];
const PIP_EXECUTABLE_CANDIDATES = [
  path.join('Scripts', 'pip.exe'),
  path.join('Scripts', 'pip3.exe'),
  path.join('Scripts', 'pip.cmd'),
  path.join('Scripts', 'pip3.cmd'),
  path.join('Scripts', 'pip'),
  path.join('Scripts', 'pip3'),
];
const PIP_MODULE_MAIN_REL_PATH = path.join('Lib', 'site-packages', 'pip', '__main__.py');
const PIP_MODULE_INIT_REL_PATH = path.join('Lib', 'site-packages', 'pip', '__init__.py');

function hasPipExecutable(rootDir: string): boolean {
  return PIP_EXECUTABLE_CANDIDATES.some(relPath => fs.existsSync(path.join(rootDir, relPath)));
}

function hasPipSupport(rootDir: string): boolean {
  const hasCommand = hasPipExecutable(rootDir);
  const hasModuleShim =
    fs.existsSync(path.join(rootDir, PIP_MODULE_MAIN_REL_PATH)) ||
    fs.existsSync(path.join(rootDir, PIP_MODULE_INIT_REL_PATH));
  return hasCommand && hasModuleShim;
}

function readEmbedPthFiles(rootDir: string): string[] {
  try {
    return fs.readdirSync(rootDir).filter(name => name.endsWith('._pth'));
  } catch {
    return [];
  }
}

function appendWindowsPath(current: string | undefined, entries: string[]): string | undefined {
  const delimiter = ';';
  const seen = new Set<string>();
  const merged: string[] = [];

  const append = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const normalized = trimmed.toLowerCase().replace(/[\\/]+$/, '');
    if (seen.has(normalized)) return;
    seen.add(normalized);
    merged.push(trimmed);
  };

  entries.forEach(append);
  (current || '').split(delimiter).forEach(append);

  return merged.length > 0 ? merged.join(delimiter) : current;
}

function runtimeHealth(
  rootDir: string,
  options: { requireEmbedSiteConfig?: boolean; requirePip?: boolean } = {},
): { ok: boolean; missing: string[] } {
  const requireEmbedSiteConfig = options.requireEmbedSiteConfig !== false;
  const requirePip = options.requirePip === true;
  const missing: string[] = [];

  for (const relPath of REQUIRED_FILES) {
    const fullPath = path.join(rootDir, relPath);
    if (!fs.existsSync(fullPath)) {
      missing.push(relPath);
    }
  }

  const hasPip = hasPipSupport(rootDir);
  if (requirePip && !hasPip) {
    if (!hasPipExecutable(rootDir)) {
      missing.push('Scripts/pip.exe (or Scripts/pip3.exe/pip.cmd)');
    }
    if (
      !fs.existsSync(path.join(rootDir, PIP_MODULE_MAIN_REL_PATH)) &&
      !fs.existsSync(path.join(rootDir, PIP_MODULE_INIT_REL_PATH))
    ) {
      missing.push(PIP_MODULE_MAIN_REL_PATH.replace(/\\/g, '/'));
    }
  }

  if (requireEmbedSiteConfig) {
    const pthFiles = readEmbedPthFiles(rootDir);
    if (pthFiles.length > 0) {
      const pthPath = path.join(rootDir, pthFiles[0]);
      try {
        const raw = fs.readFileSync(pthPath, 'utf8');
        const lines = raw.split(/\r?\n/).map(line => line.trim().toLowerCase());
        const hasImportSite = lines.includes('import site');
        const hasSitePackages =
          lines.includes('lib\\site-packages') || lines.includes('lib/site-packages');
        if (!hasImportSite || !hasSitePackages) {
          missing.push(`${pthFiles[0]} config (require "Lib\\site-packages" and "import site")`);
        }
      } catch {
        missing.push(`${pthFiles[0]} read failed`);
      }
    }
  }

  return {
    ok: missing.length === 0,
    missing,
  };
}

function resolveBundledCandidates(): string[] {
  if (app.isPackaged) {
    return [
      path.join(process.resourcesPath, PYTHON_RUNTIME_DIR_NAME),
      path.join(app.getAppPath(), PYTHON_RUNTIME_DIR_NAME),
    ];
  }

  const projectRoot = path.resolve(__dirname, '..', '..', '..');
  return [
    path.join(projectRoot, 'resources', PYTHON_RUNTIME_DIR_NAME),
    path.join(process.cwd(), 'resources', PYTHON_RUNTIME_DIR_NAME),
    path.join(app.getAppPath(), 'resources', PYTHON_RUNTIME_DIR_NAME),
  ];
}

export function getBundledPythonRoot(): string | null {
  const candidates = resolveBundledCandidates();
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }
  return null;
}

function getLegacyUserPythonRoot(): string {
  return path.join(app.getPath('userData'), 'runtimes', PYTHON_RUNTIME_DIR_NAME);
}

function getPythonUserPaths(): {
  base: string;
  sitePackages: string;
  scripts: string;
} {
  const base = path.join(
    app.getPath('userData'),
    PYTHON_USER_RUNTIME_DIR_NAME,
    PYTHON_USER_BASE_DIR_NAME,
  );
  const versionRoot = path.join(base, PYTHON_USER_VERSION_DIR_NAME);
  return {
    base,
    sitePackages: path.join(versionRoot, 'site-packages'),
    scripts: path.join(versionRoot, 'Scripts'),
  };
}

function removeLegacyUserPythonRuntime(): void {
  const legacyRoot = getLegacyUserPythonRoot();
  if (!fs.existsSync(legacyRoot)) return;

  try {
    fs.rmSync(legacyRoot, { recursive: true, force: true });
    console.log(`[python-runtime] Removed legacy userData runtime: ${legacyRoot}`);
  } catch (error) {
    console.warn('[python-runtime] Unable to remove the unused legacy runtime:', error);
    return;
  }

  const runtimesRoot = path.dirname(legacyRoot);
  try {
    fs.rmdirSync(runtimesRoot);
  } catch {
    // Keep the shared runtimes directory when another runtime or file still uses it.
  }
}

export function appendPythonRuntimeToEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  // This function owns the provenance token. Never trust a value inherited from the host.
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === JUSTDO_MANAGED_PYTHON_USER_BASE_ENV) delete env[key];
  }

  if (process.platform !== 'win32') {
    return env;
  }

  const bundledRoot = getBundledPythonRoot();
  const userPaths = getPythonUserPaths();
  fs.mkdirSync(userPaths.sitePackages, { recursive: true });
  fs.mkdirSync(userPaths.scripts, { recursive: true });
  const pathEntries: string[] = [];
  if (bundledRoot) {
    pathEntries.push(bundledRoot, path.join(bundledRoot, 'Scripts'), userPaths.scripts);
  }

  if (pathEntries.length > 0) {
    env.PATH = appendWindowsPath(env.PATH, pathEntries);
    env.JUSTDO_PYTHON_ROOT = pathEntries[0];
    env.JUSTDO_PYTHON_USER_SITE = userPaths.sitePackages;
    env.PYTHONUSERBASE = userPaths.base;
    env[JUSTDO_MANAGED_PYTHON_USER_BASE_ENV] = userPaths.base;
  }

  return env;
}

export async function ensurePythonRuntimeReady(): Promise<{ success: boolean; error?: string }> {
  if (process.platform !== 'win32') {
    return { success: true };
  }

  try {
    const bundledRoot = getBundledPythonRoot();
    if (!bundledRoot) {
      const message = 'Bundled python runtime not found in application resources.';
      console.error(`[python-runtime] ${message}`);
      return { success: false, error: message };
    }

    const bundledHealth = runtimeHealth(bundledRoot);
    if (!bundledHealth.ok) {
      const message = `Bundled python runtime is unhealthy (missing: ${bundledHealth.missing.join(', ')})`;
      console.error(`[python-runtime] ${message}`);
      return { success: false, error: message };
    }

    removeLegacyUserPythonRuntime();
    if (!hasPipSupport(bundledRoot)) {
      console.warn(
        '[python-runtime] Bundled runtime does not include full pip support; pip commands may fail.',
      );
    }
    console.log(`[python-runtime] Bundled runtime ready: ${bundledRoot}`);
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[python-runtime] Failed to ensure runtime ready:', message);
    return { success: false, error: message };
  }
}

export async function ensurePythonPipReady(): Promise<{ success: boolean; error?: string }> {
  if (process.platform !== 'win32') {
    return { success: true };
  }

  const runtimeReady = await ensurePythonRuntimeReady();
  if (!runtimeReady.success) {
    return runtimeReady;
  }

  try {
    const bundledRoot = getBundledPythonRoot();
    if (!bundledRoot) {
      return {
        success: false,
        error: 'Bundled python runtime not found in application resources.',
      };
    }
    const bundledHealth = runtimeHealth(bundledRoot, { requirePip: true });
    if (bundledHealth.ok) {
      return { success: true };
    }

    const message = `pip is unavailable in bundled runtime (missing: ${bundledHealth.missing.join(', ')})`;
    console.error(`[python-runtime] ${message}`);
    return { success: false, error: message };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[python-runtime] Failed to ensure pip ready:', message);
    return { success: false, error: message };
  }
}
