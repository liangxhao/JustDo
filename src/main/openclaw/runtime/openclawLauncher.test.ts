import { execFileSync, spawn } from 'child_process';
import { once } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ensureGatewayShutdownPreload,
  OPENCLAW_GATEWAY_SHUTDOWN_MESSAGE,
  OPENCLAW_LAUNCHER_KEEP_ALIVE_SOURCE,
} from './openclawLauncher';

const temporaryDirectories: string[] = [];

const createLauncher = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-openclaw-launcher-'));
  temporaryDirectories.push(directory);
  const launcherPath = path.join(directory, 'launcher.cjs');
  fs.writeFileSync(
    launcherPath,
    `${OPENCLAW_LAUNCHER_KEEP_ALIVE_SOURCE}process.stdout.write('completed');\n`,
    'utf8',
  );
  return launcherPath;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('OpenClaw launcher keep-alive', () => {
  it.each(['request', 'disconnect'])('runs native cleanup on parent %s', async mode => {
    const launcherPath = createLauncher();
    fs.appendFileSync(
      launcherPath,
      `process.on('SIGTERM', () => {\n` +
        `  setTimeout(() => { process.stdout.write('cleaned'); process.exit(0); }, 20);\n` +
        `});\nprocess.send('ready');\n`,
    );
    const child = spawn(
      process.execPath,
      [
        '--require',
        ensureGatewayShutdownPreload(path.dirname(launcherPath)),
        launcherPath,
        'gateway',
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    let output = '';
    child.stdout!.on('data', chunk => {
      output += chunk;
    });
    try {
      await once(child, 'message');
      const exited = once(child, 'exit');
      if (mode === 'request') child.send(OPENCLAW_GATEWAY_SHUTDOWN_MESSAGE);
      else child.disconnect();
      expect(await exited).toEqual([0, null]);
      expect(output).toBe('completedcleaned');
    } finally {
      if (child.exitCode === null) child.kill();
    }
  });

  it('allows one-shot CLI commands to exit normally', () => {
    const launcherPath = createLauncher();

    const output = execFileSync(process.execPath, [launcherPath, 'memory', 'status'], {
      encoding: 'utf8',
      timeout: 2_000,
    });

    expect(output).toBe('completed');
  });

  it('keeps the gateway command alive', async () => {
    const launcherPath = createLauncher();
    const child = spawn(process.execPath, [launcherPath, 'gateway'], { stdio: 'ignore' });

    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(child.exitCode).toBeNull();
    } finally {
      const exitPromise = child.exitCode === null ? once(child, 'exit') : null;
      child.kill();
      if (exitPromise) await exitPromise;
    }
  });
});
