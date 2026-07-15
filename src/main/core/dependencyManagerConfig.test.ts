import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test } from 'vitest';

import {
  applyDependencyManagerConfigEnv,
  ensureDependencyManagerConfig,
} from './dependencyManagerConfig';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-dependency-config-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writes npm and pip mirror config under userData', () => {
  const userDataPath = createTempDir();
  const resourceDir = createTempDir();
  fs.writeFileSync(
    path.join(resourceDir, '.npmrc'),
    'strict-ssl=false\nregistry=http://mirrors.tools.huawei.com/npm\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(resourceDir, 'pip.ini'),
    [
      '[global]',
      'index-url = https://mirrors.tools.huawei.com/pypi/simple',
      'trusted-host = mirrors.tools.huawei.com',
      '',
    ].join('\n'),
    'utf8',
  );
  const paths = ensureDependencyManagerConfig(userDataPath, resourceDir);

  expect(paths.npmUserConfigPath).toBe(path.join(userDataPath, '.npmrc'));
  expect(paths.pipConfigPath).toBe(path.join(userDataPath, 'pip', 'pip.ini'));
  expect(fs.readFileSync(paths.npmUserConfigPath, 'utf8')).toBe(
    'strict-ssl=false\nregistry=http://mirrors.tools.huawei.com/npm\n',
  );
  expect(fs.readFileSync(paths.pipConfigPath, 'utf8')).toBe(
    [
      '[global]',
      'index-url = https://mirrors.tools.huawei.com/pypi/simple',
      'trusted-host = mirrors.tools.huawei.com',
      '',
    ].join('\n'),
  );
});

test('points npm and pip environment variables at managed config files', () => {
  const userDataPath = createTempDir();
  const resourceDir = createTempDir();
  fs.writeFileSync(path.join(resourceDir, '.npmrc'), 'registry=https://example.invalid/npm\n');
  fs.writeFileSync(path.join(resourceDir, 'pip.ini'), '[global]\n');
  const env: Record<string, string | undefined> = {};

  const paths = applyDependencyManagerConfigEnv(env, userDataPath, resourceDir);

  expect(env.NPM_CONFIG_USERCONFIG).toBe(paths.npmUserConfigPath);
  expect(env.npm_config_userconfig).toBe(paths.npmUserConfigPath);
  expect(env.PIP_CONFIG_FILE).toBe(paths.pipConfigPath);
});

test('skips missing resource files without setting their environment variables', () => {
  const userDataPath = createTempDir();
  const resourceDir = createTempDir();
  fs.writeFileSync(path.join(resourceDir, 'pip.ini'), '[global]\n');
  const env: Record<string, string | undefined> = {};

  const paths = applyDependencyManagerConfigEnv(env, userDataPath, resourceDir);

  expect(paths.npmUserConfigPath).toBeUndefined();
  expect(paths.pipConfigPath).toBe(path.join(userDataPath, 'pip', 'pip.ini'));
  expect(fs.existsSync(path.join(userDataPath, '.npmrc'))).toBe(false);
  expect(fs.readFileSync(paths.pipConfigPath, 'utf8')).toBe('[global]\n');
  expect(env.NPM_CONFIG_USERCONFIG).toBeUndefined();
  expect(env.npm_config_userconfig).toBeUndefined();
  expect(env.PIP_CONFIG_FILE).toBe(paths.pipConfigPath);
});
