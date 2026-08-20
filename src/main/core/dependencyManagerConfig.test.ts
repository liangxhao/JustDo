import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test } from 'vitest';

import {
  applyDependencyManagerConfigEnv,
  JUSTDO_MANAGED_PIP_CONFIG_FILE_ENV,
  resolveDependencyManagerConfig,
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

test('resolves npm and pip config directly from the resource directory', () => {
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
  const paths = resolveDependencyManagerConfig(resourceDir);

  expect(paths.npmUserConfigPath).toBe(path.join(resourceDir, '.npmrc'));
  expect(paths.pipConfigPath).toBe(path.join(resourceDir, 'pip.ini'));
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
  const resourceDir = createTempDir();
  fs.writeFileSync(path.join(resourceDir, '.npmrc'), 'registry=https://example.invalid/npm\n');
  fs.writeFileSync(path.join(resourceDir, 'pip.ini'), '[global]\n');
  const env: Record<string, string | undefined> = {};

  const paths = applyDependencyManagerConfigEnv(env, resourceDir);

  expect(env.NPM_CONFIG_USERCONFIG).toBe(paths.npmUserConfigPath);
  expect(env.npm_config_userconfig).toBe(paths.npmUserConfigPath);
  expect(env.PIP_CONFIG_FILE).toBe(paths.pipConfigPath);
  expect(env[JUSTDO_MANAGED_PIP_CONFIG_FILE_ENV]).toBe(paths.pipConfigPath);
});

test('replaces inherited pip provenance only when packaged config exists', () => {
  const resourceDir = createTempDir();
  const env: Record<string, string | undefined> = {
    PIP_CONFIG_FILE: 'C:\\untrusted\\pip.ini',
    justdo_managed_pip_config_file: 'C:\\untrusted\\pip.ini',
  };

  applyDependencyManagerConfigEnv(env, resourceDir);

  expect(env.PIP_CONFIG_FILE).toBe('C:\\untrusted\\pip.ini');
  expect(env[JUSTDO_MANAGED_PIP_CONFIG_FILE_ENV]).toBeUndefined();
  expect(env.justdo_managed_pip_config_file).toBeUndefined();

  fs.writeFileSync(path.join(resourceDir, 'pip.ini'), '[global]\n');
  const paths = applyDependencyManagerConfigEnv(env, resourceDir);

  expect(env.PIP_CONFIG_FILE).toBe(paths.pipConfigPath);
  expect(env[JUSTDO_MANAGED_PIP_CONFIG_FILE_ENV]).toBe(paths.pipConfigPath);
});

test('skips missing resource files without setting their environment variables', () => {
  const resourceDir = createTempDir();
  fs.writeFileSync(path.join(resourceDir, 'pip.ini'), '[global]\n');
  const env: Record<string, string | undefined> = {};

  const paths = applyDependencyManagerConfigEnv(env, resourceDir);

  expect(paths.npmUserConfigPath).toBeUndefined();
  expect(paths.pipConfigPath).toBe(path.join(resourceDir, 'pip.ini'));
  expect(fs.existsSync(path.join(resourceDir, '.npmrc'))).toBe(false);
  expect(fs.readFileSync(paths.pipConfigPath, 'utf8')).toBe('[global]\n');
  expect(env.NPM_CONFIG_USERCONFIG).toBeUndefined();
  expect(env.npm_config_userconfig).toBeUndefined();
  expect(env.PIP_CONFIG_FILE).toBe(paths.pipConfigPath);
});

test('discovers dependency config under current working directory resources', () => {
  const originalCwd = process.cwd();
  const projectRoot = createTempDir();
  const resourceDir = path.join(projectRoot, 'resources', 'dependency-config');
  fs.mkdirSync(resourceDir, { recursive: true });
  fs.writeFileSync(path.join(resourceDir, '.npmrc'), 'registry=https://example.invalid/npm\n');
  fs.writeFileSync(path.join(resourceDir, 'pip.ini'), '[global]\n');
  const env: Record<string, string | undefined> = {};

  try {
    process.chdir(projectRoot);
    const paths = applyDependencyManagerConfigEnv(env);

    expect(paths.npmUserConfigPath).toBe(path.join(resourceDir, '.npmrc'));
    expect(paths.pipConfigPath).toBe(path.join(resourceDir, 'pip.ini'));
    expect(env.NPM_CONFIG_USERCONFIG).toBe(paths.npmUserConfigPath);
    expect(env.npm_config_userconfig).toBe(paths.npmUserConfigPath);
    expect(env.PIP_CONFIG_FILE).toBe(paths.pipConfigPath);
  } finally {
    process.chdir(originalCwd);
  }
});
