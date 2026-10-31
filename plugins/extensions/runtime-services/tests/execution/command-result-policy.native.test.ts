import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';

// Opt-in conformance against the installed, locked native package, including its
// dependencies. No Gateway, model endpoint or user's state directory is used.
// This exercises native tool semantics, not whether a model follows poll guidance.
const packageRoot = process.env.OPENCLAW_NATIVE_PACKAGE_ROOT;
const requireNative = createRequire(import.meta.url);
type Result = { content: { text?: string }[]; details: Record<string, unknown> };
type Tool = { execute(id: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Result> };
let createExecTool: (defaults: Record<string, unknown>) => Tool;
let createProcessTool: (defaults: Record<string, unknown>) => Tool;
let waitForExecScope: (scope: string) => Promise<void>;
let peekSystemEventEntries: (scope: string) => unknown[];
let acknowledgeInternalToolResult: (result: Result) => void;
let closeStateByPath: ((file: string) => Promise<void>) | undefined;
let directory: string;
let scopeIndex = 0;
const cleanup: (() => Promise<void>)[] = [];
const previousStateDir = process.env.OPENCLAW_STATE_DIR;

// Resolve generated export aliases from the locked package instead of pinning
// content-hashed filenames or importing a potentially different source checkout.
async function nativeExport<T>(prefix: string, symbol: string): Promise<T> {
  const dist = path.join(packageRoot!, 'dist');
  for (const filename of (await readdir(dist)).filter(name => name.startsWith(prefix) && name.endsWith('.mjs'))) {
    const file = path.join(dist, filename);
    const source = await readFile(file, 'utf8');
    const exports = [...source.matchAll(/export\s*\{([^}]+)\}/gu)].map(match => match[1]).join(',');
    const match = new RegExp(`(?:^|,)\\s*${symbol}(?:\\s+as\\s+(\\w+))?\\s*(?=,|$)`, 'u').exec(exports);
    if (match) {
      // Node 24 loads the native ESM graph without Vite transforming it.
      const module = requireNative(file) as Record<string, unknown>;
      return module[match[1] ?? symbol] as T;
    }
  }
  throw new Error(`Locked native export not found: ${symbol}`);
}

