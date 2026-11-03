import { expect, test } from 'vitest';

import { installExtensionPackage } from './extensionMutation';

test('retains the local recovery directory and committed install while hiding credentials', async () => {
  const directory = String.raw`C:\Users\Example\扩展 目录\plugin`;
  const result = await installExtensionPackage(
    async () => ({ success: true, extensionId: 'plugin', installPath: directory }),
    async operation => {
      await operation();
      throw new Error(`Cannot prepare runtime in "${directory}"\nAuthorization: Bearer fixture-secret`);
    },
  );

  expect(result).toMatchObject({
    success: false,
    installationCommitted: true,
    mutationCompleted: true,
    installPath: directory,
    failedStage: 'preparing_runtime',
  });
  expect(result.error).toContain(directory);
  expect(result.error).not.toContain('[REDACTED PATH]');
  expect(result.error).not.toContain('fixture-secret');
});
