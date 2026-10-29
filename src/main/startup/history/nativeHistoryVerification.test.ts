import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test } from 'vitest';

import { NATIVE_HISTORY_VERIFICATION_SOURCE } from './nativeHistoryVerification';

const roots: string[] = [];
afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
const childKey = 'agent:main:subagent:child';
const terminal = {
  sessionId: 'child-id', spawnedBy: 'agent:main:justdo:parent', status: 'done',
  lastRunId: 'child-run', startedAt: 1000, endedAt: 2000, runtimeMs: 1000,
};
function verifyNativeSnapshot(
  entry: Record<string, unknown>,
  verifyTerminals: boolean,
  expected: Record<string, unknown> = terminal,
): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'history-verification-'));
  roots.push(directory);
  const sdk = path.join(directory, 'dist/plugin-sdk');
  fs.mkdirSync(sdk, { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
  // Match the real public SDK projection: private owner IDs are not exposed.
  const publicEntry = { ...entry };
  delete publicEntry.lastRunId;
  delete publicEntry.lifecycleRunId;
  fs.writeFileSync(path.join(sdk, 'session-store-runtime.js'),
    `export const getSessionEntry = () => (${JSON.stringify(publicEntry)});`);
  const planFile = path.join(directory, 'import-plan.json');
  fs.writeFileSync(planFile, JSON.stringify({
    agents: [{ agentId: 'main', entries: { [childKey]: expected } }], conversations: [],
    ...(verifyTerminals ? { verifyTerminalSnapshots: true } : {}),
  }));
  return execFileSync(process.execPath, [
    '--input-type=module', '--eval', NATIVE_HISTORY_VERIFICATION_SOURCE,
    directory, directory, planFile,
  ], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

test('initial import verifies terminal metadata through the public native session reader', () => {
  expect(JSON.parse(verifyNativeSnapshot(terminal, true))).toMatchObject({
    verified: true, entries: 1, parentLinks: 1,
  });
});

test('binary historical status normalization verifies the display value without inventing execution evidence', () => {
  const normalized = { sessionId: terminal.sessionId, spawnedBy: terminal.spawnedBy, status: 'failed' };
  expect(JSON.parse(verifyNativeSnapshot(normalized, true, normalized))).toMatchObject({ verified: true });
  expect(() => verifyNativeSnapshot({ ...normalized, status: 'done' }, true, normalized)).toThrow();
});

test.each([
  { status: 'failed' }, { status: undefined }, { endedAt: 3000 },
])('initial import rejects mismatched native terminal evidence: %o', mismatch => {
  expect(() => verifyNativeSnapshot({ ...terminal, ...mismatch }, true)).toThrow();
});

test('check-stage recovery verifies identity without rejecting a legitimate newer lifecycle', () => {
  expect(JSON.parse(verifyNativeSnapshot({
    ...terminal, status: 'failed', lastRunId: 'new-run', endedAt: 3000,
    lifecycleRunId: 'current-run',
  }, false))).toMatchObject({ verified: true });
  expect(() => verifyNativeSnapshot({ ...terminal, sessionId: 'replacement-session' }, false)).toThrow();
});
