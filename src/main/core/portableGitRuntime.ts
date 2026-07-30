import fs from 'fs';
import path from 'path';

const PORTABLE_GIT_DIR_NAME = 'mingit';
const BASH_RELATIVE_PATHS = [
  path.join('bin', 'bash.exe'),
  path.join('usr', 'bin', 'bash.exe'),
];
const GIT_RELATIVE_PATHS = [
  path.join('bin', 'git.exe'),
  path.join('cmd', 'git.exe'),
];

export interface PortableGitExecutables {
  root: string;
  bashPath: string;
  gitPath: string;
}

const findFirstFile = (root: string, relativePaths: readonly string[]): string | null => {
  for (const relativePath of relativePaths) {
    const candidate = path.join(root, relativePath);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
};

export const resolvePortableGitExecutables = (
  root: string,
): PortableGitExecutables | null => {
  const bashPath = findFirstFile(root, BASH_RELATIVE_PATHS);
  const gitPath = findFirstFile(root, GIT_RELATIVE_PATHS);
  return bashPath && gitPath ? { root, bashPath, gitPath } : null;
};

const prependWindowsPath = (current: string | undefined, entries: string[]): string => {
  const seen = new Set<string>();
  const merged: string[] = [];

  const append = (value: string): void => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const normalized = trimmed.toLowerCase().replace(/[\\/]+$/, '');
    if (seen.has(normalized)) return;
    seen.add(normalized);
    merged.push(trimmed);
  };

  entries.forEach(append);
  (current || '').split(';').forEach(append);
  return merged.join(';');
};

const resolvePortableGitCandidates = (): string[] => {
  const candidates = [
    process.resourcesPath
      ? path.join(process.resourcesPath, PORTABLE_GIT_DIR_NAME)
      : null,
    path.join(process.cwd(), 'resources', PORTABLE_GIT_DIR_NAME),
    path.join(path.resolve(__dirname, '..', '..', '..'), 'resources', PORTABLE_GIT_DIR_NAME),
  ];
  return candidates.filter((value): value is string => Boolean(value));
};

export const getBundledPortableGitRoot = (): string | null => {
  for (const candidate of resolvePortableGitCandidates()) {
    if (resolvePortableGitExecutables(candidate)) {
      return candidate;
    }
  }
  return null;
};

export const applyPortableGitRuntimeEnv = (
  env: Record<string, string | undefined>,
  options: {
    platform?: NodeJS.Platform;
    portableGitRoot?: string | null;
  } = {},
): Record<string, string | undefined> => {
  if ((options.platform ?? process.platform) !== 'win32') {
    return env;
  }

  const root = options.portableGitRoot ?? getBundledPortableGitRoot();
  if (!root) {
    return env;
  }

  const executables = resolvePortableGitExecutables(root);
  if (!executables) {
    return env;
  }

  const pathEntries = [
    path.dirname(executables.bashPath),
    path.dirname(executables.gitPath),
  ];
  env.PATH = prependWindowsPath(env.PATH || env.Path, pathEntries);
  env.Path = env.PATH;
  env.JUSTDO_PORTABLE_GIT_ROOT = root;
  env.JUSTDO_BASH_PATH = executables.bashPath;
  return env;
};