describe.skipIf(!packageRoot)('native command result collection without automatic wake', () => {
  beforeAll(async () => {
    const metadata = JSON.parse(await readFile(path.join(packageRoot!, 'package.json'), 'utf8'));
    const repository = JSON.parse(await readFile(path.resolve('package.json'), 'utf8'));
    expect(metadata.name).toBe('openclaw');
    expect(metadata.version).toBe(repository.openclaw.version.replace(/^v/u, ''));
    directory = await mkdtemp(path.join(os.tmpdir(), 'command-result-policy-'));
    process.env.OPENCLAW_STATE_DIR = directory;
    [createExecTool, createProcessTool, waitForExecScope, peekSystemEventEntries, acknowledgeInternalToolResult] = await Promise.all([
      nativeExport<typeof createExecTool>('bash-tools-', 'createExecTool'),
      nativeExport<typeof createProcessTool>('bash-tools-', 'createProcessTool'),
      nativeExport<typeof waitForExecScope>('bash-process-registry-', 'waitForExecScope'),
      nativeExport<typeof peekSystemEventEntries>('system-events-', 'peekSystemEventEntries'),
      nativeExport<typeof acknowledgeInternalToolResult>('internal-hooks-', 'acknowledgeInternalToolResult'),
    ]);
    closeStateByPath = await nativeExport('openclaw-state-db-', 'closeOpenClawStateDatabaseByPathAsync');
  });

  afterEach(async () => {
    for (const dispose of cleanup.splice(0)) await dispose();
  });
  afterAll(async () => {
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    if (directory) {
      const resolved = path.resolve(directory);
      expect(path.dirname(resolved)).toBe(path.resolve(os.tmpdir()));
      expect(path.basename(resolved)).toMatch(/^command-result-policy-/u);
      await closeStateByPath?.(path.join(resolved, 'state', 'openclaw.sqlite'));
      await rm(resolved, { recursive: true, force: true });
    }
  });

  async function fixture(source: string) {
    const scope = `agent:main:command-result-${++scopeIndex}`;
    const script = path.join(directory, `command-${scopeIndex}.cjs`);
    await writeFile(script, source);
    const quote = (value: string) => `'${value.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''")}'`;
    const command = `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} ${quote(script)}`;
    const exec = createExecTool({
      host: 'gateway', security: 'full', ask: 'off', notifyOnExit: false,
      allowBackground: true, scopeKey: scope, sessionKey: scope, cwd: directory,
    });
    const processTool = createProcessTool({ scopeKey: scope });
    return { exec, processTool, scope, command };
  }

  function track(f: Awaited<ReturnType<typeof fixture>>, sessionId: string) {
    cleanup.push(async () => {
      await f.processTool.execute('cleanup', { action: 'kill', sessionId });
      await waitForExecScope(f.scope);
    });
  }

  test.each([0, 7])('collects exit %i by poll without a completion event', async exitCode => {
    const f = await fixture(`setTimeout(() => { console.log('COLLECTED_RESULT'); process.exit(${exitCode}); }, 250);`);
    const launched = await f.exec.execute('launch', { command: f.command, yieldMs: 10 });
    expect(launched.details.status).toBe('running');
    const sessionId = launched.details.sessionId as string;
    track(f, sessionId);
    expect(launched.content.map(block => block.text ?? '').join('')).toContain('Automatic completion wake is disabled');
    expect(launched.details.followUp).toContain('collect it before ending the turn');
    await waitForExecScope(f.scope);
    // Check before acknowledgement: poll must not conceal an unwanted wake.
    expect(peekSystemEventEntries(f.scope)).toEqual([]);
    const result = await f.processTool.execute('collect', { action: 'poll', sessionId, timeout: 10_000 });
    acknowledgeInternalToolResult(result);
    // Native process status reports collection completion separately from the
    // command exit code. PowerShell may normalize a child nonzero exit to 1.
    expect(result.details.status).toBe('completed');
    if (exitCode === 0) expect(result.details.exitCode).toBe(0);
    else expect(result.details.exitCode).not.toBe(0);
    expect(result.content.map(block => block.text ?? '').join('')).toContain('COLLECTED_RESULT');
    expect(peekSystemEventEntries(f.scope)).toEqual([]);
  });

  test('preserves an explicit long-lived background command and manual stop', async () => {
    const f = await fixture("console.log('SERVICE_READY'); setInterval(() => {}, 1000);");
    const launched = await f.exec.execute('service', { command: f.command, background: true, timeoutSeconds: 0 });
    expect(launched.details.status).toBe('running');
    const sessionId = launched.details.sessionId as string;
    track(f, sessionId);
    const observed = await f.processTool.execute('observe', { action: 'poll', sessionId, timeout: 250 });
    acknowledgeInternalToolResult(observed);
    expect(observed.details.status).toBe('running');
    await f.processTool.execute('stop', { action: 'kill', sessionId });
    await waitForExecScope(f.scope);
    expect(peekSystemEventEntries(f.scope)).toEqual([]);
  });

  test('retains native opt-in foreground waiting beyond the yield window', async () => {
    const f = await fixture("setTimeout(() => console.log('INLINE_RESULT'), 250);");
    const result = await f.exec.execute('foreground', { command: f.command, awaitResults: true, yieldMs: 10 });
    expect(result.details).toMatchObject({ status: 'completed', exitCode: 0 });
    expect(result.content.map(block => block.text ?? '').join('')).toContain('INLINE_RESULT');
    expect(peekSystemEventEntries(f.scope)).toEqual([]);
  });

  test('retains command timeout without emitting a completion wake', async () => {
    const f = await fixture('setInterval(() => {}, 1000);');
    const result = await f.exec.execute('timeout', { command: f.command, awaitResults: true, timeoutSeconds: 1 });
    expect(result.details.status).toBe('failed');
    expect(result.content.map(block => block.text ?? '').join('')).toMatch(/timed?\s*out|timeout/iu);
    await waitForExecScope(f.scope);
    expect(peekSystemEventEntries(f.scope)).toEqual([]);
  });

  test('retains foreground cancellation without emitting a completion wake', async () => {
    const f = await fixture('setInterval(() => {}, 1000);');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 250);
    try {
      await expect(f.exec.execute('cancel', {
        command: f.command, awaitResults: true,
      }, controller.signal)).rejects.toThrow(/abort/iu);
      await waitForExecScope(f.scope);
      expect(peekSystemEventEntries(f.scope)).toEqual([]);
    } finally {
      clearTimeout(timer);
    }
  });
});
