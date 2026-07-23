import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getAppPath: vi.fn(),
  },
}));

import {
  hasBundledOpenClawExtension,
  listBundledOpenClawExtensionIds,
} from './openclawLocalExtensions';

describe('openclawLocalExtensions', () => {
  let resourcesDir: string;
  let originalResourcesPath: string;

  beforeEach(() => {
    resourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-extensions-'));
    originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: resourcesDir,
    });
  });

  afterEach(() => {
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: originalResourcesPath,
    });
    fs.rmSync(resourcesDir, { recursive: true, force: true });
  });

  it('discovers extensions in the packaged OpenClaw dist directory', () => {
    const extensionDir = path.join(
      resourcesDir,
      'cfmind',
      'dist',
      'extensions',
      'ask-user-question',
    );
    fs.mkdirSync(extensionDir, { recursive: true });
    fs.writeFileSync(path.join(extensionDir, 'openclaw.plugin.json'), '{}');

    expect(listBundledOpenClawExtensionIds()).toContain('ask-user-question');
    expect(hasBundledOpenClawExtension('ask-user-question')).toBe(true);
  });
});
