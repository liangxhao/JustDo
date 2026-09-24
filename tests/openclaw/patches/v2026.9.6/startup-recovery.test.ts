import { transformSync } from 'esbuild';
import { expect, test } from 'vitest';
const {
  __testing: { transformTask },
} = require('../../../../scripts/patches/v2026.9.6/008-app-startup-task-recovery-boundary.cjs');
const source = `function shouldMarkLost(task) { return false; }
async function runTaskRegistryMaintenance() {
  let reconciled = 0;
  await visit(async (task, now, owner, assertCurrent) => {
    resolveDurableCronTaskRecovery(task);
    tryRecoverTaskBeforeMarkLost(task);
    if (task.status === "lost") reconciled += 1;
  });
}`;
test('does not insert duplicate recovery helpers when esbuild removes comments', () => {
  const patched = transformTask(source, 'fixture.mjs');
  const bundled = transformSync(patched, { target: 'node24' }).code;
  const reapplied = transformTask(bundled, 'gateway-bundle.mjs');
  expect(reapplied).toBe(bundled);
  expect(reapplied.match(/function readJustDoAppStartedAtMs\(/g)).toHaveLength(1);
  expect(() => transformSync(reapplied, { target: 'node24' })).not.toThrow();
  expect(() =>
    transformTask(reapplied + '\nfunction readJustDoAppStartedAtMs() {}', 'gateway-bundle.mjs'),
  ).toThrow(/duplicated/);
});
