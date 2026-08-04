'use strict';

// Purpose: Prevent sessions_yield from pausing a parent run when there are no
// active subagent runs left to wait for.
// Affected OpenClaw version: v2026.6.11.
// Risk: If OpenClaw's subagent registry is unavailable for a session, the guard
// is skipped and upstream behavior is preserved. When the registry is present
// but empty, sessions_yield returns a tool result instead of aborting the turn.
// Remove when: OpenClaw natively rejects/no-ops sessions_yield with no pending
// child completion events.
// Upstream tracking: TODO(openclaw): file issue/PR with JustDo subagent
// sessions_yield dead-wait reproduction.
// Temporary: yes.

const fs = require('fs');
const path = require('path');

function walkJsFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsFiles(fullPath, out);
    } else if (entry.isFile() && /\.(?:js|mjs|cjs)$/.test(entry.name)) {
      out.push(fullPath);
    }
  }
  return out;
}

function replaceOnce(content, from, to) {
  if (!content.includes(from)) {
    if (content.includes(to)) return { content, changed: false };
    return { content, changed: false };
  }
  return { content: content.replace(from, to), changed: true };
}

function patchFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  let content = fs.readFileSync(filePath, 'utf8');
  let changed = false;

  let result = replaceOnce(
    content,
    `			if (!opts?.onYield) return jsonResult({
				status: "error",
				error: "Yield not supported in this context"
			});
			await opts.onYield(message);`,
    `			if (!opts?.onYield) return jsonResult({
				status: "error",
				error: "Yield not supported in this context"
			});
			if (typeof opts?.agentSessionKey === "string" && opts.agentSessionKey.trim()) {
				const activeSubagents = listControlledSubagentRuns(opts.agentSessionKey).filter((entry) => !entry.endedAt);
				if (activeSubagents.length === 0) return jsonResult({
					status: "no_active_subagents",
					message: "No active subagents remain; continue without yielding."
				});
			}
			await opts.onYield(message);`,
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    `		createSessionsYieldTool({
			sessionId: options?.sessionId,
			onYield: options?.onYield
		}),`,
    `		createSessionsYieldTool({
			sessionId: options?.sessionId,
			agentSessionKey: options?.agentSessionKey,
			onYield: options?.onYield
		}),`,
  );
  content = result.content;
  changed ||= result.changed;

  if (!changed) return false;
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

function applyPatch(runtimeDir, options = {}) {
  const candidates = [
    path.join(runtimeDir, 'gateway-bundle.mjs'),
    ...walkJsFiles(path.join(runtimeDir, 'dist')),
  ].filter((filePath, index, arr) => fs.existsSync(filePath) && arr.indexOf(filePath) === index);

  const patched = [];
  for (const filePath of candidates) {
    if (patchFile(filePath)) patched.push(path.relative(runtimeDir, filePath));
  }

  const label = options.label || 'patch-openclaw-sessions-yield-active-guard';
  if (patched.length > 0) {
    console.log(`[${label}] Patched sessions_yield active-subagent guard: ${patched.join(', ')}`);
  } else if (options.verbose) {
    console.log(`[${label}] No sessions_yield active-subagent guard patch needed.`);
  }

  return patched;
}

function verifyPatch(runtimeDir) {
  const content = fs.readFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), 'utf8');
  const required = [
    'const activeSubagents = listControlledSubagentRuns(opts.agentSessionKey).filter((entry) => !entry.endedAt);',
    'status: "no_active_subagents"',
  ];
  const missing = required.filter(marker => !content.includes(marker));
  if (!/agentSessionKey: options\d*\?\.agentSessionKey,/.test(content)) {
    missing.push('agent session key forwarding');
  }
  if (missing.length > 0) throw new Error(`Sessions yield active guard patch is incomplete: ${missing.join(', ')}`);
  return true;
}

module.exports = { applyPatch, verifyPatch };
