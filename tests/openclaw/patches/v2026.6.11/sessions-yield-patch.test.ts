import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

const { applyPatch } = require('../../../../scripts/patches/v2026.6.11/006-sessions-yield-active-guard.cjs') as {
  applyPatch: (runtimeDir: string) => string[];
};

const YIELD_TOOL = `function createSessionsYieldTool(opts) {
\treturn {
\t\tlabel: "Yield",
\t\tname: "sessions_yield",
\t\tdescription: "End current turn. Use after spawning subagents; results arrive as next message.",
\t\tparameters: SessionsYieldToolSchema,
\t\texecute: async (_toolCallId, args) => {
\t\t\tconst message = readStringParam(args, "message") || "Turn yielded.";
\t\t\tif (!opts?.sessionId) return jsonResult({
\t\t\t\tstatus: "error",
\t\t\t\terror: "No session context"
\t\t\t});
\t\t\tif (!opts?.onYield) return jsonResult({
\t\t\t\tstatus: "error",
\t\t\t\terror: "Yield not supported in this context"
\t\t\t});
\t\t\tawait opts.onYield(message);
\t\t\treturn jsonResult({
\t\t\t\tstatus: "yielded",
\t\t\t\tmessage
\t\t\t});
\t\t}
\t};
}`;

const YIELD_CONSTRUCTION = `\t\tcreateSessionsYieldTool({
\t\t\tsessionId: options?.sessionId,
\t\t\tonYield: options?.onYield
\t\t}),`;

const DUPLICATE_LEGACY_HELPERS = `function isCurrentSessionsYieldCompletion(entry, currentRunId) {
  return currentRunId === \`announce:v1:\${entry.childSessionKey}:\${entry.runId}\`;
}
function hasPendingSessionsYieldWork(entries, currentRunId) {
  return entries.some((entry) => !isCurrentSessionsYieldCompletion(entry, currentRunId));
}
function isCurrentSessionsYieldCompletion(entry, currentRunId) {
  return currentRunId === \`announce:v1:\${entry.childSessionKey}:\${entry.runId}\`;
}
function hasPendingSessionsYieldWork(entries, currentRunId) {
  return entries.some((entry) => !isCurrentSessionsYieldCompletion(entry, currentRunId));
}`;

test('keeps yielding until active children and required completion deliveries are exhausted', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-yield-patch-'));
  try {
    fs.mkdirSync(path.join(runtimeDir, 'dist'));
    fs.writeFileSync(
      path.join(runtimeDir, 'dist', 'runtime.js'),
      `${DUPLICATE_LEGACY_HELPERS}\n${YIELD_TOOL}\n${YIELD_CONSTRUCTION}`,
      'utf8',
    );

    expect(applyPatch(runtimeDir)).toEqual([path.join('dist', 'runtime.js')]);
    const patched = fs.readFileSync(path.join(runtimeDir, 'dist', 'runtime.js'), 'utf8');

    expect(patched).toContain('const hasPendingYieldWork = controlledRuns.some((entry) => {');
    expect(patched).toContain('status: "no_active_subagents"');
    expect(patched).toContain('agentSessionKey: options?.agentSessionKey');
    expect(patched).toContain('runId: options?.runId');
    expect(patched).not.toContain('const activeSubagents =');
    expect(patched).not.toContain('function isCurrentSessionsYieldCompletion');
    expect(patched).not.toContain('function hasPendingSessionsYieldWork');

    const currentCompletion = {
      runId: 'child-current',
      childSessionKey: 'agent:main:subagent:child-session',
      endedAt: 2,
      expectsCompletionMessage: true,
      delivery: { status: 'in_progress' },
    };
    const currentAnnounceRunId =
      'announce:v1:agent:main:subagent:child-session:child-current';

    const toolSource = patched.match(/function createSessionsYieldTool[\s\S]*?\n}/)?.[0];
    expect(toolSource).toBeTruthy();
    let controlledRuns: Array<Record<string, unknown>> = [
      {
        endedAt: 2,
        expectsCompletionMessage: true,
        delivery: { status: 'pending' },
      },
    ];
    const createTool = new Function(
      'SessionsYieldToolSchema',
      'readStringParam',
      'jsonResult',
      'listControlledSubagentRuns',
      `${toolSource}; return createSessionsYieldTool;`,
    )(
      {},
      (args: Record<string, unknown>, key: string) => args[key],
      (value: unknown) => value,
      () => controlledRuns,
    ) as (opts: Record<string, unknown>) => {
      execute: (toolCallId: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    let yieldedMessage: string | undefined;
    const tool = createTool({
      sessionId: 'parent-session',
      agentSessionKey: 'agent:main:parent',
      onYield: async (message: string) => {
        yieldedMessage = message;
      },
    });
    await expect(tool.execute('call-1', { message: 'wait' })).resolves.toEqual({
      status: 'yielded',
      message: 'wait',
    });
    expect(yieldedMessage).toBe('wait');

    controlledRuns = [currentCompletion];
    yieldedMessage = undefined;
    const currentCompletionTool = createTool({
      sessionId: 'parent-session',
      agentSessionKey: 'agent:main:parent',
      runId: currentAnnounceRunId,
      onYield: async (message: string) => {
        yieldedMessage = message;
      },
    });
    await expect(currentCompletionTool.execute('call-2', { message: 'wait' })).resolves.toEqual({
      status: 'no_active_subagents',
      message: 'No active subagents or pending completion deliveries remain; continue without yielding.',
    });
    expect(yieldedMessage).toBeUndefined();
    expect(applyPatch(runtimeDir)).toEqual([]);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});
