import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

const { applyPatch } = require('../scripts/patches/v2026.6.11/006-sessions-yield-active-guard.cjs') as {
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

test('guards sessions_yield when no active subagents remain', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-yield-patch-'));
  try {
    fs.mkdirSync(path.join(runtimeDir, 'dist'));
    fs.writeFileSync(
      path.join(runtimeDir, 'dist', 'runtime.js'),
      `${YIELD_TOOL}\n${YIELD_CONSTRUCTION}`,
      'utf8',
    );

    expect(applyPatch(runtimeDir)).toEqual([path.join('dist', 'runtime.js')]);
    const patched = fs.readFileSync(path.join(runtimeDir, 'dist', 'runtime.js'), 'utf8');

    expect(patched).toContain('listControlledSubagentRuns(opts.agentSessionKey)');
    expect(patched).toContain('status: "no_active_subagents"');
    expect(patched).toContain('agentSessionKey: options?.agentSessionKey');
    expect(applyPatch(runtimeDir)).toEqual([]);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});
