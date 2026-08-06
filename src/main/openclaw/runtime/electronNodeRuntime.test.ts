import path from 'path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getName: () => 'JustDo',
    getPath: () => '',
    isPackaged: false,
  },
}));

import { resolvePackagedNpmBinDir } from './electronNodeRuntime';

describe('Electron Node runtime', () => {
  it('keeps packaged npm on its logical asar path for dependency resolution', () => {
    const resourcesPath = path.join('application', 'resources');

    const npmBinDir = resolvePackagedNpmBinDir(resourcesPath);

    expect(npmBinDir).toBe(
      path.join(resourcesPath, 'app.asar', 'node_modules', 'npm', 'bin'),
    );
    expect(npmBinDir).not.toContain('app.asar.unpacked');
  });
});
