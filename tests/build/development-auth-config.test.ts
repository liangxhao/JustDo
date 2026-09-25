import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const {
  readBuiltinModelDevelopmentAuthConfig,
  verifyPackagedBuiltinModelAuthConfig,
} = require('../../scripts/packaging/electron-builder-hooks.cjs') as {
  readBuiltinModelDevelopmentAuthConfig: (projectDir: string) => {
    developmentAuthMode: string;
    developmentApiKey: string;
  };
  verifyPackagedBuiltinModelAuthConfig: (projectDir: string) => void;
};

const temporaryDirectories: string[] = [];

const writeConfig = (source: string): string => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-auth-config-'));
  temporaryDirectories.push(projectDir);
  const configDir = path.join(projectDir, 'src', 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'builtinModelAuth.ts'), source);
  return projectDir;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('packaged built-in model authentication configuration', () => {
  it('accepts the checked-in JWT-only configuration', () => {
    const projectDir = path.resolve(__dirname, '../..');
    expect(readBuiltinModelDevelopmentAuthConfig(projectDir)).toEqual({
      developmentAuthMode: 'jwt',
      developmentApiKey: '',
    });
    expect(() => verifyPackagedBuiltinModelAuthConfig(projectDir)).not.toThrow();
  });

  it('rejects a development API Key before packaging without exposing it', () => {
    const projectDir = writeConfig(`
      export const BUILTIN_MODEL_AUTH_CONFIG = Object.freeze({
        developmentAuthMode: 'api-key',
        developmentApiKey: 'private-test-value',
      });
    `);
    expect(() => verifyPackagedBuiltinModelAuthConfig(projectDir)).toThrow(
      'Packaging requires developmentAuthMode "jwt" and an empty developmentApiKey.',
    );
    try {
      verifyPackagedBuiltinModelAuthConfig(projectDir);
    } catch (error) {
      expect(String(error)).not.toContain('private-test-value');
    }
  });
});
