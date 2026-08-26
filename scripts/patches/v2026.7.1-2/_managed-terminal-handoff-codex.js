'use strict';

const path = require('path');
const { replaceUnique, replaceUniquePattern, stableFunctionSource } = require('./_patch-utils.js');
const {
  shouldAttemptJustDoCodexTerminalHandoff,
  resolveJustDoCodexTerminalHandoffOutcome,
} = require('./_managed-terminal-handoff-core.js');

const MARKER = 'JUSTDO_MANAGED_TERMINAL_HANDOFF_V2026_7_1_2';
const REVISION_PREFIX = '__JUSTDO_MANAGED_IMPLICIT_JOIN__\n';

const CODEX_HELPERS = `const JUSTDO_MANAGED_CODEX_TERMINAL_HANDOFF_GLOBAL = Symbol.for("justdo.openclaw.managed-subagent-join.v2026.7.1-2"); // ${MARKER}
const JUSTDO_MANAGED_CODEX_TERMINAL_HANDOFF_PREFIX = ${JSON.stringify(REVISION_PREFIX)};
${stableFunctionSource(shouldAttemptJustDoCodexTerminalHandoff)}
${stableFunctionSource(resolveJustDoCodexTerminalHandoffOutcome)}
function resolveJustDoCodexCompletionSourceSessionKey(inputProvenance) {
\tif (inputProvenance?.kind !== "inter_session" || inputProvenance?.sourceTool?.trim().toLowerCase() !== "subagent_announce") return void 0;
\treturn typeof inputProvenance.sourceSessionKey === "string" ? inputProvenance.sourceSessionKey.trim() : "";
}
`;

