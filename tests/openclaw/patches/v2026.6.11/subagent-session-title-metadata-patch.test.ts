import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

const { applyPatch, verifyPatch } =
  require('../../../../scripts/patches/v2026.6.11/025-subagent-session-title-metadata.cjs') as {
    applyPatch: (runtimeDir: string) => string[];
    verifyPatch: (runtimeDir: string) => boolean;
  };

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const FIXTURE = `function buildGatewaySessionRow(params) {
  const { entry } = params;
  const subagentRun = params.subagentRun;
  return {
    key: params.key,
    kind: classifySessionKey(key, entry),
    label: entry?.label,
    displayName,
  };
}
function spawn(params) {
  const task = readStringParam(params, "task", { required: true });
  return task;
}`;

describe('025-subagent-session-title-metadata runtime patch', () => {
  test('projects durable naming metadata without overwriting a stored label', () => {
    const runtimeDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'subagent-session-title-metadata-patch-'),
    );
    temporaryRoots.push(runtimeDir);
    const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    fs.writeFileSync(bundlePath, FIXTURE, 'utf8');

    expect(applyPatch(runtimeDir)).toEqual(['gateway-bundle.mjs']);
    expect(verifyPatch(runtimeDir)).toBe(true);
    expect(applyPatch(runtimeDir)).toEqual([]);

    const patched = fs.readFileSync(bundlePath, 'utf8');
    expect(patched).toContain(
      '...subagentRun?.taskName ? { taskName: subagentRun.taskName } : {},',
    );
    expect(patched).toContain('...subagentRun?.task ? { task: subagentRun.task } : {},');
    expect(patched).toContain('label: entry?.label ?? subagentRun?.label,');
  });

  test('fails visibly when the Gateway row shape changes', () => {
    const runtimeDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'subagent-session-title-metadata-patch-'),
    );
    temporaryRoots.push(runtimeDir);
    fs.writeFileSync(
      path.join(runtimeDir, 'gateway-bundle.mjs'),
      'const unrelated = true;',
      'utf8',
    );

    expect(() => applyPatch(runtimeDir)).toThrow(
      'Subagent session title metadata patch target not found',
    );
  });
});
