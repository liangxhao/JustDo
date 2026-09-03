'use strict';

// Capability: retire active tasks accepted before the current JustDo app process.
// Target: openclaw@2026.8.2's durable SQLite task-registry maintenance pass.
// Scope: queued/running tasks only; a stable host epoch deliberately survives Gateway restarts.
// Safety: prior-app tasks become cancelled before cron or detached-task recovery can revive them.
// Remove when: upstream exposes a host-instance recovery epoch in durable task state.

const fs = require('fs');
const path = require('path');
const {
  findFilesContaining,
  findMatchingDelimiter,
  replaceUniquePattern,
  writeIfChanged,
} = require('./_patch-utils.js');

const CONTRACT = 'JUSTDO_APP_STARTUP_TASK_RECOVERY_BOUNDARY_V2026_8_2';
const APP_STARTED_AT_ENV = 'JUSTDO_APP_STARTED_AT_MS';
const READ_HELPER = 'readJustDoAppStartedAtMs';
const PRIOR_HELPER = 'isJustDoPriorAppActiveTask';
const RETIRE_HELPER = 'retireJustDoPriorAppTask';

const HELPER_BLOCK = `// ${CONTRACT}: a Gateway restart reuses this host-process epoch.
function ${READ_HELPER}() {
\tconst value = Number(process.env.${APP_STARTED_AT_ENV});
\treturn Number.isFinite(value) && value > 0 ? value : void 0;
}
function ${PRIOR_HELPER}(task) {
\tif (!isActiveTask(task)) return false;
\tconst appStartedAtMs = ${READ_HELPER}();
\tif (appStartedAtMs === void 0) return false;
\tconst createdAt = Number(task.createdAt);
\treturn !Number.isFinite(createdAt) || createdAt < appStartedAtMs;
}
function ${RETIRE_HELPER}(task, now) {
\treturn taskRegistryMaintenanceRuntime.markTaskTerminalById({
\t\ttaskId: task.taskId,
\t\tstatus: "cancelled",
\t\tendedAt: now,
\t\tlastEventAt: now,
\t\terror: "interrupted by JustDo app restart"
\t}) ?? task;
}`;

const REQUIRED = [
  `process.env.${APP_STARTED_AT_ENV}`,
  `function ${PRIOR_HELPER}(`,
  `function ${RETIRE_HELPER}(`,
  `${PRIOR_HELPER}(`,
  'status: "cancelled"',
  'interrupted by JustDo app restart',
];

