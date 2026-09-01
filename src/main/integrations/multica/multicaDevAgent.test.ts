import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import { PRODUCT_NAME } from '../../../shared/productMetadata';
import {
  resolveMulticaDevAgentExecutable,
  resolvePackagedMulticaAgentExecutable,
} from './multicaDevAgent';

describe('Multica development Agent executable', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('resolves the native Windows executable produced by the development build', () => {
    const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'multica-dev-agent-'));
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'multica-dev-agent-data-'));
    directories.push(appPath, userDataPath);
    const executablePath = path.join(
      userDataPath,
      'multica',
      'development',
      `${PRODUCT_NAME}-agent.exe`,
    );
    fs.mkdirSync(path.dirname(executablePath), { recursive: true });
    fs.writeFileSync(executablePath, 'placeholder');

    expect(resolveMulticaDevAgentExecutable(appPath, userDataPath, 'win32')).toBe(executablePath);
  });

  test('reports the build command when the executable is missing', () => {
    const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'multica-dev-agent-missing-'));
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'multica-dev-agent-data-missing-'));
    directories.push(appPath, userDataPath);

    expect(() => resolveMulticaDevAgentExecutable(appPath, userDataPath, 'win32')).toThrow(
      'npm run multica:dev-agent',
    );
  });

  test('resolves the packaged Agent beside the product executable', () => {
    const appDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'multica-packaged-agent-'));
    directories.push(appDirectory);
    const productExecutable = path.join(appDirectory, `${PRODUCT_NAME}.exe`);
    const agentExecutable = path.join(appDirectory, `${PRODUCT_NAME}-agent.exe`);
    fs.writeFileSync(productExecutable, 'product');
    fs.writeFileSync(agentExecutable, 'agent');

    expect(resolvePackagedMulticaAgentExecutable(productExecutable)).toBe(agentExecutable);
  });
});
