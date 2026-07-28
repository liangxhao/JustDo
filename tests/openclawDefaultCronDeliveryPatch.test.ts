import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

const { applyPatch, __testing } =
  require('../scripts/patches/v2026.6.11/014-default-cron-delivery-none.cjs') as {
    applyPatch: (runtimeDir: string) => string[];
    __testing: Record<string, string>;
  };

test('defaults omitted agent-turn cron delivery to none', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-cron-delivery-default-'));
  try {
    const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    fs.writeFileSync(
      bundlePath,
      `${__testing.ORIGINAL_DELIVERY_HELP}\n${__testing.ORIGINAL_CANONICAL_JOB}`,
      'utf8',
    );

    expect(applyPatch(runtimeDir)).toEqual(['gateway-bundle.mjs']);
    const patched = fs.readFileSync(bundlePath, 'utf8');

    expect(patched).toContain(__testing.PATCHED_DELIVERY_HELP);
    expect(patched).toContain('canonicalJob.delivery = { mode: "none" }');
    expect(patched).toContain('canonicalJob.delivery == null');
    expect(patched).toContain('canonicalJob.payload?.kind === "agentTurn"');
    expect(applyPatch(runtimeDir)).toEqual([]);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});
