import fs from 'fs';
import os from 'os';
import path from 'path';
import { expect, test, vi } from 'vitest';

import { HistoryRecoveryKind } from '../../../shared/app/startup/history';
import { StartupRoute } from '../../../shared/app/startup/routing';
import { AppInitialization } from '../initialization/appInitialization';
import { NativeHistoryRuntime } from './nativeHistoryRuntime';

test.each([
  ['SQLITE_FULL', HistoryRecoveryKind.Space],
  ['SQLITE_BUSY', HistoryRecoveryKind.Busy],
  ['EACCES', HistoryRecoveryKind.Access],
])(
  'a real child-process %s failure reaches the startup recovery screen with its category',
  async (code, kind) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-failure-'));
    try {
      const entry = path.join(root, 'native-fixture.cjs');
      fs.writeFileSync(
        entry,
        `process.stdout.write(JSON.stringify({error:{code:${JSON.stringify(code)}}}));process.exitCode=1;`,
      );
      const runtime = new NativeHistoryRuntime({
        executable: process.execPath,
        stateDir: () => root,
        gatewayStopped: () => true,
        getEnvironment: async () => ({
          runtimeRoot: root,
          openclawEntry: entry,
          env: { ...process.env },
        }),
      });
      const initialization = new AppInitialization(root, StartupRoute.Migration, vi.fn());
      const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await runtime.run('import');
        throw new Error('Expected native failure');
      } catch (error) {
        initialization.fail(error);
      } finally {
        quiet.mockRestore();
      }
      expect(initialization.getState()).toMatchObject({
        historyRecovery: kind,
        failure: { error: { code } },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