function transformCodexAttempt(content, filePath) {
  const contracts = [
    'JUSTDO_MANAGED_CODEX_TERMINAL_HANDOFF_GLOBAL',
    'justDoManagedCodexTerminalRevisionReason',
    'excludedChildSessionKey: justDoManagedCodexCompletionSource',
    'beforeAgentFinalizeRevisionReason: justDoManagedCodexTerminalRevisionReason',
    'suppressManagedJoinContinuationCommit: Boolean(justDoManagedCodexHandoffClaimed || justDoManagedCodexDurabilityError)',
    'resolveJustDoCodexTerminalHandoffOutcome(',
    'handoffOutcome.status === "durability_error"',
    'justDoManagedCodexHandoffClaimed = implicitJoin?.status === "joined"',
    'let justDoManagedCodexHandoffClaimed = false;\n\t\teffectiveTimedOut = timedOut && !recoveredTurnWatchTimeout',
    'result.agentHarnessResultClassification === void 0 || toolBridge.telemetry.didDeliverSourceReplyViaMessageTool',
  ];
  const appliedCount = contracts.filter(contract => content.includes(contract)).length;
  if (appliedCount === contracts.length) return content;
  if (appliedCount > 0)
    throw new Error(`${filePath}: partial Codex terminal handoff patch detected`);
  let updated = replaceUnique(
    content,
    'async function runCodexAppServerAttempt(params, options) {',
    `${CODEX_HELPERS}async function runCodexAppServerAttempt(params, options) {`,
    `${filePath}: Codex terminal handoff helpers`,
  );
  updated = replaceUnique(
    updated,
    'const effectiveTimedOut = timedOut && !recoveredTurnWatchTimeout;\n\t\tconst effectiveTurnCompletionIdleTimedOut',
    'let effectiveTimedOut = timedOut && !recoveredTurnWatchTimeout;\n\t\tlet effectiveTurnCompletionIdleTimedOut',
    `${filePath}: mutable Codex timeout state`,
  );
  updated = replaceUnique(
    updated,
    'if (refreshedUsageLimitPromptError) finalPromptError = refreshedUsageLimitPromptError;\n\t\tconst finalPromptErrorSource = effectiveTimedOut || clientClosedPromptErrorForFinal ? "prompt" : result.promptErrorSource;',
    `if (refreshedUsageLimitPromptError) finalPromptError = refreshedUsageLimitPromptError;
\t\tlet justDoManagedCodexTerminalRevisionReason;
\t\tlet justDoManagedCodexDurabilityError;
\t\tlet justDoManagedCodexHandoffClaimed = false;
\t\teffectiveTimedOut = timedOut && !recoveredTurnWatchTimeout;
\t\teffectiveTurnCompletionIdleTimedOut = turnCompletionIdleTimedOut && !recoveredTurnWatchTimeout;
\t\tif (!finalPromptError && effectiveTurnCompletionIdleTimedOut) finalPromptError = turnCompletionIdleTimeoutMessage;
\t\telse if (!finalPromptError && effectiveTimedOut) finalPromptError = "codex app-server attempt timed out";
\t\tconst justDoManagedCodexFinalAbortedBeforeHandoff = isFinalAborted();
\t\tconst justDoManagedCodexCompletedTurnStatusBeforeHandoff = activeProjector.getCompletedTurnStatus();
\t\tconst justDoManagedCodexAttemptSucceededBeforeHandoff = !justDoManagedCodexFinalAbortedBeforeHandoff && !effectiveTimedOut && (finalPromptError === null || finalPromptError === void 0) && (result.agentHarnessResultClassification === void 0 || toolBridge.telemetry.didDeliverSourceReplyViaMessageTool) && (justDoManagedCodexCompletedTurnStatusBeforeHandoff === "completed" || recoveredTurnWatchTimeout || completed && !terminalTurnNotificationQueued && !timedOut && clientClosedPromptErrorForFinal === void 0);
\t\tconst justDoManagedCodexBridge = globalThis[JUSTDO_MANAGED_CODEX_TERMINAL_HANDOFF_GLOBAL];
\t\tif (shouldAttemptJustDoCodexTerminalHandoff({
\t\t\tattemptSucceeded: justDoManagedCodexAttemptSucceededBeforeHandoff,
\t\t\thasSessionKey: typeof params.sessionKey === "string" && Boolean(params.sessionKey.trim()),
\t\t\taborted: justDoManagedCodexFinalAbortedBeforeHandoff,
\t\t\ttimedOut: effectiveTimedOut,
\t\t\tpromptError: Boolean(finalPromptError),
\t\t\tyieldDetected
\t\t}) && justDoManagedCodexBridge?.isManagedSession?.(params.sessionKey) === true) {
\t\t\tconst justDoManagedCodexCompletionSource = resolveJustDoCodexCompletionSourceSessionKey(params.inputProvenance);
\t\t\tif (justDoManagedCodexCompletionSource !== "") {
\t\t\t\tconst implicitJoin = await justDoManagedCodexBridge.waitForRequiredChildren?.({
\t\t\t\t\tcontrollerSessionKey: params.sessionKey,
\t\t\t\t\tsessionId: params.sessionId,
\t\t\t\t\trunId: params.runId,
\t\t\t\t\texcludedChildSessionKey: justDoManagedCodexCompletionSource,
\t\t\t\t\tabortSignal: runAbortController.signal
\t\t\t\t});
\t\t\t\tjustDoManagedCodexHandoffClaimed = implicitJoin?.status === "joined";
\t\t\t\teffectiveTimedOut = timedOut && !recoveredTurnWatchTimeout;
\t\t\t\teffectiveTurnCompletionIdleTimedOut = turnCompletionIdleTimedOut && !recoveredTurnWatchTimeout;
\t\t\t\tconst justDoManagedCodexFinalAbortedAfterHandoff = isFinalAborted();
\t\t\t\tif (!finalPromptError && effectiveTurnCompletionIdleTimedOut) finalPromptError = turnCompletionIdleTimeoutMessage;
\t\t\t\telse if (!finalPromptError && effectiveTimedOut) finalPromptError = "codex app-server attempt timed out";
\t\t\t\tconst handoffOutcome = resolveJustDoCodexTerminalHandoffOutcome(implicitJoin, { aborted: justDoManagedCodexFinalAbortedAfterHandoff, timedOut: effectiveTimedOut });
\t\t\t\tif (handoffOutcome.status === "joined") justDoManagedCodexTerminalRevisionReason = JUSTDO_MANAGED_CODEX_TERMINAL_HANDOFF_PREFIX + handoffOutcome.prompt;
\t\t\t\telse if (handoffOutcome.status === "interrupted" && justDoManagedCodexHandoffClaimed) justDoManagedCodexBridge.restoreImplicitDelivery?.(params.sessionKey, params.runId);
\t\t\t\telse if (handoffOutcome.status === "durability_error") {
\t\t\t\t\tjustDoManagedCodexDurabilityError = new Error("Managed subagent terminal handoff could not be persisted.");
\t\t\t\t\tfinalPromptError = justDoManagedCodexDurabilityError;
\t\t\t\t}
\t\t\t}
\t\t}
\t\tconst finalPromptErrorSource = effectiveTimedOut || clientClosedPromptErrorForFinal || justDoManagedCodexDurabilityError ? "prompt" : result.promptErrorSource;`,
    `${filePath}: Codex terminal handoff`,
  );
  updated = replaceUniquePattern(
    updated,
    /(?<indent>[ \t]+)const assistantTranscriptOwned = await mirrorTranscriptBestEffort\(\{(?<body>[\s\S]*?)\n\k<indent>\tturnId: activeTurnId\n\k<indent>\}\);/,
    (_match, indent, body) =>
      `${indent}const assistantTranscriptOwned = await mirrorTranscriptBestEffort({${body}\n${indent}\tturnId: activeTurnId,\n${indent}\tsuppressManagedJoinContinuationCommit: Boolean(justDoManagedCodexHandoffClaimed || justDoManagedCodexDurabilityError)\n${indent}});`,
    `${filePath}: suppress candidate Codex continuation commit`,
  );
  return replaceUnique(
    updated,
    '...assistantTranscriptOwned ? { assistantTranscriptOwned: true } : {},\n\t\t\tsystemPromptReport',
    '...assistantTranscriptOwned ? { assistantTranscriptOwned: true } : {},\n\t\t\t...justDoManagedCodexTerminalRevisionReason ? { beforeAgentFinalizeRevisionReason: justDoManagedCodexTerminalRevisionReason } : {},\n\t\t\tsystemPromptReport',
    `${filePath}: return Codex terminal revision`,
  );
}

