'use strict';

// Capability: reject a managed parent terminal candidate while required child results remain unread.
// Target: patched openclaw@2026.7.1-2 after patch 041's implicit required-child join bridge.
// Scope: embedded terminal interception and same-run result-driven continuation.
// Safety: aborts, errors, retries, client tools, explicit yield and non-managed sessions keep upstream behavior.
// Remove when: upstream distinguishes model-turn completion from orchestration completion before final delivery.

const fs = require('fs');
const path = require('path');
const {
  findFilesContaining,
  replaceUnique,
  replaceUniquePattern,
  writeIfChanged,
} = require('./_patch-utils.js');

const MARKER = 'JUSTDO_REQUIRED_SUBAGENT_TERMINAL_GUARD_V2026_7_1_2';
const REVISION_PREFIX = '__JUSTDO_MANAGED_IMPLICIT_JOIN__\n';

function isJustDoSubagentCompletionDeliveryRun(inputProvenance) {
  return (
    inputProvenance?.kind === 'inter_session' &&
    inputProvenance?.sourceTool?.trim().toLowerCase() === 'subagent_announce'
  );
}

function shouldAttemptJustDoImplicitJoin(params) {
  if (!params?.hasSessionKey) return false;
  return ![
    params.alreadyRevising,
    params.willRetry,
    params.isError,
    params.incompleteTerminalAssistant,
    params.aborted,
    params.promptError,
    params.timedOut,
    params.hasCompletedClientToolCall,
    params.yieldDetected,
    params.completionDeliveryRun,
  ].some(Boolean);
}

const ATTEMPT_HELPERS = `const JUSTDO_MANAGED_IMPLICIT_JOIN_GLOBAL = Symbol.for("justdo.openclaw.managed-subagent-join.v2026.7.1-2"); // ${MARKER}
const JUSTDO_MANAGED_IMPLICIT_JOIN_REVISION_PREFIX = ${JSON.stringify(REVISION_PREFIX)};
${shouldAttemptJustDoImplicitJoin.toString()}
${isJustDoSubagentCompletionDeliveryRun.toString()}
`;

