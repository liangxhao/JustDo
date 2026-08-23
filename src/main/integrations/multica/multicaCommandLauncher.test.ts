import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import {
  ensureMulticaCommandLauncher,
  removeMulticaCommandLauncher,
} from './multicaCommandLauncher';

describe('Multica command launcher', () => {
  const tempDirectories: string[] = [];

  afterEach(() => {
    for (const directory of tempDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('uses a native Windows executable without a launcher prefix', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multica-native-agent-'));
    tempDirectories.push(directory);
    const targetPath = path.join(directory, 'Product-agent.exe');
    fs.writeFileSync(targetPath, 'placeholder');

    const launcher = ensureMulticaCommandLauncher({ targetPath, platform: 'win32' });

    expect(launcher).toEqual({
      commandName: targetPath,
      commandLine: targetPath.replaceAll('\\', '/'),
      fixedArgs: [],
      path: targetPath,
    });
    removeMulticaCommandLauncher(launcher.path, targetPath, 'win32');
    expect(fs.existsSync(targetPath)).toBe(true);
  });

  test.runIf(process.platform === 'win32')(
    'forwards a Windows argument beyond the cmd.exe 8191-character limit',
    () => {
      const launcher = ensureMulticaCommandLauncher({
        targetPath: process.execPath,
        platform: 'win32',
      });
      const longArgument = '测'.repeat(12_000);

      const output = execFileSync(
        launcher.commandName,
        ['-e', 'process.stdout.write(String(process.argv[1].length))', longArgument],
        { encoding: 'utf8', windowsHide: true },
      );

      expect(output).toBe('12000');
    },
  );

  test('rejects a Windows launcher that depends on fixed arguments', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multica-prefixed-agent-'));
    tempDirectories.push(directory);
    const targetPath = path.join(directory, 'Product-agent.exe');
    fs.writeFileSync(targetPath, 'placeholder');

    expect(() =>
      ensureMulticaCommandLauncher({
        targetPath,
        targetArgs: ['wrapper.ps1'],
        platform: 'win32',
      }),
    ).toThrow('cannot apply launcher arguments');
  });

  test('rejects a Windows executable path containing spaces', () => {
    expect(() =>
      ensureMulticaCommandLauncher({
        targetPath: 'C:\\Agent Builds\\Product-agent.exe',
        platform: 'win32',
      }),
    ).toThrow('path to contain no spaces');
  });
});
