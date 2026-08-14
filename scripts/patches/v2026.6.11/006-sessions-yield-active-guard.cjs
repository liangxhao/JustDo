'use strict';

// Purpose: Allow sessions_yield while a controlled child is still executing or
// its required completion delivery is still pending in the per-requester FIFO.
// Affected OpenClaw version: v2026.6.11.
// Risk: This reads the existing subagent registry delivery state. Terminal,
// suppressed, and cleanup-complete deliveries are never treated as future wake
// sources, so a truly idle parent still receives a non-yielding tool result.
// Remove when: OpenClaw natively distinguishes child execution completion from
// required completion-event delivery when deciding whether sessions_yield can
// safely end the current turn.
// Upstream tracking: TODO(openclaw): file issue/PR with the completion-FIFO
// sessions_yield premature-resume reproduction.
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
  if (!content.includes(from)) return { content, changed: false };
  return { content: content.replace(from, to), changed: true };
}

const OLD_ACTIVE_ONLY_GUARD_DIST = `\t\t\tif (typeof opts?.agentSessionKey === "string" && opts.agentSessionKey.trim()) {
\t\t\t\tconst activeSubagents = listControlledSubagentRuns(opts.agentSessionKey).filter((entry) => !entry.endedAt);
\t\t\t\tif (activeSubagents.length === 0) return jsonResult({
\t\t\t\t\tstatus: "no_active_subagents",
\t\t\t\t\tmessage: "No active subagents remain; continue without yielding."
\t\t\t\t});
\t\t\t}`;

const OLD_ACTIVE_ONLY_GUARD_BUNDLE = `      if (typeof opts?.agentSessionKey === "string" && opts.agentSessionKey.trim()) {
        const activeSubagents = listControlledSubagentRuns(opts.agentSessionKey).filter((entry) => !entry.endedAt);
        if (activeSubagents.length === 0) return jsonResult({
          status: "no_active_subagents",
          message: "No active subagents remain; continue without yielding."
        });
      }`;

const OLD_COMPLETION_GUARD_DIST = `\t\t\tif (typeof opts?.agentSessionKey === "string" && opts.agentSessionKey.trim()) {
\t\t\t\tconst controlledRuns = listControlledSubagentRuns(opts.agentSessionKey);
\t\t\t\tif (!hasPendingSessionsYieldWork(controlledRuns, opts.runId)) return jsonResult({
\t\t\t\t\tstatus: "no_active_subagents",
\t\t\t\t\tmessage: "No active subagents or pending completion deliveries remain; continue without yielding."
\t\t\t\t});
\t\t\t}`;

const OLD_COMPLETION_GUARD_BUNDLE = `      if (typeof opts?.agentSessionKey === "string" && opts.agentSessionKey.trim()) {
        const controlledRuns = listControlledSubagentRuns(opts.agentSessionKey);
        if (!hasPendingSessionsYieldWork(controlledRuns, opts.runId)) return jsonResult({
          status: "no_active_subagents",
          message: "No active subagents or pending completion deliveries remain; continue without yielding."
        });
      }`;

const YIELD_WORK_GUARD_DIST = `\t\t\tif (typeof opts?.agentSessionKey === "string" && opts.agentSessionKey.trim()) {
\t\t\t\tconst controlledRuns = listControlledSubagentRuns(opts.agentSessionKey);
\t\t\t\tconst hasPendingYieldWork = controlledRuns.some((entry) => {
\t\t\t\t\tif (typeof entry?.endedAt !== "number") return true;
\t\t\t\t\tconst isCurrentCompletion = typeof opts.runId === "string" && opts.runId.startsWith("announce:v1:") && typeof entry.childSessionKey === "string" && typeof entry.runId === "string" && opts.runId === \`announce:v1:\${entry.childSessionKey}:\${entry.runId}\`;
\t\t\t\t\tif (isCurrentCompletion) return false;
\t\t\t\t\tif (entry.expectsCompletionMessage !== true) return false;
\t\t\t\t\tif (entry.pauseReason === "sessions_yield" || entry.suppressAnnounceReason === "steer-restart") return false;
\t\t\t\t\tif (typeof entry.cleanupCompletedAt === "number") return false;
\t\t\t\t\tconst deliveryStatus = entry.delivery?.status;
\t\t\t\t\treturn deliveryStatus !== "delivered" && deliveryStatus !== "failed" && deliveryStatus !== "discarded";
\t\t\t\t});
\t\t\t\tif (!hasPendingYieldWork) return jsonResult({
\t\t\t\t\tstatus: "no_active_subagents",
\t\t\t\t\tmessage: "No active subagents or pending completion deliveries remain; continue without yielding."
\t\t\t\t});
\t\t\t}`;

