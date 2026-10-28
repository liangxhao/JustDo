import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, onTestFinished, test } from 'vitest';

const projectRoot = path.resolve(__dirname, '../..');
const vitestCli = path.join(projectRoot, 'node_modules/vitest/vitest.mjs');
const configPath = path.join(projectRoot, 'vitest.config.ts');
const electronExecutable: string = require('electron');

test('rejects a real Electron test driver during config loading before any suite executes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vitest-runner-safety-'));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const suitePath = path.join(root, 'tests/runner-sentinel.test.ts');
  const suiteMarker = 'RUNNER_SAFETY_SUITE_EXECUTED';
  fs.mkdirSync(path.dirname(suitePath), { recursive: true });
  fs.writeFileSync(suitePath, `throw new Error('${suiteMarker}');\n`);
  const args = [vitestCli, 'run', '--config', configPath, '--root', root, suitePath];
  const options = {
    cwd: projectRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1' },
    encoding: 'utf8' as const,
    timeout: 20_000,
    windowsHide: true,
  };

  // Prove the same harmless suite is selected and would fail if a driver reaches it.
  const nodeResult = spawnSync(process.execPath, args, options);
  expect(nodeResult.error).toBeUndefined();
  expect(nodeResult.status).toBe(1);
  expect(nodeResult.stdout + nodeResult.stderr).toContain(suiteMarker);

  const electronResult = spawnSync(electronExecutable, args, options);
  const output = electronResult.stdout + electronResult.stderr;
  expect(electronResult.error).toBeUndefined();
  expect(electronResult.status).toBe(1);
  expect(output).toContain('failed to load config');
  expect(output).toContain('Vitest requires standalone Node.js 24.');
  expect(output).toContain('run `npm test` with Node.js');
  expect(output).not.toContain(suiteMarker);
}, 45_000);