function transformCodexMirror(content, filePath) {
  const contracts = [
    'function commitJustDoManagedJoinCodexMirror(params, messages)',
    'bridge.restoreDelivery?.(params.sessionKey)',
    'params.suppressManagedJoinContinuationCommit !== true',
    'suppressManagedJoinContinuationCommit: params.suppressManagedJoinContinuationCommit === true',
  ];
  const appliedCount = contracts.filter(contract => content.includes(contract)).length;
  const prerequisiteCount = contracts
    .slice(0, 2)
    .filter(contract => content.includes(contract)).length;
  const suppressionCount = contracts.slice(2).filter(contract => content.includes(contract)).length;
  if (appliedCount === contracts.length) return content;
  if (
    (prerequisiteCount === 1 &&
      !content.includes('function commitJustDoManagedJoinCodexMirror(params, messages)')) ||
    suppressionCount > 0
  )
    throw new Error(`${filePath}: partial managed terminal handoff Codex mirror patch detected`);
  let updated = content;
  if (!updated.includes('function commitJustDoManagedJoinCodexMirror(params, messages)')) {
    const codexBridge = `const JUSTDO_MANAGED_JOIN_CODEX_GLOBAL = Symbol.for("justdo.openclaw.managed-subagent-join.v2026.7.1-2");
function commitJustDoManagedJoinCodexMirror(params, messages) {
\tconst bridge = globalThis[JUSTDO_MANAGED_JOIN_CODEX_GLOBAL];
\tif (!bridge) return;
\tfor (const message of messages) if (message.role === "toolResult") bridge.markToolResult?.(params.sessionKey, message.toolCallId);
\tconst finalAssistant = [...messages].reverse().find((message) => message.role === "assistant");
\tif (finalAssistant?.stopReason === "stop") bridge.commitContinuation?.(params.sessionKey);
}
`;
    updated = replaceUnique(
      updated,
      'async function mirrorCodexAppServerTranscript(params) {',
      `${codexBridge}async function mirrorCodexAppServerTranscript(params) {`,
      `${filePath}: managed join Codex commit prerequisite`,
    );
    updated = replaceUnique(
      updated,
      '\tfor (const update of appendedUpdates) try {',
      '\tcommitJustDoManagedJoinCodexMirror(params, messages);\n\tfor (const update of appendedUpdates) try {',
      `${filePath}: managed join Codex commit invocation prerequisite`,
    );
  }
  if (!updated.includes('bridge.restoreDelivery?.(params.sessionKey)'))
    updated = replaceUnique(
      updated,
      '\tif (finalAssistant?.stopReason === "stop") bridge.commitContinuation?.(params.sessionKey);',
      '\tif (finalAssistant?.stopReason === "stop") bridge.commitContinuation?.(params.sessionKey);\n\telse if (finalAssistant?.stopReason === "error" || finalAssistant?.stopReason === "aborted") bridge.restoreDelivery?.(params.sessionKey);',
      `${filePath}: managed join Codex recovery prerequisite`,
    );
  updated = replaceUnique(
    updated,
    '\tif (finalAssistant?.stopReason === "stop") bridge.commitContinuation?.(params.sessionKey);',
    '\tif (finalAssistant?.stopReason === "stop" && params.suppressManagedJoinContinuationCommit !== true) bridge.commitContinuation?.(params.sessionKey);',
    `${filePath}: suppress candidate Codex join commit`,
  );
  return replaceUnique(
    updated,
    'config: params.params.config\n\t\t});',
    'config: params.params.config,\n\t\t\tsuppressManagedJoinContinuationCommit: params.suppressManagedJoinContinuationCommit === true\n\t\t});',
    `${filePath}: forward Codex join commit suppression`,
  );
}

