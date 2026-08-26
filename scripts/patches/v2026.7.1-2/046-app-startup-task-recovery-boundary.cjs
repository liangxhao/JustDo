'use strict';

// Capability: retire prior-app interrupted work without disabling Gateway restart recovery.
// Target: openclaw@2026.7.1-2 main-session and subagent orphan recovery source/bundle.
// Scope: sessions/runs last active before the stable JustDo app-start boundary only.
// Safety: later Gateway restarts keep recovering work created or resumed by this app process.
// Remove when: upstream exposes a host lifecycle boundary between app startup and Gateway restart.

const fs = require('fs');
const path = require('path');
const {
  findFilesContaining,
  replaceUniquePattern,
  stableFunctionSource,
  writeIfChanged,
} = require('./_patch-utils.js');

const MAIN_MARKER = 'JUSTDO_APP_STARTUP_MAIN_RECOVERY_BOUNDARY_V2026_7_1_2';
const SUBAGENT_MARKER = 'JUSTDO_APP_STARTUP_SUBAGENT_RECOVERY_BOUNDARY_V2026_7_1_2';
const APP_STARTED_AT_ENV = 'JUSTDO_APP_STARTED_AT_MS';

const MAIN_CONTRACTS = [
  'function readJustDoMainAppStartedAtMs(',
  `process.env.${APP_STARTED_AT_ENV}`,
  'if (!isCreatedBeforeJustDoAppStart(',
  'appStartedAtMs: params.appStartedAtMs',
  'if (isJustDoPriorAppMainSession(entry, params.appStartedAtMs))',
  'async function markJustDoPriorAppMainSessionFailed(',
  'expectedUpdatedAt: entry.updatedAt',
  'interrupted by JustDo app restart',
];
const MAIN_COUNTED_CONTRACTS = [
  { contract: 'if (!isCreatedBeforeJustDoAppStart(', count: 1 },
  { contract: 'appStartedAtMs: params.appStartedAtMs', count: 2 },
];
const SUBAGENT_CONTRACTS = [
  'function readJustDoSubagentAppStartedAtMs(',
  'function retireJustDoPriorAppSubagentRuns(',
  `process.env.${APP_STARTED_AT_ENV}`,
  'entry.suppressCompletionDelivery = true;',
  'subagentRunManager.markSubagentRunTerminated({',
  'suppressTaskDelivery: true',
  'retireJustDoPriorAppSubagentRuns();',
];