function transformAttempt(content, filePath) {
  if (content.includes('const JUSTDO_MANAGED_IMPLICIT_JOIN_GLOBAL =')) return content;
  let updated = replaceUniquePattern(
    content,
    /^(?<indent>[ \t]+)let beforeAgentFinalizeRevisionReason;$/m,
    (_match, indent) => `${ATTEMPT_HELPERS}${indent}let beforeAgentFinalizeRevisionReason;`,
    `${filePath}: required-child terminal guard helpers`,
  );
  updated = replaceUniquePattern(
    updated,
    /^(?<indent>[ \t]+)const onBeforeTerminalDelivery = hookRunner\?\.hasHooks\("before_agent_finalize"\) \? async \(event\) => \{\n[ \t]+if \(beforeAgentFinalizeRevisionReason \|\| event\.willRetry \|\| event\.isError \|\| event\.incompleteTerminalAssistant \|\| !event\.hasAssistantVisibleText\) return;$/m,
    (
      _match,
      indent,
    ) => `${indent}const hasBeforeAgentFinalizeHook = hookRunner?.hasHooks("before_agent_finalize") === true;
${indent}const hasJustDoManagedTerminalGuard = globalThis[JUSTDO_MANAGED_IMPLICIT_JOIN_GLOBAL]?.isManagedSession?.(params.sessionKey) === true;
${indent}const onBeforeTerminalDelivery = hasBeforeAgentFinalizeHook || hasJustDoManagedTerminalGuard ? async (event) => {
${indent}\tconst hasCompletedClientToolCall = clientToolCallSlots.some((slot) => slot.completed);
${indent}\tif (shouldAttemptJustDoImplicitJoin({
${indent}\t\thasSessionKey: typeof params.sessionKey === "string" && Boolean(params.sessionKey.trim()),
${indent}\t\talreadyRevising: Boolean(beforeAgentFinalizeRevisionReason),
${indent}\t\twillRetry: event.willRetry,
${indent}\t\tisError: event.isError,
${indent}\t\tincompleteTerminalAssistant: event.incompleteTerminalAssistant,
${indent}\t\taborted,
${indent}\t\tpromptError,
${indent}\t\ttimedOut,
${indent}\t\thasCompletedClientToolCall,
${indent}\t\tyieldDetected,
${indent}\t\tcompletionDeliveryRun: isJustDoSubagentCompletionDeliveryRun(params.inputProvenance)
${indent}\t})) {
${indent}\t\tconst implicitJoin = await globalThis[JUSTDO_MANAGED_IMPLICIT_JOIN_GLOBAL]?.waitForRequiredChildren?.({
${indent}\t\t\tcontrollerSessionKey: params.sessionKey,
${indent}\t\t\tsessionId: params.sessionId,
${indent}\t\t\trunId: params.runId,
${indent}\t\t\tabortSignal: runAbortController.signal
${indent}\t\t});
${indent}\t\tif (implicitJoin?.status === "joined" && typeof implicitJoin.prompt === "string" && implicitJoin.prompt) {
${indent}\t\t\tbeforeAgentFinalizeRevisionReason = JUSTDO_MANAGED_IMPLICIT_JOIN_REVISION_PREFIX + implicitJoin.prompt;
${indent}\t\t\treturn { suppressTerminalDelivery: true };
${indent}\t\t}
${indent}\t}
${indent}\tif (!hasBeforeAgentFinalizeHook || beforeAgentFinalizeRevisionReason || event.willRetry || event.isError || event.incompleteTerminalAssistant || !event.hasAssistantVisibleText) return;`,
    `${filePath}: required-child terminal wait`,
  );
  updated = replaceUniquePattern(
    updated,
    /^[ \t]+const hasCompletedClientToolCall = clientToolCallSlots\.some\(\(slot\) => slot\.completed\);\n(?=[ \t]+const silentFinalReply = params\.silentExpected)/m,
    '',
    `${filePath}: reuse terminal client-tool evidence`,
  );
  return updated;
}

function transformRunner(content, filePath) {
  const hasClassification = content.includes('const isJustDoManagedImplicitJoinRevision =');
  const hasFinalRestore = content.includes(
    'restoreImplicitDelivery?.(params.sessionKey, params.runId)',
  );
  if (hasClassification && hasFinalRestore) return content;
  if (hasClassification || hasFinalRestore)
    throw new Error(`${filePath}: partial required-child runner patch detected`);
  let updated = replaceUniquePattern(
    content,
    /(?<declaration>(?:const )?BEFORE_AGENT_FINALIZE_RETRY_PROMPT_PREFIX = "Before accepting the previous final answer, apply this revision request and produce the revised final answer\. Do not repeat completed work or rerun tools unless the request explicitly requires it\.";)/,
    `$<declaration> // ${MARKER}`,
    `${filePath}: required-child revision marker`,
  );
  updated = replaceUniquePattern(
    updated,
    /^(?<indent>[ \t]+)const beforeAgentFinalizeRevisionReason = attempt\.beforeAgentFinalizeRevisionReason;$/m,
    `$<indent>const beforeAgentFinalizeRevisionReason = attempt.beforeAgentFinalizeRevisionReason;\n$<indent>const isJustDoManagedImplicitJoinRevision = typeof beforeAgentFinalizeRevisionReason === "string" && beforeAgentFinalizeRevisionReason.startsWith(${JSON.stringify(REVISION_PREFIX)});`,
    `${filePath}: required-child revision classification`,
  );
  updated = replaceUniquePattern(
    updated,
    /const shouldHonorBeforeAgentFinalizeRevision = !(?<aborted>aborted\d*) && !promptError && !timedOut && !attempt\.clientToolCalls && !attempt\.yieldDetected && !emptyAssistantReplyIsSilent;/,
    (_match, aborted) =>
      `const shouldHonorBeforeAgentFinalizeRevision = !${aborted} && !promptError && !timedOut && !attempt.clientToolCalls && !attempt.yieldDetected && (isJustDoManagedImplicitJoinRevision || !emptyAssistantReplyIsSilent);`,
    `${filePath}: silent required-child continuation`,
  );
  updated = replaceUniquePattern(
    updated,
    /^(?<indent>[ \t]+)beforeAgentFinalizeRevisionAttempts \+= 1;\n\k<indent>nextAttemptPromptOverride = buildBeforeAgentFinalizeRetryPrompt\(beforeAgentFinalizeRevisionReason\);$/m,
    `$<indent>if (isJustDoManagedImplicitJoinRevision) nextAttemptPromptOverride = beforeAgentFinalizeRevisionReason.slice(${JSON.stringify(REVISION_PREFIX)}.length);\n$<indent>else {\n$<indent>\tbeforeAgentFinalizeRevisionAttempts += 1;\n$<indent>\tnextAttemptPromptOverride = buildBeforeAgentFinalizeRetryPrompt(beforeAgentFinalizeRevisionReason);\n$<indent>}`,
    `${filePath}: unbounded required-child continuation`,
  );
  updated = replaceUniquePattern(
    updated,
    /^(?<indent>[ \t]+)(?<logger>log[\w$]*)\.warn\(`before_agent_finalize requested one more pass: runId=\$\{params\.runId\} sessionId=\$\{params\.sessionId\} attempt=\$\{beforeAgentFinalizeRevisionAttempts\}\/\$\{MAX_BEFORE_AGENT_FINALIZE_REVISIONS\}`\);$/m,
    '$<indent>if (isJustDoManagedImplicitJoinRevision) $<logger>.info(`required subagent results resumed parent run: runId=${params.runId} sessionId=${params.sessionId}`);\n$<indent>else $<logger>.warn(`before_agent_finalize requested one more pass: runId=${params.runId} sessionId=${params.sessionId} attempt=${beforeAgentFinalizeRevisionAttempts}/${MAX_BEFORE_AGENT_FINALIZE_REVISIONS}`);',
    `${filePath}: required-child continuation log`,
  );
  return replaceUniquePattern(
    updated,
    /^(?<indent>[ \t]+)\} finally \{\n[ \t]+if \(params\.isFinalFallbackAttempt !== false\)/m,
    `$<indent>} finally {\n$<indent>\tglobalThis[Symbol.for("justdo.openclaw.managed-subagent-join.v2026.7.1-2")]?.restoreImplicitDelivery?.(params.sessionKey, params.runId);\n$<indent>\tif (params.isFinalFallbackAttempt !== false)`,
    `${filePath}: restore uncommitted implicit join on every outer exit`,
  );
}

function transformDelivery(content, filePath) {
  const contracts = [
    'JUSTDO_MANAGED_IMPLICIT_JOIN_DELIVERY_GLOBAL',
    'ownsCompletion?.(',
    'reason: "managed_join_owned"',
  ];
  const appliedCount = contracts.filter(contract => content.includes(contract)).length;
  if (appliedCount === contracts.length) return content;
  if (appliedCount > 0)
    throw new Error(`${filePath}: partial managed implicit join delivery fence detected`);
  let updated = replaceUnique(
    content,
    'async function sendSubagentAnnounceDirectly(params) {',
    `const JUSTDO_MANAGED_IMPLICIT_JOIN_DELIVERY_GLOBAL = Symbol.for("justdo.openclaw.managed-subagent-join.v2026.7.1-2"); // ${MARKER}\nasync function sendSubagentAnnounceDirectly(params) {`,
    `${filePath}: managed implicit join delivery bridge`,
  );
  updated = replaceUniquePattern(
    updated,
    /^(?<indent>[ \t]+)const isSubagentCompletion = sourceToolId === ["']subagent_announce["'];$/m,
    '$<indent>const isSubagentCompletion = sourceToolId === "subagent_announce";\n$<indent>const isJustDoManagedCompletionOwned = () => globalThis[JUSTDO_MANAGED_IMPLICIT_JOIN_DELIVERY_GLOBAL]?.ownsCompletion?.(canonicalRequesterSessionKey, params.sourceSessionKey) === true || globalThis[JUSTDO_MANAGED_IMPLICIT_JOIN_DELIVERY_GLOBAL]?.ownsCompletion?.(params.targetRequesterSessionKey, params.sourceSessionKey) === true;',
    `${filePath}: managed completion ownership probe`,
  );
  return replaceUniquePattern(
    updated,
    /^(?<indent>[ \t]+)if \(params\.expectsCompletionMessage && subagentAnnounceDeliveryDeps\.isRequesterSessionAbandoned\(canonicalRequesterSessionKey, requesterActivity\.sessionId\)\) return \{$/m,
    '$<indent>if (params.expectsCompletionMessage && isSubagentCompletion && isJustDoManagedCompletionOwned()) return {\n$<indent>\tdelivered: false,\n$<indent>\tpath: "none",\n$<indent>\treason: "managed_join_owned"\n$<indent>};\n$<indent>if (params.expectsCompletionMessage && subagentAnnounceDeliveryDeps.isRequesterSessionAbandoned(canonicalRequesterSessionKey, requesterActivity.sessionId)) return {',
    `${filePath}: post-wait managed completion ownership fence`,
  );
}

function transformAnnounce(content, filePath) {
  if (content.includes('delivery.reason === "managed_join_owned"')) return content;
  return replaceUniquePattern(
    content,
    /^(?<indent>[ \t]+)params\.onDeliveryResult\?\.\(delivery\);\n\k<indent>didAnnounce = delivery\.delivered \|\| delivery\.terminal === true;$/m,
    '$<indent>if (delivery.reason === "managed_join_owned") {\n$<indent>\tshouldDeleteChildSession = false;\n$<indent>\treturn true;\n$<indent>}\n$<indent>params.onDeliveryResult?.(delivery);\n$<indent>didAnnounce = delivery.delivered || delivery.terminal === true;',
    `${filePath}: managed completion ownership handoff`,
  );
}

function locateTargets(runtimeDir) {
  const unique = files => [...new Set(files)];
  const attempt = unique([
    ...findFilesContaining(runtimeDir, [
      'const onBeforeTerminalDelivery = hookRunner?.hasHooks("before_agent_finalize")',
      'runAgentHarnessBeforeAgentFinalizeHook({',
    ]),
    ...findFilesContaining(runtimeDir, [
      'const JUSTDO_MANAGED_IMPLICIT_JOIN_GLOBAL =',
      'waitForRequiredChildren?.({',
    ]),
  ]);
  const runner = unique([
    ...findFilesContaining(runtimeDir, [
      'const beforeAgentFinalizeRevisionReason = attempt.beforeAgentFinalizeRevisionReason;',
      'buildBeforeAgentFinalizeRetryPrompt(beforeAgentFinalizeRevisionReason)',
    ]),
    ...findFilesContaining(runtimeDir, ['isJustDoManagedImplicitJoinRevision']),
  ]);
  const delivery = unique([
    ...findFilesContaining(runtimeDir, [
      'async function sendSubagentAnnounceDirectly(params)',
      'requester session remained active while completion waited for a fresh transcript',
    ]),
    ...findFilesContaining(runtimeDir, [
      'const JUSTDO_MANAGED_IMPLICIT_JOIN_DELIVERY_GLOBAL =',
      'reason: "managed_join_owned"',
    ]),
  ]);
  const announce = unique([
    ...findFilesContaining(runtimeDir, [
      'async function runSubagentAnnounceFlow(params)',
      'params.onDeliveryResult?.(delivery);',
    ]),
    ...findFilesContaining(runtimeDir, ['delivery.reason === "managed_join_owned"']),
  ]);
  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  if (
    attempt.length !== expected ||
    runner.length !== expected ||
    delivery.length !== expected ||
    announce.length !== expected
  )
    throw new Error(
      `required-child terminal guard target counts are attempt=${attempt.length}, runner=${runner.length}, delivery=${delivery.length}, announce=${announce.length}; expected ${expected}`,
    );
  return { attempt, runner, delivery, announce };
}

function applyPatch(runtimeDir) {
  const targets = locateTargets(runtimeDir);
  const transforms = new Map();
  for (const [name, transform] of [
    ['attempt', transformAttempt],
    ['runner', transformRunner],
    ['delivery', transformDelivery],
    ['announce', transformAnnounce],
  ]) {
    for (const filePath of targets[name])
      transforms.set(filePath, [...(transforms.get(filePath) ?? []), transform]);
  }
  const staged = [];
  for (const [filePath, fileTransforms] of transforms) {
    const original = fs.readFileSync(filePath, 'utf8');
    const updated = fileTransforms.reduce(
      (value, transform) => transform(value, filePath),
      original,
    );
    staged.push({ filePath, original, updated });
  }
  return staged
    .filter(item => writeIfChanged(item.filePath, item.original, item.updated))
    .map(item => path.relative(runtimeDir, item.filePath));
}

function verifyPatch(runtimeDir) {
  const targets = locateTargets(runtimeDir);
  for (const [name, files, contracts] of [
    [
      'attempt',
      targets.attempt,
      [
        'hasBeforeAgentFinalizeHook || hasJustDoManagedTerminalGuard ? async (event) =>',
        'isManagedSession?.(params.sessionKey)',
        'waitForRequiredChildren?.({',
        'JUSTDO_MANAGED_IMPLICIT_JOIN_REVISION_PREFIX + implicitJoin.prompt',
      ],
    ],
    [
      'runner',
      targets.runner,
      [
        'isJustDoManagedImplicitJoinRevision',
        `beforeAgentFinalizeRevisionReason.slice(${JSON.stringify(REVISION_PREFIX)}.length)`,
        'isJustDoManagedImplicitJoinRevision || !emptyAssistantReplyIsSilent',
        'restoreImplicitDelivery?.(params.sessionKey, params.runId)',
      ],
    ],
    [
      'delivery',
      targets.delivery,
      [
        'ownsCompletion?.(canonicalRequesterSessionKey, params.sourceSessionKey)',
        'reason: "managed_join_owned"',
      ],
    ],
    [
      'announce',
      targets.announce,
      ['delivery.reason === "managed_join_owned"', 'shouldDeleteChildSession = false;'],
    ],
  ]) {
    for (const filePath of files) {
      const content = fs.readFileSync(filePath, 'utf8');
      for (const contract of contracts)
        if (!content.includes(contract))
          throw new Error(
            `${filePath}: required-child terminal guard ${name} contract is missing ${contract}`,
          );
    }
  }
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: {
    isJustDoSubagentCompletionDeliveryRun,
    shouldAttemptJustDoImplicitJoin,
    transformAttempt,
    transformRunner,
    transformDelivery,
    transformAnnounce,
  },
};