const CODEX_PLUGIN_VERSION = '2026.7.1';
const CODEX_PLUGIN_PRISTINE_HASHES = Object.freeze({
  attempt: 'ef6454d4680df156f5ec7acacca00fd55d8d19530f4d899fdaea8ba2d0775cf3',
  provider: '91856aa88de1da64db6f2344f2cddc3c0fcb677c0d06bb1be25302b4e4d319e4',
});
const CODEX_PLUGIN_PATCHED_HASHES = Object.freeze({
  attempt: '0bae897295606d5c2aed261fb3e0f4132b5d93b96bb37b0778ed0c97df03a45d',
  provider: 'aaf89d75be7f7383c2799c36ca4509e207022c7a5db9de817ab679932d947d12',
});
const CODEX_PLUGIN_PROVIDER_INTERMEDIATE_HASHES = Object.freeze([
  'dccec8ac83c250ff3f65588d6601b3dabf6852aa3c68c0e8b0bd4640b7b25385',
  '0b31aa0963329206ebffd3cb50444dd4fc252d45569630677186eb2137bd6059',
]);

function verifyJustDoCodexPluginTransforms(attempt, provider) {
  for (const contract of [
    'JUSTDO_MANAGED_CODEX_TERMINAL_HANDOFF_GLOBAL',
    'beforeAgentFinalizeRevisionReason: justDoManagedCodexTerminalRevisionReason',
    'suppressManagedJoinContinuationCommit: Boolean(justDoManagedCodexHandoffClaimed || justDoManagedCodexDurabilityError)',
    'handoffOutcome.status === "durability_error"',
  ])
    if (!attempt.includes(contract))
      throw new Error(`Codex run-attempt managed handoff contract is missing: ${contract}`);
  for (const contract of [
    'function commitJustDoManagedJoinCodexMirror(params, messages)',
    'bridge.restoreDelivery?.(params.sessionKey)',
    'params.suppressManagedJoinContinuationCommit !== true',
    'suppressManagedJoinContinuationCommit: params.suppressManagedJoinContinuationCommit === true',
  ])
    if (!provider.includes(contract))
      throw new Error(`Codex provider managed handoff contract is missing: ${contract}`);
}