function readJustDoAppStartedAtMs(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function isCreatedBeforeJustDoAppStart(createdAt, appStartedAtMs) {
  if (appStartedAtMs === undefined) return false;
  const normalizedCreatedAt = Number(createdAt);
  return !Number.isFinite(normalizedCreatedAt) || normalizedCreatedAt < appStartedAtMs;
}

const countOccurrences = (content, contract) => content.split(contract).length - 1;

function assertContracts(content, filePath, contracts, countedContracts = []) {
  const missing = contracts.filter(contract => !content.includes(contract));
  const wrongCounts = countedContracts
    .map(({ contract, count }) => ({
      contract,
      count,
      actual: countOccurrences(content, contract),
    }))
    .filter(item => item.actual !== item.count);
  if (missing.length === 0 && wrongCounts.length === 0) return;
  const details = [
    ...missing.map(contract => `missing ${contract}`),
    ...wrongCounts.map(item => `${item.contract} count=${item.actual}, expected=${item.count}`),
  ];
  throw new Error(
    `${filePath}: incomplete app-start recovery boundary patch; ${details.join('; ')}`,
  );
}

function locateTargets(runtimeDir) {
  const mainFiles = new Set(
    findFilesContaining(runtimeDir, [
      'async function recoverStartupOrphanedMainSessions(params = {})',
      'function scheduleRestartAbortedMainSessionRecovery(params = {})',
      'const resumeDedupeKey = sessionKey;',
    ]),
  );
  for (const filePath of findFilesContaining(runtimeDir, [MAIN_MARKER])) mainFiles.add(filePath);
  for (const filePath of findFilesContaining(runtimeDir, MAIN_CONTRACTS)) mainFiles.add(filePath);

  const subagentFiles = new Set(
    findFilesContaining(runtimeDir, [
      'function restoreSubagentRunsOnce()',
      'subagentRunManager.markSubagentRunTerminated',
      'scheduleSubagentOrphanRecovery()',
    ]),
  );
  for (const filePath of findFilesContaining(runtimeDir, [SUBAGENT_MARKER])) {
    subagentFiles.add(filePath);
  }
  for (const filePath of findFilesContaining(runtimeDir, SUBAGENT_CONTRACTS)) {
    subagentFiles.add(filePath);
  }

  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  if (mainFiles.size !== expected || subagentFiles.size !== expected) {
    throw new Error(
      `App-start recovery targets are main=${mainFiles.size}, subagent=${subagentFiles.size}, expected=${expected} each`,
    );
  }
  return { mainFiles: [...mainFiles], subagentFiles: [...subagentFiles] };
}

function transformMain(content, filePath) {
  const appliedContracts = MAIN_CONTRACTS.filter(contract => content.includes(contract));
  if (appliedContracts.length === MAIN_CONTRACTS.length) {
    assertContracts(content, filePath, MAIN_CONTRACTS, MAIN_COUNTED_CONTRACTS);
    return content;
  }
  if (appliedContracts.length > 0 || content.includes(MAIN_MARKER)) {
    assertContracts(content, filePath, MAIN_CONTRACTS, MAIN_COUNTED_CONTRACTS);
  }

  const readBoundary = stableFunctionSource(readJustDoAppStartedAtMs).replace(
    'readJustDoAppStartedAtMs',
    'readJustDoMainAppStartedAtMs',
  );
  const isPriorSession = `function isJustDoPriorAppMainSession(entry, appStartedAtMs) {
  return isCreatedBeforeJustDoAppStart(entry.updatedAt, appStartedAtMs);
} // ${MAIN_MARKER}`;
  const failPriorSession = `async function markJustDoPriorAppMainSessionFailed(params) {
  return await applyRestartRecoveryLifecycle({
    storePath: params.storePath,
    update: (entries) => {
      const current = entries.find((item) => item.sessionKey === params.sessionKey);
      const entry = current?.entry;
      if (!entry || entry.status !== "running" || entry.updatedAt !== params.expectedUpdatedAt) {
        return { result: false };
      }
      entry.status = "failed";
      entry.abortedLastRun = true;
      entry.endedAt = Date.now();
      entry.updatedAt = entry.endedAt;
      entry.pendingFinalDelivery = undefined;
      entry.pendingFinalDeliveryText = undefined;
      entry.pendingFinalDeliveryCreatedAt = undefined;
      entry.pendingFinalDeliveryLastAttemptAt = undefined;
      entry.pendingFinalDeliveryAttemptCount = undefined;
      entry.pendingFinalDeliveryLastError = undefined;
      entry.pendingFinalDeliveryContext = undefined;
      entry.restartRecoveryDeliveryContext = undefined;
      entry.restartRecoveryDeliveryRunId = undefined;
      return {
        result: true,
        replacements: [{ sessionKey: params.sessionKey, entry }]
      };
    }
  });
}`;

  let updated = replaceUniquePattern(
    content,
    /entry\.abortedLastRun = true;\s*entry\.updatedAt = Date\.now\(\);/,
    `entry.abortedLastRun = true;
          if (!isCreatedBeforeJustDoAppStart(
            entry.updatedAt,
            readJustDoMainAppStartedAtMs(process.env.${APP_STARTED_AT_ENV})
          )) entry.updatedAt = Date.now();`,
    `${filePath}: preserve prior-app main timestamp`,
  );
  updated = replaceUniquePattern(
    updated,
    /(function scheduleRestartAbortedMainSessionRecovery\(params = \{\}\) \{)/,
    `${readBoundary}\n${stableFunctionSource(isCreatedBeforeJustDoAppStart)}\n${isPriorSession}\n${failPriorSession}\n$1`,
    `${filePath}: main app-start recovery helpers`,
  );
  updated = replaceUniquePattern(
    updated,
    /(const storeResult = await recoverStore\(\{[\s\S]*?activeSessionKeys: params\.activeSessionKeys)(\s*\}\);)/,
    '$1,\n      appStartedAtMs: params.appStartedAtMs$2',
    `${filePath}: forward main boundary to store`,
  );
  updated = replaceUniquePattern(
    updated,
    /(const recovered = await recoverRestartAbortedMainSessions\(\{[\s\S]*?activeSessionKeys: params\.activeSessionKeys)(\s*\}\);)/,
    '$1,\n    appStartedAtMs: params.appStartedAtMs$2',
    `${filePath}: forward main boundary through startup recovery`,
  );
  updated = replaceUniquePattern(
    updated,
    /(const resumedSessionKeys = [^\n]+;\n)(\s*const startupRecoveryCutoffMs = Date\.now\(\);)/,
    `$1  const appStartedAtMs = readJustDoMainAppStartedAtMs(process.env.${APP_STARTED_AT_ENV});\n$2`,
    `${filePath}: capture stable app-start boundary`,
  );
  updated = replaceUniquePattern(
    updated,
    /(recoverStartupOrphanedMainSessions\(\{[\s\S]*?updatedBeforeMs: startupRecoveryCutoffMs)(\s*\}\))/,
    '$1,\n      appStartedAtMs$2',
    `${filePath}: apply main app-start boundary`,
  );
  updated = replaceUniquePattern(
    updated,
    /(const resumeDedupeKey = sessionKey;\s*if \(params\.resumedSessionKeys\.has\(resumeDedupeKey\)\) \{\s*result\.skipped\+\+;\s*continue;\s*\})/,
    `$1
    if (isJustDoPriorAppMainSession(entry, params.appStartedAtMs)) {
      const failed = await markJustDoPriorAppMainSessionFailed({
        storePath: params.storePath,
        sessionKey,
        expectedUpdatedAt: entry.updatedAt,
        reason: "interrupted by JustDo app restart"
      });
      if (failed) params.resumedSessionKeys.add(resumeDedupeKey);
      result.skipped++;
      continue;
    }`,
    `${filePath}: fail only prior-app main sessions`,
  );
  assertContracts(updated, filePath, MAIN_CONTRACTS, MAIN_COUNTED_CONTRACTS);
  return updated;
}

function transformSubagent(content, filePath) {
  const appliedContracts = SUBAGENT_CONTRACTS.filter(contract => content.includes(contract));
  if (appliedContracts.length === SUBAGENT_CONTRACTS.length) return content;
  if (content.includes(SUBAGENT_MARKER)) {
    assertContracts(content, filePath, SUBAGENT_CONTRACTS);
  }

  const readBoundary = stableFunctionSource(readJustDoAppStartedAtMs).replace(
    'readJustDoAppStartedAtMs',
    'readJustDoSubagentAppStartedAtMs',
  );
  const isPriorRun = stableFunctionSource(isCreatedBeforeJustDoAppStart).replace(
    'isCreatedBeforeJustDoAppStart',
    'isSubagentCreatedBeforeJustDoAppStart',
  );
  const retirePriorRuns = `function retireJustDoPriorAppSubagentRuns() {
  const appStartedAtMs = readJustDoSubagentAppStartedAtMs(process.env.${APP_STARTED_AT_ENV});
  if (appStartedAtMs === undefined) return;
  const activeRunIds = [];
  let changed = false;
  for (const [runId, entry] of subagentRuns.entries()) {
    if (!isSubagentCreatedBeforeJustDoAppStart(entry.createdAt, appStartedAtMs)) continue;
    const ended = typeof entry.endedAt === "number" && entry.endedAt > 0;
    if (entry.suppressCompletionDelivery !== true) {
      entry.suppressCompletionDelivery = true;
      changed = true;
    }
    if (!ended) activeRunIds.push(runId);
  }
  if (changed) persistSubagentRuns();
  for (const runId of activeRunIds) {
    subagentRunManager.markSubagentRunTerminated({
      runId,
      reason: "interrupted by JustDo app restart",
      suppressTaskDelivery: true
    });
  }
} // ${SUBAGENT_MARKER}`;

  let updated = replaceUniquePattern(
    content,
    /(function restoreSubagentRunsOnce\(\) \{)/,
    `${readBoundary}\n${isPriorRun}\n${retirePriorRuns}\n$1`,
    `${filePath}: subagent app-start recovery helpers`,
  );
  updated = replaceUniquePattern(
    updated,
    /(if \(subagentRegistryDeps\.restoreSubagentRunsFromDisk\(\{[\s\S]*?\}\) === 0\) return;)/,
    '$1\n    retireJustDoPriorAppSubagentRuns();',
    `${filePath}: retire prior-app subagents before restore side effects`,
  );
  assertContracts(updated, filePath, SUBAGENT_CONTRACTS);
  return updated;
}

function applyPatch(runtimeDir) {
  const { mainFiles, subagentFiles } = locateTargets(runtimeDir);
  const transforms = new Map();
  for (const filePath of mainFiles) transforms.set(filePath, [transformMain]);
  for (const filePath of subagentFiles) {
    const fileTransforms = transforms.get(filePath) ?? [];
    fileTransforms.push(transformSubagent);
    transforms.set(filePath, fileTransforms);
  }
  const staged = [...transforms].map(([filePath, fileTransforms]) => {
    const original = fs.readFileSync(filePath, 'utf8');
    const updated = fileTransforms.reduce(
      (current, transform) => transform(current, filePath),
      original,
    );
    return { filePath, original, updated };
  });
  return staged
    .filter(item => writeIfChanged(item.filePath, item.original, item.updated))
    .map(item => path.relative(runtimeDir, item.filePath));
}

function verifyPatch(runtimeDir) {
  const { mainFiles, subagentFiles } = locateTargets(runtimeDir);
  for (const filePath of mainFiles) {
    assertContracts(
      fs.readFileSync(filePath, 'utf8'),
      filePath,
      MAIN_CONTRACTS,
      MAIN_COUNTED_CONTRACTS,
    );
  }
  for (const filePath of subagentFiles) {
    assertContracts(fs.readFileSync(filePath, 'utf8'), filePath, SUBAGENT_CONTRACTS);
  }
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: {
    APP_STARTED_AT_ENV,
    isCreatedBeforeJustDoAppStart,
    readJustDoAppStartedAtMs,
    transformMain,
    transformSubagent,
  },
};
