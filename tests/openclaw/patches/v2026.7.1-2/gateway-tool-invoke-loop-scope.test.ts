import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test, vi } from 'vitest';

const patch =
  require('../../../../scripts/patches/v2026.7.1-2/049-gateway-tool-invoke-loop-scope.cjs') as {
    applyPatch: (runtimeDir: string) => string[];
    verifyPatch: (runtimeDir: string) => void;
    __testing: {
      FUNCTION_SIGNATURE: string;
      LOOP_DETECTION_ANCHOR: string;
      MARKER: string;
      ORIGINAL_LOOP_DETECTION_PATTERN: RegExp;
      PATCHED_LOOP_DETECTION_ANCHOR: string;
      PATCHED_LOOP_DETECTION: string;
      transformGatewayToolInvoke: (content: string, filePath: string) => string;
    };
  };

const runtimeRoot = path.resolve('vendor/openclaw-runtime/current');
const runtimeDist = path.join(runtimeRoot, 'dist');

function findGatewayToolInvokeSource(): string {
  const candidate = fs.readdirSync(runtimeDist).find(fileName => {
    if (!fileName.endsWith('.js')) return false;
    const content = fs.readFileSync(path.join(runtimeDist, fileName), 'utf8');
    return (
      content.includes(patch.__testing.FUNCTION_SIGNATURE) &&
      (content.includes(patch.__testing.LOOP_DETECTION_ANCHOR) ||
        content.includes(patch.__testing.MARKER))
    );
  });
  if (!candidate) throw new Error('Gateway tool invoke source was not found');
  return path.join(runtimeDist, candidate);
}

const sourcePath = findGatewayToolInvokeSource();
const bundlePath = path.join(runtimeRoot, 'gateway-bundle.mjs');

describe('Gateway tool invoke loop-scope patch', () => {
  test('keeps the before-tool hook and approval mode while disabling agent loop accounting', async () => {
    const pristineFunction = `
async function invokeGatewayTool(params) {
  return runBeforeToolCallHook({
    toolName: "subagents",
    ctx: {
      sessionKey: params.sessionKey,
      loopDetection: resolveToolLoopDetectionConfig({
        cfg: params.cfg,
        agentId
      })
    },
    approvalMode: params.approvalMode
  });
}`;
    const transformed = patch.__testing.transformGatewayToolInvoke(
      pristineFunction,
      'tools-invoke.js',
    );
    const runBeforeToolCallHook = vi.fn().mockResolvedValue({ blocked: false });
    const resolveToolLoopDetectionConfig = vi.fn(() => ({ enabled: true }));
    const invokeGatewayTool = new Function(
      'runBeforeToolCallHook',
      'resolveToolLoopDetectionConfig',
      'agentId',
      `${transformed}; return invokeGatewayTool;`,
    )(runBeforeToolCallHook, resolveToolLoopDetectionConfig, 'main') as (params: {
      approvalMode: string;
      cfg: Record<string, unknown>;
      sessionKey: string;
    }) => Promise<unknown>;

    await invokeGatewayTool({
      approvalMode: 'interactive',
      cfg: {},
      sessionKey: 'agent:main:cowork:parent',
    });

    expect(resolveToolLoopDetectionConfig).not.toHaveBeenCalled();
    expect(runBeforeToolCallHook).toHaveBeenCalledWith({
      toolName: 'subagents',
      ctx: {
        sessionKey: 'agent:main:cowork:parent',
        loopDetection: { enabled: false },
      },
      approvalMode: 'interactive',
    });
  });

  test('transforms the locked source idempotently and rejects partial state', () => {
    const original = fs.readFileSync(sourcePath, 'utf8');
    const transformed = patch.__testing.transformGatewayToolInvoke(original, sourcePath);

    expect(transformed).toContain(patch.__testing.PATCHED_LOOP_DETECTION);
    expect(patch.__testing.transformGatewayToolInvoke(transformed, sourcePath)).toBe(transformed);
    const bundledWithoutComment = transformed.replace(` // ${patch.__testing.MARKER}`, '');
    expect(
      patch.__testing.transformGatewayToolInvoke(
        bundledWithoutComment,
        path.join(runtimeRoot, 'gateway-bundle.mjs'),
      ),
    ).toContain(patch.__testing.PATCHED_LOOP_DETECTION);
    expect(() =>
      patch.__testing.transformGatewayToolInvoke(
        transformed.replace(patch.__testing.MARKER, 'PARTIAL_MARKER'),
        sourcePath,
      ),
    ).toThrow('partial Gateway tool invoke loop-scope patch');
    expect(() =>
      patch.__testing.transformGatewayToolInvoke(
        `${original}\n${original}`,
        sourcePath,
      ),
    ).toThrow('Gateway tool invoke loop-detection contract is ambiguous');
  });

  test('applies and verifies both source and bundle targets atomically', () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-tool-loop-scope-patch-'));
    const fixtureDist = path.join(fixtureRoot, 'dist');
    fs.mkdirSync(fixtureDist, { recursive: true });
    fs.copyFileSync(sourcePath, path.join(fixtureDist, path.basename(sourcePath)));
    fs.copyFileSync(bundlePath, path.join(fixtureRoot, 'gateway-bundle.mjs'));

    try {
      expect(patch.applyPatch(fixtureRoot)).toHaveLength(2);
      expect(() => patch.verifyPatch(fixtureRoot)).not.toThrow();
      expect(patch.applyPatch(fixtureRoot)).toEqual([]);

      const fixtureBundle = path.join(fixtureRoot, 'gateway-bundle.mjs');
      const patched = fs.readFileSync(fixtureBundle, 'utf8');
      fs.writeFileSync(
        fixtureBundle,
        patched.replace(patch.__testing.PATCHED_LOOP_DETECTION, 'loopDetection: undefined'),
      );
      expect(() => patch.verifyPatch(fixtureRoot)).toThrow(
        'Gateway tool invoke loop-scope contract is incomplete',
      );
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test('rejects duplicate source targets before writing', () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-tool-loop-scope-atomic-'));
    const fixtureDist = path.join(fixtureRoot, 'dist');
    const original = fs.readFileSync(sourcePath, 'utf8');
    fs.mkdirSync(fixtureDist, { recursive: true });
    fs.writeFileSync(path.join(fixtureDist, 'tools-a.js'), original);
    fs.writeFileSync(path.join(fixtureDist, 'tools-b.js'), original);

    try {
      expect(() => patch.applyPatch(fixtureRoot)).toThrow(
        'target count is source=2, bundle=0; expected source=1, bundle=0',
      );
      expect(fs.readFileSync(path.join(fixtureDist, 'tools-a.js'), 'utf8')).toBe(original);
      expect(fs.readFileSync(path.join(fixtureDist, 'tools-b.js'), 'utf8')).toBe(original);
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
