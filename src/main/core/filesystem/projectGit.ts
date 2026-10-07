import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { applyPortableGitRuntimeEnv } from '../runtime/portableGitRuntime';

const GIT_TIMEOUT_MS = 10000;
const initializationInFlight = new Map<string, Promise<void>>();

async function hasRepositoryMarker(directory: string): Promise<boolean> {
  for (let current = directory; ; current = path.dirname(current)) {
    try {
      await fs.promises.lstat(path.join(current, '.git'));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (path.dirname(current) === current) return false;
  }
}

function resolveGitExecutable(env: NodeJS.ProcessEnv): string | undefined {
  const filename = process.platform === 'win32' ? 'git.exe' : 'git';
  for (const entry of (env.PATH || env.Path || '').split(path.delimiter)) {
    const directory = entry.trim().replace(/^"|"$/g, '');
    if (!path.isAbsolute(directory)) continue;
    const executable = path.join(directory, filename);
    try {
      if (!fs.statSync(executable).isFile()) continue;
      fs.accessSync(
        executable,
        process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK,
      );
      return executable;
    } catch {
      // Continue searching the application/runtime PATH.
    }
  }
  return undefined;
}

async function initializeProjectRepository(directory: string): Promise<void> {
  if (await hasRepositoryMarker(directory)) return;
  const env = applyPortableGitRuntimeEnv({ ...process.env });
  for (const key of Object.keys(env)) {
    if (/^GIT_/i.test(key)) delete env[key];
  }
  env.LC_ALL = 'C';
  const executable = resolveGitExecutable(env);
  if (!executable) return;
  const runGit = (args: string[]) =>
    new Promise<void>((resolve, reject) => {
      execFile(
        executable,
        args,
        {
          cwd: directory,
          env,
          timeout: GIT_TIMEOUT_MS,
          windowsHide: true,
        },
        (error, _stdout, stderr) => {
          if (error) reject(Object.assign(error, { stderr }));
          else resolve();
        },
      );
    });

  try {
    // Covers bare repositories as well as parent repositories and worktrees.
    await runGit(['rev-parse', '--git-dir']);
    return;
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    if (failure.code !== 128 || !failure.stderr?.includes('not a git repository')) throw error;
  }
  // A different session may have initialized this project during the probe.
  if (await hasRepositoryMarker(directory)) return;
  await runGit(['init', '--quiet', '--template=']);
}

/** Initialize Git independently of OpenClaw role-file provisioning. */
export async function ensureProjectGitRepository(workspaceRoot: string): Promise<void> {
  try {
    const directory = await fs.promises.realpath(workspaceRoot);
    const key = process.platform === 'win32' ? directory.toLowerCase() : directory;
    const existing = initializationInFlight.get(key);
    if (existing) return await existing;
    const pending = initializeProjectRepository(directory);
    initializationInFlight.set(key, pending);
    try {
      await pending;
    } finally {
      if (initializationInFlight.get(key) === pending) initializationInFlight.delete(key);
    }
  } catch (error) {
    // Git is optional. A missing/locked runtime or inaccessible repository must
    // not prevent an otherwise valid conversation from starting.
    console.warn('[ProjectGit] Repository initialization skipped', {
      code: (error as NodeJS.ErrnoException).code ?? 'unknown',
    });
  }
}
