'use strict';

// Capability: retire active work accepted before the current JustDo app process.
// Target: openclaw@2026.9.8 main-session recovery. The upstream durable task registry was removed.
// Scope: running main sessions; one host epoch survives Gateway restarts.
// Safety: prior-app work becomes terminal before OpenClaw can dispatch model recovery.
// Remove when: upstream exposes a host-instance recovery epoch in durable session state.

const fs = require('fs');
const path = require('path');
const {
  countOccurrences,
  assertCurrentPatchContract,
  findFilesContaining,
  findMatchingDelimiter,
  writeIfChanged,
} = require('./_patch-utils.js');

const MAIN_CONTRACT = 'JUSTDO_APP_STARTUP_MAIN_RECOVERY_BOUNDARY_V2026_9_8';
const APP_STARTED_AT_ENV = 'JUSTDO_APP_STARTED_AT_MS';
const MAIN_READ_HELPER = 'readJustDoMainAppStartedAtMs';
const MAIN_PRIOR_HELPER = 'isJustDoPriorAppMainSession';
const MAIN_SETTLE_HELPER = 'settleJustDoPriorAppMainSession';

const MAIN_HELPER_BLOCK = `// Only Gateway restarts inside this host epoch recover.
function ${MAIN_READ_HELPER}() {
  const value = Number(process.env.${APP_STARTED_AT_ENV});
  return Number.isFinite(value) && value > 0 ? value : void 0;
}
function ${MAIN_PRIOR_HELPER}(entry) {
  const appStartedAtMs = ${MAIN_READ_HELPER}();
  if (appStartedAtMs === void 0) return false;
  const startedAt = Number(entry?.startedAt);
  return !Number.isFinite(startedAt) || startedAt < appStartedAtMs;
}
async function ${MAIN_SETTLE_HELPER}(params) {
  const endedAt = Date.now();
  let settled = false;
  await applySessionEntryReplacements({
    sessionKeys: [params.sessionKey],
    storePath: params.storePath,
    update: (entries) => {
      const current = entries.find((candidate) => candidate.sessionKey === params.sessionKey);
      const entry = current?.entry;
      if (!entry || entry.sessionId !== params.sessionId || entry.status !== "running" ||
          entry.abortedLastRun !== true || !${MAIN_PRIOR_HELPER}(entry)) {
        return { result: false };
      }
      Object.assign(entry, {
        ...buildRestartRecoveryClaimCleanupPatch({ entry, recordTerminalSource: false }),
        ...buildMainSessionRecoveryClearPatch(entry),
        status: "failed",
        activeWriterRunId: void 0,
        lifecycleRunId: void 0,
        lastRunId: resolveRestartRecoveryTerminalClientRunId(entry),
        abortedLastRun: false,
        endedAt,
        lastRunError: "interrupted by JustDo app restart",
        runtimeMs: typeof entry.startedAt === "number" ? Math.max(0, endedAt - entry.startedAt) : void 0,
        updatedAt: endedAt
      });
      settled = true;
      return { result: true, replacements: [{ sessionKey: params.sessionKey, entry }] };
    }
  });
  return settled;
}
${MAIN_READ_HELPER}.${MAIN_CONTRACT} = true;
`;

function isPriorAppMainSession(entry, appStartedAtMs) {
  if (appStartedAtMs === undefined) return false;
  const startedAt = Number(entry?.startedAt);
  return !Number.isFinite(startedAt) || startedAt < appStartedAtMs;
}

function expectedCount(runtimeDir) {
  return fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 5 : 4;
}

function mainTargets(runtimeDir) {
  return findFilesContaining(runtimeDir, [
    'async function recoverStore(',
    'buildMainSessionRecoveryClearPatch',
    'resolveRestartRecoveryTerminalClientRunId',
  ]);
}

