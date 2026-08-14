'use strict';

// Purpose: Expose accepted subagent runs as pending until their queued agent
// lane work emits a lifecycle start event.
// Affected OpenClaw version: v2026.6.11.
// Risk: Adds "pending" to registry-backed subagent status projections and
// excludes queue wait time from the displayed execution runtime.
// Remove when: OpenClaw distinguishes queued and running subagent registry
// entries using agent-lane lifecycle state.
// Upstream tracking: TODO(openclaw): file an upstream issue for projecting
// queued subagent runs as running.
// Temporary: yes.

const fs = require('fs');
const path = require('path');

const PENDING_STATUS_MARKER =
  'if (!entry.endedAt) return entry.execution?.status === "pending" ? "pending" : "running";';
const EARLY_START_MARKER =
  'const admittedRunStartedAt = typeof registerParams.executionStartedAt === "number" ? registerParams.executionStartedAt : agentRunStarts.get(runId);';
const REGISTRATION_MARKER = 'status: admittedRunStartedAt === void 0 ? "pending" : "running"';
const LIFECYCLE_MARKER =
  'entry.execution = {\n          ...entry.execution,\n          status: "running",';
const SESSION_STATE_MARKER =
  'liveSubagentRunActive ? subagentRun.execution?.status === "pending" ? "pending" : "active"';
const DEADLINE_MARKER = `function resolveSubagentRunDeadlineMs(entry, observedStartedAt) {
  if (entry.execution?.status === "pending") return;`;
const STARTED_AT_MARKER = `function resolveSubagentSessionStartedAtInternal(entry) {
  if (entry.execution?.status === "pending") return;`;
const RUN_STATUS_MARKER =
  'if (!hasSubagentRunEnded(entry)) return entry.execution?.status === "pending" ? "pending" : "running";';
const SESSION_STARTED_AT_MARKER =
  '...admittedRunStartedAt === void 0 ? {} : { sessionStartedAt: admittedRunStartedAt }';
const LEGACY_ACP_STARTED_INJECTION = `              runTimeoutSeconds: result.runTimeoutSeconds,
              executionStartedAt: Date.now(),
              expectsCompletionMessage: shouldExpectCompletionMessage,`;
const ACP_REGISTRATION_ANCHOR = `              runTimeoutSeconds: result.runTimeoutSeconds,
              expectsCompletionMessage: shouldExpectCompletionMessage,`;

function replaceRequired(content, original, replacement) {
  if (content.includes(replacement)) return { content, changed: false, matched: true };
  if (!content.includes(original)) return { content, changed: false, matched: false };
  return { content: content.replace(original, replacement), changed: true, matched: true };
}

function findMissingMarkers(content) {
  const required = [
    PENDING_STATUS_MARKER,
    EARLY_START_MARKER,
    'agentRunStarts = /* @__PURE__ */ new Map();',
    'agentRunStarts.set(evt.runId',
    REGISTRATION_MARKER,
    LIFECYCLE_MARKER,
    SESSION_STATE_MARKER,
    DEADLINE_MARKER,
    STARTED_AT_MARKER,
    RUN_STATUS_MARKER,
    SESSION_STARTED_AT_MARKER,
    '...admittedRunStartedAt === void 0 ? {} : { startedAt: admittedRunStartedAt }',
    'entry.execution?.status === "pending" ? "pending" : "running"',
  ];
  const missing = required.filter(marker => !content.includes(marker));
  if (content.includes(LEGACY_ACP_STARTED_INJECTION)) {
    missing.push('ACP must wait for lifecycle start');
  }
  return missing;
}

function patchFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  let content = fs.readFileSync(filePath, 'utf8');
  if (
    !content.includes('function registerSubagentRun') &&
    !content.includes('registerSubagentRun2')
  ) {
    return false;
  }
  let changed = false;
  if (content.includes(LEGACY_ACP_STARTED_INJECTION)) {
    content = content.replace(LEGACY_ACP_STARTED_INJECTION, ACP_REGISTRATION_ANCHOR);
    changed = true;
  }
  const legacyEarlyStart = '    const admittedRunStartedAt = agentRunStarts.get(runId);';
  const dynamicEarlyStart = `    const admittedRunStartedAt = typeof registerParams.executionStartedAt === "number" ? registerParams.executionStartedAt : agentRunStarts.get(runId);`;
  if (content.includes(legacyEarlyStart)) {
    content = content.includes(dynamicEarlyStart)
      ? content.replace(`\n${legacyEarlyStart}`, '')
      : content.replace(legacyEarlyStart, dynamicEarlyStart);
    changed = true;
  }
  const replacements = [
    [
      `function resolveSubagentRunDeadlineMs(entry, observedStartedAt) {
  const durationMs = resolveSubagentRunDurationMs(entry.runTimeoutSeconds);`,
      `function resolveSubagentRunDeadlineMs(entry, observedStartedAt) {
  if (entry.execution?.status === "pending") return;
  const durationMs = resolveSubagentRunDurationMs(entry.runTimeoutSeconds);`,
    ],
    [
      `function resolveSubagentSessionStartedAtInternal(entry) {
  if (typeof entry.sessionStartedAt === "number"`,
      `function resolveSubagentSessionStartedAtInternal(entry) {
  if (entry.execution?.status === "pending") return;
  if (typeof entry.sessionStartedAt === "number"`,
    ],
    ['if (!entry.endedAt) return "running";', PENDING_STATUS_MARKER],
    [
      'if (!hasSubagentRunEnded(entry)) return "running";',
      'if (!hasSubagentRunEnded(entry)) return entry.execution?.status === "pending" ? "pending" : "running";',
    ],
    [
      `    const controllerSessionKey = registerParams.controllerSessionKey?.trim() || requesterSessionKey;
    if (!runId || !childSessionKey || !requesterSessionKey) return;
    const now = Date.now();`,
      `    const controllerSessionKey = registerParams.controllerSessionKey?.trim() || requesterSessionKey;
    if (!runId || !childSessionKey || !requesterSessionKey) return;
    const now = Date.now();
    const admittedRunStartedAt = typeof registerParams.executionStartedAt === "number" ? registerParams.executionStartedAt : agentRunStarts.get(runId);`,
    ],
    [
      `      createdAt: now,
      execution: {
        status: "pending",
        queuedAt: now
      },`,
      `      createdAt: now,
      ...admittedRunStartedAt === void 0 ? {} : { startedAt: admittedRunStartedAt },
      execution: {
        status: admittedRunStartedAt === void 0 ? "pending" : "running",
        ...admittedRunStartedAt === void 0 ? { queuedAt: now } : { startedAt: admittedRunStartedAt }
      },`,
    ],
    [
      `      createdAt: now,
      startedAt: now,
      execution: {
        status: "running",
        startedAt: now
      },`,
      `      createdAt: now,
      ...admittedRunStartedAt === void 0 ? {} : { startedAt: admittedRunStartedAt },
      execution: {
        status: admittedRunStartedAt === void 0 ? "pending" : "running",
        ...admittedRunStartedAt === void 0 ? { queuedAt: now } : { startedAt: admittedRunStartedAt }
      },`,
    ],
    [
      `      delivery: { status: registerParams.expectsCompletionMessage === false ? "not_required" : "pending" },
      sessionStartedAt: now,
      accumulatedRuntimeMs: 0,`,
      `      delivery: { status: registerParams.expectsCompletionMessage === false ? "not_required" : "pending" },
      ...admittedRunStartedAt === void 0 ? {} : { sessionStartedAt: admittedRunStartedAt },
      accumulatedRuntimeMs: 0,`,
    ],
    [
      `      delivery: { status: registerParams.expectsCompletionMessage === false ? "not_required" : "pending" },
      accumulatedRuntimeMs: 0,`,
      `      delivery: { status: registerParams.expectsCompletionMessage === false ? "not_required" : "pending" },
      ...admittedRunStartedAt === void 0 ? {} : { sessionStartedAt: admittedRunStartedAt },
      accumulatedRuntimeMs: 0,`,
    ],
    [
      `        const startedAt3 = typeof evt.data?.startedAt === "number" ? evt.data.startedAt : void 0;
        if (startedAt3) {
          entry.startedAt = startedAt3;
          if (typeof entry.sessionStartedAt !== "number") entry.sessionStartedAt = startedAt3;
          persistSubagentRuns();
        }
        return;`,
      `        const startedAt3 = typeof evt.data?.startedAt === "number" ? evt.data.startedAt : Date.now();
        entry.startedAt = startedAt3;
        if (typeof entry.sessionStartedAt !== "number") entry.sessionStartedAt = startedAt3;
        entry.execution = {
          ...entry.execution,
          status: "running",
          startedAt: startedAt3
        };
        persistSubagentRuns();
        return;`,
    ],
    [
      'const subagentRunState = subagentRun ? liveSubagentRunActive ? "active" :',
      `const subagentRunState = subagentRun ? ${SESSION_STATE_MARKER} :`,
    ],
    [
      'const subagentRunState = subagentRun ? liveSubagentRunActive ? subagentStatus === "pending" ? "pending" : "active" :',
      `const subagentRunState = subagentRun ? ${SESSION_STATE_MARKER} :`,
    ],
  ];

  for (const [original, replacement] of replacements) {
    const result = replaceRequired(content, original, replacement);
    content = result.content;
    changed ||= result.changed;
  }

  if (!changed) return false;
  const missing = findMissingMarkers(content);
  if (missing.length > 0) {
    throw new Error(
      `Subagent pending status patch could only be partially applied: ${missing.join(', ')}`,
    );
  }
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

function applyPatch(runtimeDir, options = {}) {
  const candidates = [path.join(runtimeDir, 'gateway-bundle.mjs')].filter(
    (filePath, index, files) => fs.existsSync(filePath) && files.indexOf(filePath) === index,
  );
  const patched = candidates.filter(patchFile).map(filePath => path.relative(runtimeDir, filePath));
  const label = options.label || 'patch-openclaw-subagent-pending-status';
  if (patched.length > 0) {
    console.log(`[${label}] Patched subagent pending status: ${patched.join(', ')}`);
  } else if (options.verbose) {
    console.log(`[${label}] No subagent pending status patch needed.`);
  }
  return patched;
}

function verifyPatch(runtimeDir) {
  const content = fs.readFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), 'utf8');
  const missing = findMissingMarkers(content);
  if (missing.length > 0) {
    throw new Error(`Subagent pending status patch is incomplete: ${missing.join(', ')}`);
  }
  return true;
}

module.exports = { applyPatch, verifyPatch };