const YIELD_WORK_GUARD_BUNDLE = `      if (typeof opts?.agentSessionKey === "string" && opts.agentSessionKey.trim()) {
        const controlledRuns = listControlledSubagentRuns(opts.agentSessionKey);
        const hasPendingYieldWork = controlledRuns.some((entry) => {
          if (typeof entry?.endedAt !== "number") return true;
          const isCurrentCompletion = typeof opts.runId === "string" && opts.runId.startsWith("announce:v1:") && typeof entry.childSessionKey === "string" && typeof entry.runId === "string" && opts.runId === \`announce:v1:\${entry.childSessionKey}:\${entry.runId}\`;
          if (isCurrentCompletion) return false;
          if (entry.expectsCompletionMessage !== true) return false;
          if (entry.pauseReason === "sessions_yield" || entry.suppressAnnounceReason === "steer-restart") return false;
          if (typeof entry.cleanupCompletedAt === "number") return false;
          const deliveryStatus = entry.delivery?.status;
          return deliveryStatus !== "delivered" && deliveryStatus !== "failed" && deliveryStatus !== "discarded";
        });
        if (!hasPendingYieldWork) return jsonResult({
          status: "no_active_subagents",
          message: "No active subagents or pending completion deliveries remain; continue without yielding."
        });
      }`;

function patchFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  let content = fs.readFileSync(filePath, 'utf8');
  if (!content.includes('function createSessionsYieldTool(opts) {')) return false;
  let changed = false;
  let result;

  // Remove the old active-only guard first. It incorrectly treated a terminal
  // child with an undelivered FIFO completion as having no future wake event.
  result = replaceOnce(content, OLD_ACTIVE_ONLY_GUARD_DIST, '');
  content = result.content;
  changed ||= result.changed;
  result = replaceOnce(content, OLD_ACTIVE_ONLY_GUARD_BUNDLE, '');
  content = result.content;
  changed ||= result.changed;
  result = replaceOnce(content, OLD_COMPLETION_GUARD_DIST, '');
  content = result.content;
  changed ||= result.changed;
  result = replaceOnce(content, OLD_COMPLETION_GUARD_BUNDLE, '');
  content = result.content;
  changed ||= result.changed;

  // Older revisions injected top-level helpers. Bundling a patched dist chunk
  // beside an already-patched gateway bundle can concatenate those helpers and
  // create duplicate ESM declarations. Remove the entire injected helper region
  // and keep the predicate local to sessions_yield instead.
  const toolStart = content.indexOf('function createSessionsYieldTool(opts) {');
  const currentHelperStart = content.indexOf('function isCurrentSessionsYieldCompletion(');
  const legacyHelperStart = content.indexOf('function hasPendingSessionsYieldWork(');
  const helperStarts = [currentHelperStart, legacyHelperStart].filter(index => index >= 0 && index < toolStart);
  if (helperStarts.length > 0) {
    const helperStart = Math.min(...helperStarts);
    content = `${content.slice(0, helperStart)}${content.slice(toolStart)}`;
    changed = true;
  }

  if (!content.includes('const hasPendingYieldWork = controlledRuns.some((entry) => {')) {
    const distAnchor = `\t\t\tif (!opts?.onYield) return jsonResult({
\t\t\t\tstatus: "error",
\t\t\t\terror: "Yield not supported in this context"
\t\t\t});`;
    const bundleAnchor = `      if (!opts?.onYield) return jsonResult({
        status: "error",
        error: "Yield not supported in this context"
      });`;
    if (content.includes(distAnchor)) {
      content = content.replace(distAnchor, `${distAnchor}\n${YIELD_WORK_GUARD_DIST}`);
      changed = true;
    } else if (content.includes(bundleAnchor)) {
      content = content.replace(bundleAnchor, `${bundleAnchor}\n${YIELD_WORK_GUARD_BUNDLE}`);
      changed = true;
    }
  }

  const constructionBefore = `\t\tcreateSessionsYieldTool({
\t\t\tsessionId: options?.sessionId,
\t\t\tonYield: options?.onYield
\t\t}),`;
  const constructionAfter = `\t\tcreateSessionsYieldTool({
\t\t\tsessionId: options?.sessionId,
\t\t\tagentSessionKey: options?.agentSessionKey,
\t\t\trunId: options?.runId,
\t\t\tonYield: options?.onYield
\t\t}),`;
  const constructionWithSessionKey = `\t\tcreateSessionsYieldTool({
\t\t\tsessionId: options?.sessionId,
\t\t\tagentSessionKey: options?.agentSessionKey,
\t\t\tonYield: options?.onYield
\t\t}),`;
  result = replaceOnce(content, constructionBefore, constructionAfter);
  content = result.content;
  changed ||= result.changed;
  result = replaceOnce(content, constructionWithSessionKey, constructionAfter);
  content = result.content;
  changed ||= result.changed;

  const constructionBeforeBundle = `    createSessionsYieldTool({
      sessionId: options2?.sessionId,
      onYield: options2?.onYield
    }),`;
  const constructionAfterBundle = `    createSessionsYieldTool({
      sessionId: options2?.sessionId,
      agentSessionKey: options2?.agentSessionKey,
      runId: options2?.runId,
      onYield: options2?.onYield
    }),`;
  const constructionWithSessionKeyBundle = `    createSessionsYieldTool({
      sessionId: options2?.sessionId,
      agentSessionKey: options2?.agentSessionKey,
      onYield: options2?.onYield
    }),`;
  result = replaceOnce(content, constructionBeforeBundle, constructionAfterBundle);
  content = result.content;
  changed ||= result.changed;
  result = replaceOnce(content, constructionWithSessionKeyBundle, constructionAfterBundle);
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
    console.log(`[${label}] Patched sessions_yield completion-delivery guard: ${patched.join(', ')}`);
  } else if (options.verbose) {
    console.log(`[${label}] No sessions_yield completion-delivery guard patch needed.`);
  }
  return patched;
}

function verifyPatch(runtimeDir) {
  const content = fs.readFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), 'utf8');
  const required = [
    'const controlledRuns = listControlledSubagentRuns(opts.agentSessionKey);',
    'const hasPendingYieldWork = controlledRuns.some((entry) => {',
    'opts.runId === `announce:v1:${entry.childSessionKey}:${entry.runId}`',
    'entry.expectsCompletionMessage !== true',
    'deliveryStatus !== "delivered" && deliveryStatus !== "failed" && deliveryStatus !== "discarded"',
    'No active subagents or pending completion deliveries remain; continue without yielding.',
  ];
  const missing = required.filter(marker => !content.includes(marker));
  if (content.includes('const activeSubagents = listControlledSubagentRuns')) {
    missing.push('legacy active-only guard still present');
  }
  if (content.includes('function isCurrentSessionsYieldCompletion(') || content.includes('function hasPendingSessionsYieldWork(')) {
    missing.push('legacy top-level sessions_yield helper still present');
  }
  if (!/agentSessionKey: options\d*\?\.agentSessionKey,/.test(content)) {
    missing.push('agent session key forwarding');
  }
  if (!/runId: options\d*\?\.runId,/.test(content)) {
    missing.push('agent run id forwarding');
  }
  if (missing.length > 0) {
    throw new Error(`Sessions yield completion-delivery guard patch is incomplete: ${missing.join(', ')}`);
  }
  return true;
}

module.exports = { applyPatch, verifyPatch };