function transformMain(content, filePath) {
  assertCurrentPatchContract(content, MAIN_CONTRACT, filePath, false);
  const markerCount = countOccurrences(content, MAIN_CONTRACT);
  const hasReadHelper = content.includes(`function ${MAIN_READ_HELPER}(`);
  const hasPriorHelper = content.includes(`function ${MAIN_PRIOR_HELPER}(`);
  const hasSettleHelper = content.includes(`async function ${MAIN_SETTLE_HELPER}(`);
  if (markerCount === 1 && hasReadHelper && hasPriorHelper && hasSettleHelper) {
    assertMainContracts(content, filePath);
    return content;
  }
  if (markerCount > 0 || hasReadHelper || hasPriorHelper || hasSettleHelper) {
    throw new Error(`${filePath}: historical or partial app-start main recovery patch detected`);
  }

  const range = findRecoverStoreRange(content, filePath);
  const resultName =
    /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*\{\s*started:\s*0,\s*settled:\s*0/u.exec(
      range.body,
    )?.[1];
  const loopMatch =
    /for\s*\(\s*(?:const|let)\s*\{\s*sessionKey(?:\s*:\s*([A-Za-z_$][\w$]*))?\s*,\s*entry:\s*([A-Za-z_$][\w$]*)\s*\}/u.exec(
      range.body,
    );
  const sessionKeyName = loopMatch?.[1] ?? (loopMatch ? 'sessionKey' : undefined);
  const observed = /(?:const|let)\s+[\w$]+\s*=\s*await\s+commitMainSessionRecovery\s*\(/u.exec(
    range.body,
  );
  if (!resultName || !sessionKeyName || !observed) {
    throw new Error(`${filePath}: app-start main recovery insertion context is unknown`);
  }
  const parameter = /recoverStore\(([^)]+)\)/.exec(content)[1].trim();
  const entryName =
    /(?:let|const)\s+([\w$]+)\s*=\s*/.exec(
      range.body.slice(loopMatch.index).split('if (stopped())')[1] ?? '',
    )?.[1] ||
    new RegExp('(?:let|const)\\s+([\\w$]+)\\s*=\\s*' + loopMatch[2]).exec(
      range.body.slice(loopMatch.index),
    )?.[1];
  const dedupeName = /handledSessionKeys\.has\(([^)]+)\)/.exec(range.body)?.[1];
  if (!entryName || !dedupeName) throw new Error(filePath + ': recovery bindings missing');
  const guard = `if (${MAIN_PRIOR_HELPER}(${entryName})) {
      const justDoSettled = await ${MAIN_SETTLE_HELPER}({
        sessionId: ${entryName}.sessionId,
        sessionKey: ${sessionKeyName},
        storePath: ${parameter}.storePath
      });
      if (justDoSettled) {
        ${parameter}.handledSessionKeys.add(${dedupeName});
        ${resultName}.settled++;
        mainSessionRecoveryLog.info(\`interrupted prior-app main session: \${${sessionKeyName}}\`);
      } else ${resultName}.skipped++;
      continue;
    }
    `;
  const observedIndex = range.bodyStart + 1 + observed.index;
  const updated =
    content.slice(0, range.signatureIndex) +
    MAIN_HELPER_BLOCK +
    content.slice(range.signatureIndex, observedIndex) +
    guard +
    content.slice(observedIndex);
  assertMainContracts(updated, filePath);
  return updated;
}

function findRecoverStoreRange(content, filePath) {
  const signature = 'async function recoverStore(';
  const signatureIndex = content.indexOf(signature);
  if (signatureIndex < 0 || content.indexOf(signature, signatureIndex + signature.length) >= 0) {
    throw new Error(`${filePath}: recoverStore target is missing or ambiguous`);
  }
  const parameterStart = signatureIndex + signature.length - 1;
  const parameterEnd = findMatchingDelimiter(
    content,
    parameterStart,
    '(',
    ')',
    `${filePath}: recoverStore parameters`,
  );
  let bodyStart = parameterEnd + 1;
  while (/\s/u.test(content[bodyStart] ?? '')) bodyStart += 1;
  const bodyEnd = findMatchingDelimiter(
    content,
    bodyStart,
    '{',
    '}',
    `${filePath}: recoverStore body`,
  );
  return { signatureIndex, bodyStart, bodyEnd, body: content.slice(bodyStart + 1, bodyEnd) };
}

function assertMainContracts(content, filePath) {
  for (const required of [
    MAIN_CONTRACT,
    `process.env.${APP_STARTED_AT_ENV}`,
    `function ${MAIN_PRIOR_HELPER}(`,
    `async function ${MAIN_SETTLE_HELPER}(`,
    'interrupted by JustDo app restart',
    'interrupted prior-app main session',
  ]) {
    if (!content.includes(required)) throw new Error(`${filePath}: missing ${required}`);
  }
  const range = findRecoverStoreRange(content, filePath);
  const boundaryIndex = range.body.indexOf(`${MAIN_PRIOR_HELPER}(`);
  const dispatchIndex = range.body.indexOf('commitMainSessionRecovery(');
  if (boundaryIndex < 0 || dispatchIndex < 0 || boundaryIndex > dispatchIndex) {
    throw new Error(`${filePath}: prior-app main session can reach native recovery dispatch`);
  }
}

function applyPatch(runtimeDir) {
  const files = mainTargets(runtimeDir);
  if (files.length !== expectedCount(runtimeDir))
    throw new Error('main recovery target count changed');
  return files.flatMap(file => {
    const before = fs.readFileSync(file, 'utf8');
    const after = transformMain(before, file);
    return writeIfChanged(file, before, after) ? [path.relative(runtimeDir, file)] : [];
  });
}
function verifyPatch(runtimeDir) {
  const files = mainTargets(runtimeDir);
  if (files.length !== expectedCount(runtimeDir))
    throw new Error('main recovery target count changed');
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    if (transformMain(content, file) !== content)
      throw new Error(file + ': recovery boundary missing');
  }
}
module.exports = {
  applyPatch,
  verifyPatch,
  __testing: { MAIN_CONTRACT, isPriorAppMainSession, transformMain },
};