function patchJustDoOfficialCodexPlugin(params) {
  if (params.pluginId !== 'codex') return { status: 'not_applicable' };
  if (
    params.packageName !== '@openclaw/codex' ||
    params.trustedOfficialInstall !== true ||
    !['global', 'config'].includes(params.origin)
  )
    throw new Error('Refusing to load an untrusted Codex runtime plugin.');
  const fsRuntime = process.getBuiltinModule('node:fs');
  const pathRuntime = process.getBuiltinModule('node:path');
  const cryptoRuntime = process.getBuiltinModule('node:crypto');
  const install = params.installRecord;
  if (
    !install ||
    install.source !== 'npm' ||
    ![install.resolvedName, install.packageName, install.spec, install.resolvedSpec].some(
      value =>
        typeof value === 'string' &&
        (value === '@openclaw/codex' || value.startsWith('@openclaw/codex@')),
    ) ||
    typeof install.installPath !== 'string' ||
    !install.installPath.trim()
  )
    throw new Error('Codex runtime plugin install provenance is missing or invalid.');
  const pluginRoot = fsRuntime.realpathSync(params.pluginRoot);
  const installedRoot = fsRuntime.realpathSync(params.resolveInstallPath(install.installPath));
  if (pluginRoot !== installedRoot)
    throw new Error('Codex runtime plugin root does not match its installed-plugin record.');
  const packagePath = pathRuntime.join(pluginRoot, 'package.json');
  const packageStat = fsRuntime.lstatSync(packagePath);
  if (!packageStat.isFile() || packageStat.isSymbolicLink() || packageStat.nlink !== 1)
    throw new Error('Unsafe Codex runtime package manifest.');
  const packageJson = JSON.parse(fsRuntime.readFileSync(packagePath, 'utf8'));
  const expectedVersion = params.expectedVersion ?? CODEX_PLUGIN_VERSION;
  if (packageJson.name !== '@openclaw/codex' || packageJson.version !== expectedVersion)
    throw new Error(
      `Unsupported Codex runtime plugin identity: ${String(packageJson.name)}@${String(packageJson.version)}.`,
    );
  for (const version of [install.version, install.resolvedVersion])
    if (typeof version === 'string' && version.trim() && version !== expectedVersion)
      throw new Error(`Codex installed-plugin record version mismatch: ${version}.`);

  const distDir = pathRuntime.join(pluginRoot, 'dist');
  const distStat = fsRuntime.lstatSync(distDir);
  const canonicalDist = fsRuntime.realpathSync(distDir);
  if (
    !distStat.isDirectory() ||
    distStat.isSymbolicLink() ||
    !canonicalDist.startsWith(`${pluginRoot}${pathRuntime.sep}`)
  )
    throw new Error('Unsafe Codex runtime dist directory.');
  const expectedPristine = params.expectedPristineHashes ?? CODEX_PLUGIN_PRISTINE_HASHES;
  const expectedPatched = params.expectedPatchedHashes ?? CODEX_PLUGIN_PATCHED_HASHES;
  const expectedProviderIntermediate =
    params.expectedProviderIntermediateHashes ?? CODEX_PLUGIN_PROVIDER_INTERMEDIATE_HASHES;
  const approvedHashesByRole = {
    attempt: new Set([expectedPristine.attempt, expectedPatched.attempt]),
    provider: new Set([
      expectedPristine.provider,
      expectedPatched.provider,
      ...expectedProviderIntermediate,
    ]),
  };
  const hash = value => cryptoRuntime.createHash('sha256').update(value).digest('hex');
  const lockPath = pathRuntime.join(pluginRoot, '.justdo-managed-codex-patch.lock');
  const deadline = Date.now() + 10_000;
  let lockFd;
  while (lockFd === undefined) {
    try {
      lockFd = fsRuntime.openSync(lockPath, 'wx', 0o600);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        const lockAgeMs =
          Date.now() - (fsRuntime.statSync(lockPath, { throwIfNoEntry: false })?.mtimeMs ?? 0);
        let ownerActive = false;
        try {
          const owner = JSON.parse(fsRuntime.readFileSync(lockPath, 'utf8'));
          if (Number.isInteger(owner?.pid) && owner.pid > 0) {
            try {
              process.kill(owner.pid, 0);
              ownerActive = true;
            } catch (ownerError) {
              ownerActive = ownerError?.code === 'EPERM';
            }
          }
        } catch {}
        if (!ownerActive || lockAgeMs > 120_000) {
          fsRuntime.rmSync(lockPath, { force: true });
          continue;
        }
      }
      if (error?.code !== 'EEXIST' || Date.now() >= deadline)
        throw new Error('Could not acquire the Codex runtime patch lock.', { cause: error });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    fsRuntime.writeFileSync(
      lockFd,
      JSON.stringify({ pid: process.pid, acquiredAtMs: Date.now() }),
      'utf8',
    );
    for (const name of fsRuntime.readdirSync(distDir)) {
      const backupMatch = /^(?<target>.+\.js)\.justdo-[^.]+\.bak$/.exec(name);
      const tempMatch = /^(?<target>.+\.js)\.justdo-[^.]+\.tmp$/.exec(name);
      if (backupMatch) {
        const backupPath = pathRuntime.join(distDir, name);
        const targetPath = pathRuntime.join(distDir, backupMatch.groups.target);
        const backupStat = fsRuntime.lstatSync(backupPath);
        const backupRealPath = fsRuntime.realpathSync(backupPath);
        if (
          !backupStat.isFile() ||
          backupStat.isSymbolicLink() ||
          backupStat.nlink !== 1 ||
          !backupRealPath.startsWith(`${canonicalDist}${pathRuntime.sep}`)
        )
          throw new Error(`Unsafe stale Codex runtime patch backup: ${name}.`);
        const backupHash = hash(fsRuntime.readFileSync(backupPath));
        const backupRole = Object.entries(approvedHashesByRole).find(([, hashes]) =>
          hashes.has(backupHash),
        )?.[0];
        if (!backupRole) throw new Error(`Unapproved stale Codex runtime patch backup: ${name}.`);
        if (!fsRuntime.existsSync(targetPath)) fsRuntime.renameSync(backupPath, targetPath);
        else {
          const targetStat = fsRuntime.lstatSync(targetPath);
          const targetRealPath = fsRuntime.realpathSync(targetPath);
          if (
            !targetStat.isFile() ||
            targetStat.isSymbolicLink() ||
            targetStat.nlink !== 1 ||
            !targetRealPath.startsWith(`${canonicalDist}${pathRuntime.sep}`)
          )
            throw new Error(
              `Unsafe stale Codex runtime patch target: ${backupMatch.groups.target}.`,
            );
          const targetHash = hash(fsRuntime.readFileSync(targetPath));
          if (approvedHashesByRole[backupRole].has(targetHash))
            fsRuntime.rmSync(backupPath, { force: true });
          else {
            fsRuntime.rmSync(targetPath, { force: true });
            fsRuntime.renameSync(backupPath, targetPath);
          }
        }
      } else if (tempMatch) fsRuntime.rmSync(pathRuntime.join(distDir, name), { force: true });
    }
    const candidates = fsRuntime
      .readdirSync(distDir)
      .filter(name => name.endsWith('.js'))
      .map(name => ({ name, filePath: pathRuntime.join(distDir, name) }))
      .map(item => {
        const fileStat = fsRuntime.lstatSync(item.filePath);
        const canonicalFile = fsRuntime.realpathSync(item.filePath);
        if (
          !fileStat.isFile() ||
          fileStat.isSymbolicLink() ||
          fileStat.nlink !== 1 ||
          !canonicalFile.startsWith(`${canonicalDist}${pathRuntime.sep}`)
        )
          throw new Error(`Unsafe Codex runtime file: ${item.name}.`);
        return { ...item, content: fsRuntime.readFileSync(item.filePath, 'utf8') };
      });
    const attemptCandidates = candidates.filter(item =>
      item.content.includes('async function runCodexAppServerAttempt(params, options) {'),
    );
    const providerCandidates = candidates.filter(
      item =>
        item.content.includes('async function mirrorTranscriptBestEffort(params) {') &&
        item.content.includes('async function mirrorCodexAppServerTranscript(params) {'),
    );
    if (attemptCandidates.length !== 1 || providerCandidates.length !== 1)
      throw new Error(
        `Codex runtime patch target count is attempt=${attemptCandidates.length}/1 provider=${providerCandidates.length}/1.`,
      );
    const attemptItem = attemptCandidates[0];
    const providerItem = providerCandidates[0];
    const originalAttemptHash = hash(attemptItem.content);
    const originalProviderHash = hash(providerItem.content);
    if (![expectedPristine.attempt, expectedPatched.attempt].includes(originalAttemptHash))
      throw new Error(`Codex run-attempt source hash is not approved: ${originalAttemptHash}.`);
    if (
      ![
        expectedPristine.provider,
        expectedPatched.provider,
        ...expectedProviderIntermediate,
      ].includes(originalProviderHash)
    )
      throw new Error(`Codex provider source hash is not approved: ${originalProviderHash}.`);
    const nextAttempt =
      originalAttemptHash === expectedPatched.attempt
        ? attemptItem.content
        : transformCodexAttempt(attemptItem.content, attemptItem.filePath);
    const nextProvider =
      originalProviderHash === expectedPatched.provider
        ? providerItem.content
        : transformCodexMirror(providerItem.content, providerItem.filePath);
    verifyJustDoCodexPluginTransforms(nextAttempt, nextProvider);
    if (
      hash(nextAttempt) !== expectedPatched.attempt ||
      hash(nextProvider) !== expectedPatched.provider
    )
      throw new Error('Codex runtime patch output hash does not match the locked contract.');
    const staged = [
      { ...attemptItem, role: 'attempt', updated: nextAttempt },
      { ...providerItem, role: 'provider', updated: nextProvider },
    ].filter(item => item.content !== item.updated);
    if (staged.length === 0) return { status: 'verified' };
    const committed = [];
    const transactionToken = cryptoRuntime.randomBytes(12).toString('hex');
    try {
      for (const item of staged) {
        const tempPath = `${item.filePath}.justdo-${transactionToken}.tmp`;
        const backupPath = `${item.filePath}.justdo-${transactionToken}.bak`;
        const mode = fsRuntime.statSync(item.filePath).mode;
        fsRuntime.writeFileSync(tempPath, item.updated, { encoding: 'utf8', flag: 'wx', mode });
        fsRuntime.renameSync(item.filePath, backupPath);
        try {
          fsRuntime.renameSync(tempPath, item.filePath);
        } catch (error) {
          fsRuntime.renameSync(backupPath, item.filePath);
          throw error;
        }
        committed.push({ ...item, backupPath });
      }
      for (const item of staged) {
        const persisted = fsRuntime.readFileSync(item.filePath, 'utf8');
        if (hash(persisted) !== expectedPatched[item.role])
          throw new Error(`Codex runtime patch verification failed for ${item.name}.`);
      }
    } catch (error) {
      const rollbackErrors = [];
      for (const item of committed.reverse()) {
        try {
          if (!fsRuntime.existsSync(item.backupPath)) {
            rollbackErrors.push(new Error(`Missing Codex runtime rollback backup: ${item.name}.`));
            continue;
          }
          fsRuntime.rmSync(item.filePath, { force: true });
          fsRuntime.renameSync(item.backupPath, item.filePath);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      for (const item of staged) {
        try {
          fsRuntime.rmSync(`${item.filePath}.justdo-${transactionToken}.tmp`, { force: true });
        } catch (cleanupError) {
          rollbackErrors.push(cleanupError);
        }
      }
      if (rollbackErrors.length > 0)
        throw new AggregateError(
          [error, ...rollbackErrors],
          'Codex runtime patch rollback failed.',
        );
      throw error;
    }
    for (const item of committed)
      try {
        fsRuntime.rmSync(item.backupPath, { force: true });
      } catch {}
    return { status: 'patched' };
  } finally {
    try {
      fsRuntime.closeSync(lockFd);
    } finally {
      fsRuntime.rmSync(lockPath, { force: true });
    }
  }
}

function buildJustDoCodexLoaderHelpers() {
  return `const MARKER = ${JSON.stringify(MARKER)};
const CODEX_PLUGIN_VERSION = ${JSON.stringify(CODEX_PLUGIN_VERSION)};
const CODEX_PLUGIN_PRISTINE_HASHES = Object.freeze(${JSON.stringify(CODEX_PLUGIN_PRISTINE_HASHES)});
const CODEX_PLUGIN_PATCHED_HASHES = Object.freeze(${JSON.stringify(CODEX_PLUGIN_PATCHED_HASHES)});
const CODEX_PLUGIN_PROVIDER_INTERMEDIATE_HASHES = Object.freeze(${JSON.stringify(CODEX_PLUGIN_PROVIDER_INTERMEDIATE_HASHES)});
const CODEX_HELPERS = ${JSON.stringify(CODEX_HELPERS)};
function replaceUnique(content, anchor, replacement, description) {
  if (!anchor) throw new Error("Cannot count an empty patch anchor");
  const count = content.split(anchor).length - 1;
  if (count !== 1) throw new Error(\`\${description} anchor count is \${count}, expected 1\`);
  return content.replace(anchor, replacement);
}
${stableFunctionSource(replaceUniquePattern)}
${stableFunctionSource(shouldAttemptJustDoCodexTerminalHandoff)}
${stableFunctionSource(resolveJustDoCodexTerminalHandoffOutcome)}
${stableFunctionSource(transformCodexAttempt)}
${stableFunctionSource(transformCodexMirror)}
${stableFunctionSource(verifyJustDoCodexPluginTransforms)}
${stableFunctionSource(patchJustDoOfficialCodexPlugin)}
`;
}

function transformPluginLoader(content, filePath) {
  const isBundle = path.basename(filePath) === 'gateway-bundle.mjs';
  const contracts = [
    'function patchJustDoOfficialCodexPlugin(params)',
    'installRecord: installRecords[pluginId]',
    'phase: "justdo-codex-runtime-patch"',
  ];
  const contractCounts = contracts.map(contract => content.split(contract).length - 1);
  if (contractCounts[0] === 1 && contractCounts[1] === 2 && contractCounts[2] === 2) return content;
  if (contractCounts.some(count => count > 0))
    throw new Error(`${filePath}: partial Codex runtime loader gate detected`);
  let updated = replaceUnique(
    content,
    'function loadOpenClawPlugins(options = {}) {',
    `${buildJustDoCodexLoaderHelpers()}function loadOpenClawPlugins(options = {}) {`,
    `${filePath}: Codex runtime loader patch helpers`,
  );
  const makeGate = (indent, names) => `${indent}try {
${indent}${names.step}patchJustDoOfficialCodexPlugin({
${indent}${names.step}${names.step}pluginId,
${indent}${names.step}${names.step}packageName: manifestRecord.packageName,
${indent}${names.step}${names.step}trustedOfficialInstall: manifestRecord.trustedOfficialInstall,
${indent}${names.step}${names.step}origin: candidate.origin,
${indent}${names.step}${names.step}pluginRoot,
${indent}${names.step}${names.step}installRecord: installRecords[pluginId],
${indent}${names.step}${names.step}resolveInstallPath: value => resolveUserPath(value, ${names.env})
${indent}${names.step}});
${indent}} catch (justDoCodexPatchError) {
${indent}${names.step}recordPluginError({
${indent}${names.step}${names.step}logger: ${names.logger},
${indent}${names.step}${names.step}registry: ${names.registry},
${indent}${names.step}${names.step}record: ${names.record},
${indent}${names.step}${names.step}seenIds,
${indent}${names.step}${names.step}pluginId,
${indent}${names.step}${names.step}origin: candidate.origin,
${indent}${names.step}${names.step}phase: "justdo-codex-runtime-patch",
${indent}${names.step}${names.step}error: justDoCodexPatchError,
${indent}${names.step}${names.step}logPrefix: \`[plugins] \${${names.record}.id} failed the managed Codex runtime gate: \`,
${indent}${names.step}${names.step}diagnosticMessagePrefix: "failed managed Codex runtime gate: "
${indent}${names.step}});
${indent}${names.step}continue;
${indent}}
`;
  const names = isBundle
    ? { step: '  ', env: 'env4', logger: 'logger5', registry: 'registry4', record: 'record3' }
    : { step: '\t', env: 'env', logger: 'logger', registry: 'registry', record: 'record' };
  const fullIndent = isBundle ? '      ' : '\t\t\t';
  const fullAnchor = `${fullIndent}const loadEntry =`;
  const gate = makeGate(fullIndent, names);
  updated = replaceUnique(
    updated,
    fullAnchor,
    `${gate}${fullAnchor}`,
    `${filePath}: full registry Codex runtime loader gate`,
  );
  const cliIndent = isBundle ? '    ' : '\t\t';
  const cliAnchor = `${cliIndent}const pluginRoot = safeRealpathOrResolve(candidate.rootDir);
${cliIndent}const cliMetadataSource = resolveCliMetadataEntrySource(candidate.rootDir);`;
  updated = replaceUnique(
    updated,
    cliAnchor,
    `${cliIndent}const pluginRoot = safeRealpathOrResolve(candidate.rootDir);
${makeGate(cliIndent, names)}${cliIndent}const cliMetadataSource = resolveCliMetadataEntrySource(candidate.rootDir);`,
    `${filePath}: CLI Codex runtime loader gate`,
  );
  return updated;
}

function transformRuntimePluginInstall(content, filePath) {
  const isBundle = path.basename(filePath) === 'gateway-bundle.mjs';
  const contract = isBundle
    ? /if \(repair\.changes\.length > 0\)[\s\S]{0,240}?clearPluginLoaderCache\d*\(\);/
    : 'if (repair.changes.length > 0) {\n\t\t\tconst { clearPluginLoaderCache } = await import("./plugins/loader.js");';
  if (isBundle ? contract.test(content) : content.includes(contract)) return content;
  if (content.includes('repair.changes.length > 0'))
    throw new Error(`${filePath}: partial runtime plugin repair cache invalidation patch detected`);
  const anchor = isBundle
    ? '    for (const warning of repair.warnings) params.runtime.log?.(`${params.descriptor.warningLabel} update warning: ${warning}`);\n    const enableResult ='
    : '\t\tfor (const warning of repair.warnings) params.runtime.log?.(`${params.descriptor.warningLabel} update warning: ${warning}`);\n\t\tconst enableResult =';
  const replacement = isBundle
    ? '    for (const warning of repair.warnings) params.runtime.log?.(`${params.descriptor.warningLabel} update warning: ${warning}`);\n    if (repair.changes.length > 0) clearPluginLoaderCache();\n    const enableResult ='
    : '\t\tfor (const warning of repair.warnings) params.runtime.log?.(`${params.descriptor.warningLabel} update warning: ${warning}`);\n\t\tif (repair.changes.length > 0) {\n\t\t\tconst { clearPluginLoaderCache } = await import("./plugins/loader.js");\n\t\t\tclearPluginLoaderCache();\n\t\t}\n\t\tconst enableResult =';
  return replaceUnique(
    content,
    anchor,
    replacement,
    `${filePath}: repaired runtime plugin cache invalidation`,
  );
}

function computeJustDoCodexTransformInputFingerprint() {
  return process
    .getBuiltinModule('node:crypto')
    .createHash('sha256')
    .update(
      [
        CODEX_HELPERS,
        stableFunctionSource(transformCodexAttempt),
        stableFunctionSource(transformCodexMirror),
      ].join('\n---JUSTDO-CODEX-TRANSFORM-INPUT---\n'),
    )
    .digest('hex');
}

const CODEX_PLUGIN_TRANSFORM_INPUT_SHA256 =
  'ae7422548835f9c62452f89bca426efd02ba9e67e3c79c90cbe1c0f60b1f3c39';

module.exports = {
  transformCodexAttempt,
  transformCodexMirror,
  verifyJustDoCodexPluginTransforms,
  patchJustDoOfficialCodexPlugin,
  transformPluginLoader,
  transformRuntimePluginInstall,
  computeJustDoCodexTransformInputFingerprint,
  CODEX_PLUGIN_TRANSFORM_INPUT_SHA256,
};
