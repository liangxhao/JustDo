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

function normalizeTargetToPristine(content: string, filePath: string): string {
  if (!content.includes(patch.__testing.MARKER)) return content;
  const canonical = patch.__testing.transformGatewayToolInvoke(content, filePath);
  const patchedIndex = canonical.indexOf(patch.__testing.PATCHED_LOOP_DETECTION);
  if (patchedIndex < 0) throw new Error('Patched Gateway tool invoke line was not found');
  const lineStart = canonical.lastIndexOf('\n', patchedIndex) + 1;
  const indent = canonical.slice(lineStart, patchedIndex);
  const pristineLoopDetection = [
    'loopDetection: resolveToolLoopDetectionConfig({',
    `${indent}  cfg: params.cfg,`,
    `${indent}  agentId`,
    `${indent}})`,
  ].join('\n');
  return canonical.replace(patch.__testing.PATCHED_LOOP_DETECTION, pristineLoopDetection);
}

describe('Gateway tool invoke loop-scope patch', () => {
  test('keeps the before-tool hook and approval mode while disabling agent loop accounting', async () => {
    const pristineFunction = `
async function invokeGatewayTool(params) {
  const toolName = params.input.name;
  const action = params.input.action;
  const gatewayTool = { name: toolName };
  return runBeforeToolCallHook({
    toolName,
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
      input: {
        action?: string;
        args?: Record<string, unknown>;
        name: string;
      };
      sessionKey: string;
    }) => Promise<unknown>;

    await invokeGatewayTool({
      approvalMode: 'interactive',
      cfg: {},
      input: { args: { action: 'list' }, name: 'subagents' },
      sessionKey: 'agent:main:cowork:parent',
    });
    await invokeGatewayTool({
      approvalMode: 'interactive',
      cfg: {},
      input: { args: { action: 'kill' }, name: 'subagents' },
      sessionKey: 'agent:main:cowork:parent',
    });
    await invokeGatewayTool({
      approvalMode: 'interactive',
      cfg: {},
      input: { action: 'list', name: 'exec' },
      sessionKey: 'agent:main:cowork:parent',
    });

    expect(resolveToolLoopDetectionConfig).toHaveBeenCalledTimes(2);
    expect(runBeforeToolCallHook).toHaveBeenNthCalledWith(1, {
      toolName: 'subagents',
      ctx: {
        sessionKey: 'agent:main:cowork:parent',
        loopDetection: { enabled: false },
      },
      approvalMode: 'interactive',
    });
    expect(runBeforeToolCallHook).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        toolName: 'subagents',
        ctx: expect.objectContaining({ loopDetection: { enabled: true } }),
      }),
    );
    expect(runBeforeToolCallHook).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        toolName: 'exec',
        ctx: expect.objectContaining({ loopDetection: { enabled: true } }),
      }),
    );
  });

  test('preserves the locked handler authorization, policy, approval, and execution chain', () => {
    const originalSource = normalizeTargetToPristine(
      fs.readFileSync(sourcePath, 'utf8'),
      sourcePath,
    );
    const transformedSource = patch.__testing.transformGatewayToolInvoke(
      originalSource,
      sourcePath,
    );
    const functionStart = transformedSource.indexOf(patch.__testing.FUNCTION_SIGNATURE);
    const functionEnd = transformedSource.indexOf('\nexport ', functionStart);
    const handler = transformedSource.slice(functionStart, functionEnd);

    expect(handler).toContain('resolveGatewayScopedTools({');
    expect(handler).toContain('runBeforeToolCallHook({');
    expect(handler).toContain('approvalMode: params.approvalMode');
    expect(handler).toContain('if (hookResult.blocked)');
    expect(handler).toContain('gatewayTool.execute?.(toolCallId, hookResult.params)');
    expect(handler).toContain(patch.__testing.PATCHED_LOOP_DETECTION);
    expect(handler).toContain('resolveToolLoopDetectionConfig({ cfg: params.cfg, agentId })');

    const originalBundle = normalizeTargetToPristine(
      fs.readFileSync(bundlePath, 'utf8'),
      bundlePath,
    );
    const transformedBundle = patch.__testing.transformGatewayToolInvoke(
      originalBundle,
      bundlePath,
    );
    expect(
      transformedBundle.split(patch.__testing.LOOP_DETECTION_ANCHOR).length - 1,
    ).toBeGreaterThan(0);
  });

  test('transforms the locked source idempotently and rejects partial state', () => {
    const original = normalizeTargetToPristine(fs.readFileSync(sourcePath, 'utf8'), sourcePath);
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
    const patchedIndex = transformed.indexOf(patch.__testing.PATCHED_LOOP_DETECTION);
    const lineStart = transformed.lastIndexOf('\n', patchedIndex) + 1;
    const indent = transformed.slice(lineStart, patchedIndex);
    const bundledWithRelocatedMarker = transformed.replace(
      ` // ${patch.__testing.MARKER}`,
      `\n${indent}// ${patch.__testing.MARKER}`,
    );
    expect(
      patch.__testing.transformGatewayToolInvoke(
        bundledWithRelocatedMarker,
        path.join(runtimeRoot, 'gateway-bundle.mjs'),
      ),
    ).toBe(transformed);
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
    const pristineFixture = normalizeTargetToPristine(
      fs.readFileSync(sourcePath, 'utf8'),
      sourcePath,
    );
    fs.mkdirSync(fixtureDist, { recursive: true });
    fs.writeFileSync(path.join(fixtureDist, path.basename(sourcePath)), pristineFixture);
    // The source and bundle share this handler contract. Reusing the compact
    // locked source avoids copying and rescanning the 50+ MB production bundle
    // in a test whose purpose is atomic multi-target installation.
    fs.writeFileSync(path.join(fixtureRoot, 'gateway-bundle.mjs'), pristineFixture);

    try {
      expect(patch.applyPatch(fixtureRoot)).toHaveLength(2);
      expect(() => patch.verifyPatch(fixtureRoot)).not.toThrow();
      expect(patch.applyPatch(fixtureRoot)).toEqual([]);

      const fixtureBundle = path.join(fixtureRoot, 'gateway-bundle.mjs');
      const patched = fs.readFileSync(fixtureBundle, 'utf8');
      fs.writeFileSync(
        fixtureBundle,
        patched.replace(patch.__testing.PATCHED_LOOP_DETECTION_ANCHOR, 'loopDetection: undefined'),
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
    const original = normalizeTargetToPristine(fs.readFileSync(sourcePath, 'utf8'), sourcePath);
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
