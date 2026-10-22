import { app } from 'electron';
import path from 'path';

import { getElectronNodeRuntimePath, resolveElectronNpmBinDir } from './launch/electronNodeRuntime';

export type McpPackageRuntime = {
  electronPath: string;
  npmBinDir: string;
  preloadPath: string;
};

export const resolveWindowsMcpPackageRuntime = (): McpPackageRuntime | null => {
  if (process.platform !== 'win32') return null;
  const npmBinDir = resolveElectronNpmBinDir();
  if (!npmBinDir) return null;
  return {
    electronPath: getElectronNodeRuntimePath(),
    npmBinDir,
    preloadPath: path.join(
      app.getPath('userData'),
      'cowork',
      'bin',
      'hide-child-process-windows.cjs',
    ),
  };
};

/** Project a managed command without changing the operator's stored configuration. */
export const projectMcpPackageRunner = (
  config: Record<string, unknown>,
  runtime: McpPackageRuntime | null,
): Record<string, unknown> => {
  const runner =
    typeof config.command === 'string' && /^(npm|npx)(?:\.cmd)?$/i.exec(config.command);
  if (!runtime || !runner) return config;
  const args = Array.isArray(config.args)
    ? config.args.filter((value): value is string => typeof value === 'string')
    : [];
  const env =
    config.env && typeof config.env === 'object' && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  return {
    ...config,
    command: runtime.electronPath,
    // MCP drops NODE_OPTIONS. Explicit Node arguments retain the trusted
    // child-window preload without changing native environment filtering.
    args: [
      '--require',
      runtime.preloadPath,
      path.join(runtime.npmBinDir, `${runner[1].toLowerCase()}-cli.js`),
      ...args,
    ],
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
  };
};
