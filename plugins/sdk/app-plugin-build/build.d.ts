import type { Plugin } from 'esbuild';

export interface AppPluginBuildOptions {
  sourceRoot?: string;
  destination?: string;
  /** Explicit embedding-host exclusions; these are not source resolution fallbacks. */
  forbiddenSourceRoots?: string[];
  /** Embedding tools can explicitly supply a shared source-package license. */
  licenseFile?: string;
}
export interface AppPluginBuildResult {
  id: string;
  hash: string;
  root: string;
  packageRoot: string;
}
export const browserSdk: Plugin;
export function buildAppPlugin(
  source: string,
  destination: string,
  options?: AppPluginBuildOptions,
): Promise<AppPluginBuildResult>;
export function buildAppPlugins(options?: AppPluginBuildOptions): Promise<AppPluginBuildResult[]>;
