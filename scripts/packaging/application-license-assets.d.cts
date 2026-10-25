import type { Plugin } from 'vite';

export const REQUIRED_APPLICATION_LICENSE_SCOPES: readonly string[];
export function createApplicationLicensePlugin(options: { repoRoot: string; scope: string; outputRoot?: string }): Plugin;
export function verifyApplicationLicenseAssets(options?: { repoRoot?: string; outputRoot?: string; packagedRoot?: string }): { scopes: number; packages: number; files: number };
