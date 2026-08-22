import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { applyPatch, verifyPatch } = require(
  '../../../../scripts/patches/v2026.6.11/024-silent-goal-clear.cjs',
) as {
  applyPatch: (runtimeDir: string) => string[];
  verifyPatch: (runtimeDir: string) => boolean;
};

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const bundleFixture = `const lazyMethods = [
          "sessions.describe",
          "sessions.resolve",
];
const methods = [
      {
        name: "sessions.describe",
        scope: "operator.read"
      },
      {
        name: "sessions.compaction.list",
        scope: "operator.read"
      }
];
const handlers = {
      "sessions.patch": async ({ params, respond, context, client, isWebchatConnect }) => {
        return params;
      }
};
`;

describe('024-silent-goal-clear runtime patch', () => {
  it('adds an idempotent non-chat Goal clear RPC', () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-clear-patch-'));
    tempDirs.push(runtimeDir);
    const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    fs.writeFileSync(bundlePath, bundleFixture, 'utf8');

    expect(applyPatch(runtimeDir)).toEqual(['gateway-bundle.mjs']);
    expect(verifyPatch(runtimeDir)).toBe(true);
    expect(applyPatch(runtimeDir)).toEqual([]);
    const patched = fs.readFileSync(bundlePath, 'utf8');
    expect(patched).toContain('name: "sessions.goal.clear"');
    expect(patched).toContain(
      '"sessions.describe",\n          "sessions.goal.clear",\n          "sessions.resolve"',
    );
    expect(patched).toContain('const cleared = await clearSessionGoal({ sessionKey, storePath });');
    expect(patched).not.toContain('chat.send');
  });

  it('fails visibly when the Gateway shape changes', () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-clear-patch-'));
    tempDirs.push(runtimeDir);
    fs.writeFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), 'const handlers = {};', 'utf8');

    expect(() => applyPatch(runtimeDir)).toThrow('Silent Goal clear patch target not found');
  });
});