function readJustDoAppStartedAtMs(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function isPriorAppActiveTask(task, appStartedAtMs) {
  if (task?.status !== 'queued' && task?.status !== 'running') return false;
  if (appStartedAtMs === undefined) return false;
  const createdAt = Number(task.createdAt);
  return !Number.isFinite(createdAt) || createdAt < appStartedAtMs;
}

function expectedCount(runtimeDir) {
  return fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 3 : 2;
}

function targets(runtimeDir) {
  return findFilesContaining(runtimeDir, [
    'async function runTaskRegistryMaintenance()',
    'taskRegistryMaintenanceRuntime.markTaskTerminalById',
    'tryRecoverTaskBeforeMarkLost',
  ]);
}

function findNamedFunctionRange(content, functionName, filePath) {
  const signature = `function ${functionName}(`;
  const signatureIndex = content.indexOf(signature);
  if (signatureIndex < 0 || content.indexOf(signature, signatureIndex + signature.length) >= 0)
    throw new Error(`${filePath}: ${functionName} target is missing or ambiguous`);
  const parameterStart = signatureIndex + signature.length - 1;
  const parameterEnd = findMatchingDelimiter(
    content,
    parameterStart,
    '(',
    ')',
    `${filePath}: ${functionName} parameters`,
  );
  let bodyStart = parameterEnd + 1;
  while (/\s/.test(content[bodyStart] ?? '')) bodyStart += 1;
  const bodyEnd = findMatchingDelimiter(
    content,
    bodyStart,
    '{',
    '}',
    `${filePath}: ${functionName} body`,
  );
  return { signatureIndex, bodyStart, bodyEnd, body: content.slice(bodyStart + 1, bodyEnd) };
}

function findMaintenanceCounters(body, filePath) {
  const now = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*Date\.now\(\)/.exec(body)?.[1];
  const reconciled =
    /status\s*===?\s*(?:"lost"|`lost`)[\s\S]{0,48}?([A-Za-z_$][\w$]*)\s*\+=\s*1/.exec(body)?.[1];
  const processed = /([A-Za-z_$][\w$]*)\s*%\s*SWEEP_YIELD_BATCH_SIZE/.exec(body)?.[1];
  if (!now || !reconciled || !processed)
    throw new Error(`${filePath}: task maintenance counters are unknown`);
  return { now, reconciled, processed };
}

function transform(content, filePath) {
  const present = REQUIRED.filter(contract => content.includes(contract));
  if (present.length === REQUIRED.length) return content;
  const patchSpecificPresent = [
    CONTRACT,
    `function ${READ_HELPER}(`,
    `function ${PRIOR_HELPER}(`,
    `function ${RETIRE_HELPER}(`,
  ].filter(contract => content.includes(contract));
  if (patchSpecificPresent.length > 0)
    throw new Error(`${filePath}: historical or partial app-start task boundary patch detected`);

  const shouldMarkLostIndex = content.indexOf('function shouldMarkLost(');
  if (
    shouldMarkLostIndex < 0 ||
    content.indexOf('function shouldMarkLost(', shouldMarkLostIndex + 1) >= 0
  )
    throw new Error(`${filePath}: shouldMarkLost target is missing or ambiguous`);

  let updated = `${content.slice(0, shouldMarkLostIndex)}${HELPER_BLOCK}${content.slice(
    shouldMarkLostIndex,
  )}`;
  const range = findNamedFunctionRange(updated, 'runTaskRegistryMaintenance', filePath);
  const { now, reconciled, processed } = findMaintenanceCounters(range.body, filePath);
  const currentPattern =
    /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*taskRegistryMaintenanceRuntime\.getTaskById\([^;]+\);\s*if\s*\(\s*!\1\s*\)\s*(?:\{\s*continue;\s*\}|continue;)/;
  const patchedBody = replaceUniquePattern(
    range.body,
    currentPattern,
    match => {
      const current = currentPattern.exec(match)[1];
      return `${match}
\t\tif (${PRIOR_HELPER}(${current})) {
\t\t\tconst justDoRetiredPriorAppTask = ${RETIRE_HELPER}(${current}, ${now});
\t\t\tif (justDoRetiredPriorAppTask.status === "cancelled") ${reconciled} += 1;
\t\t\t${processed} += 1;
\t\t\tif (${processed} % SWEEP_YIELD_BATCH_SIZE === 0) await yieldToEventLoop();
\t\t\tcontinue;
\t\t}`;
    },
    `${filePath}: task recovery boundary`,
  );
  updated = `${updated.slice(0, range.bodyStart + 1)}${patchedBody}${updated.slice(range.bodyEnd)}`;
  return updated;
}

function assertContracts(content, filePath) {
  for (const required of REQUIRED) {
    if (!content.includes(required)) throw new Error(`${filePath}: missing ${required}`);
  }
  const range = findNamedFunctionRange(content, 'runTaskRegistryMaintenance', filePath);
  const boundaryIndex = range.body.indexOf(`${PRIOR_HELPER}(`);
  const cronRecoveryIndex = range.body.indexOf('resolveDurableCronTaskRecovery(');
  const detachedRecoveryIndex = range.body.indexOf('tryRecoverTaskBeforeMarkLost(');
  if (
    boundaryIndex < 0 ||
    boundaryIndex > cronRecoveryIndex ||
    boundaryIndex > detachedRecoveryIndex
  )
    throw new Error(`${filePath}: prior-app tasks can reach native recovery before retirement`);
}

function applyPatch(runtimeDir) {
  const files = targets(runtimeDir);
  const expected = expectedCount(runtimeDir);
  if (files.length !== expected)
    throw new Error(
      `app-start task boundary target count is ${files.length}, expected ${expected}`,
    );
  const changed = [];
  for (const filePath of files) {
    const original = fs.readFileSync(filePath, 'utf8');
    const updated = transform(original, filePath);
    if (writeIfChanged(filePath, original, updated))
      changed.push(path.relative(runtimeDir, filePath));
  }
  return changed;
}

function verifyPatch(runtimeDir) {
  const files = targets(runtimeDir);
  const expected = expectedCount(runtimeDir);
  if (files.length !== expected)
    throw new Error(
      `app-start task boundary target count is ${files.length}, expected ${expected}`,
    );
  for (const filePath of files) assertContracts(fs.readFileSync(filePath, 'utf8'), filePath);
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: {
    APP_STARTED_AT_ENV,
    CONTRACT,
    isPriorAppActiveTask,
    readJustDoAppStartedAtMs,
    transform,
  },
};
