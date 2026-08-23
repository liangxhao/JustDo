import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const { createMulticaAgentLauncher } = require('../scripts/create-multica-agent-launcher.cjs') as {
  createMulticaAgentLauncher: (
    targetPath: string,
    options?: { productExecutablePath?: string; applicationPath?: string },
  ) => string;
};

describe('Multica native Agent launcher build', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test.runIf(process.platform === 'win32')('builds an executable native wrapper', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multica-agent-launcher-'));
    directories.push(directory);
    const targetPath = path.join(directory, 'Product-agent.exe');

    expect(createMulticaAgentLauncher(targetPath)).toBe(targetPath);
    expect(fs.readFileSync(targetPath).subarray(0, 2).toString('ascii')).toBe('MZ');

    const result = spawnSync(targetPath, ['--version'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(result.status).toBe(70);
    expect(result.stderr).toContain('product executable is missing');
  });

  test.runIf(process.platform === 'win32')(
    'builds a development wrapper with an explicit bridge marker',
    () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multica-agent-launcher-dev-'));
      directories.push(directory);
      const targetPath = path.join(directory, 'Product-agent.exe');
      const applicationPath = path.join(directory, 'argv-probe.cjs');
      fs.writeFileSync(
        applicationPath,
        'process.stdout.write(JSON.stringify(process.argv.slice(2)));',
        'utf8',
      );

      createMulticaAgentLauncher(targetPath, {
        productExecutablePath: process.execPath,
        applicationPath,
      });
      const result = spawnSync(targetPath, ['config', 'file'], {
        encoding: 'utf8',
        windowsHide: true,
      });

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(['--justdo-multica-bridge', 'config', 'file']);
    },
  );
});
