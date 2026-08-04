'use strict';

// Purpose: Retry reasoning-only turns that follow a tool error with request-only
// user recovery messages. Retry n receives n identical messages so each provider
// request differs, while the recovery text never enters the session transcript.
// Affected OpenClaw version: v2026.6.11.
// Risk: A model may retry work after a failed side-effecting tool call. The retry
// count is deliberately bounded and exhausted runs surface the existing
// incomplete-turn warning.
// Remove when: OpenClaw supports bounded, request-only recovery messages for
// reasoning-only post-tool-error turns.
// Upstream tracking: TODO(openclaw): file issue/PR with a reasoning-only turn
// after a Windows tool encoding failure.
// Temporary: yes.

const fs = require('fs');
const path = require('path');

const RECOVERY_USER_MESSAGE =
  'Immediately fix the previous tool error. Your next response must call a tool. Do not only describe the plan, and do not output a final summary.';
const MAX_RECOVERY_RETRIES = 2;
const PATCH_MARKER = 'JUSTDO_TOOL_ERROR_REASONING_RECOVERY_MESSAGE';

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

function replaceRequired(content, from, to, label, filePath) {
  if (!content.includes(from)) {
    throw new Error(`Tool-error reasoning recovery patch target not found (${label}): ${filePath}`);
  }
  return content.replace(from, to);
}

function patchFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  let content = fs.readFileSync(filePath, 'utf8');
  if (content.includes(PATCH_MARKER)) {
    const complete =
      content.includes(
        'temporaryToolErrorRecoveryUserMessageCount: toolErrorReasoningRecoveryAttempts',
      ) &&
      content.includes('pendingToolErrorRecoveryUserMessageCount') &&
      content.includes('toolErrorReasoningRecoveryCandidate') &&
      content.includes('request-only recovery user message(s)') &&
      content.includes(
        'const thinkingOnlyTerminal = !joinAssistantTexts(params.attempt.assistantTexts).length',
      );
    if (!complete) {
      throw new Error(`Partial tool-error reasoning recovery patch detected: ${filePath}`);
    }
    return false;
  }
  if (
    !content.includes('function resolveReasoningOnlyRetryInstruction(params)') ||
    !content.includes('const rawAttempt = await runEmbeddedAttemptWithBackend({')
  ) {
    return false;
  }

  content = replaceRequired(
    content,
    '      const maxReasoningOnlyRetryAttempts = 2;\n      const maxEmptyResponseRetryAttempts = 1;',
    `      const maxReasoningOnlyRetryAttempts = 2;
      const maxEmptyResponseRetryAttempts = 1;
      const MAX_TOOL_ERROR_REASONING_RECOVERY_RETRIES = ${MAX_RECOVERY_RETRIES};`,
    'constants',
    filePath,
  );

  content = replaceRequired(
    content,
    'async function runEmbeddedAttempt(params) {',
    `const ${PATCH_MARKER} = ${JSON.stringify(RECOVERY_USER_MESSAGE)};
async function runEmbeddedAttempt(params) {`,
    'request-only recovery message',
    filePath,
  );

  content = replaceRequired(
    content,
    '      let reasoningOnlyRetryAttempts = 0;\n      let emptyResponseRetryAttempts = 0;',
    `      let reasoningOnlyRetryAttempts = 0;
      let toolErrorReasoningRecoveryAttempts = 0;
      let emptyResponseRetryAttempts = 0;`,
    'retry counter',
    filePath,
  );

  content = replaceRequired(
    content,
    '            prompt,\n            transcriptPrompt: params.transcriptPrompt,',
    `            prompt,
            temporaryToolErrorRecoveryUserMessageCount: toolErrorReasoningRecoveryAttempts,
            transcriptPrompt: params.transcriptPrompt,`,
    'attempt parameter',
    filePath,
  );

  content = replaceRequired(
    content,
    `              const providerPromptStreamFn = wrapStreamFnWithMessageTransform(baseStreamFn, (messages) => {
                const providerPromptHistoryTruncation = truncateOversizedToolResultsInMessages(messages, contextTokenBudget, promptToolResultMaxChars, promptToolResultMaxChars * PROMPT_TOOL_RESULT_AGGREGATE_CAP_MULTIPLIER, toolResultPromptProjectionState);
                return providerPromptHistoryTruncation.messages !== messages ? providerPromptHistoryTruncation.messages : messages;
              });`,
    `              let pendingToolErrorRecoveryUserMessageCount = Number.isInteger(params.temporaryToolErrorRecoveryUserMessageCount) ? Math.max(0, Math.min(params.temporaryToolErrorRecoveryUserMessageCount, ${MAX_RECOVERY_RETRIES})) : 0;
              const providerPromptStreamFn = wrapStreamFnWithMessageTransform(baseStreamFn, (messages) => {
                const providerPromptHistoryTruncation = truncateOversizedToolResultsInMessages(messages, contextTokenBudget, promptToolResultMaxChars, promptToolResultMaxChars * PROMPT_TOOL_RESULT_AGGREGATE_CAP_MULTIPLIER, toolResultPromptProjectionState);
                const providerMessages = providerPromptHistoryTruncation.messages !== messages ? providerPromptHistoryTruncation.messages : messages;
                const recoveryMessageCount = pendingToolErrorRecoveryUserMessageCount;
                pendingToolErrorRecoveryUserMessageCount = 0;
                if (recoveryMessageCount === 0) return providerMessages;
                const recoveryTimestamp = Date.now();
                return [...providerMessages, ...Array.from({ length: recoveryMessageCount }, () => ({
                  role: "user",
                  content: ${PATCH_MARKER},
                  timestamp: recoveryTimestamp
                }))];
              });`,
    'provider request transform',
    filePath,
  );

  content = replaceRequired(
    content,
    `          const nextReasoningOnlyRetryInstruction = emptyAssistantReplyIsSilent ? null : resolveReasoningOnlyRetryInstruction({
            provider: activeErrorContext.provider,
            modelId: activeErrorContext.model,
            modelApi: effectiveModel.api,
            executionContract,
            aborted: aborted3,
            timedOut,
            attempt
          });`,
    `          const toolErrorRecoveryAssistant = attempt.currentAttemptAssistant ?? attempt.lastAssistant;
          const toolErrorReasoningRecoveryCandidate = (!emptyAssistantReplyIsSilent || toolErrorReasoningRecoveryAttempts > 0) && !aborted3 && !timedOut && !attempt.clientToolCalls && !attempt.yieldDetected && !attempt.didSendDeterministicApprovalPrompt && !hasCommittedMessagingToolDeliveryEvidence(attempt) && !hasAcceptedSessionSpawn(attempt.acceptedSessionSpawns) && !hasAsyncStartedToolActivity$1(attempt.toolMetas) && (attempt.lastToolError || toolErrorReasoningRecoveryAttempts > 0) && joinAssistantTexts(attempt.assistantTexts).length === 0 && toolErrorRecoveryAssistant?.stopReason !== "error" && Boolean(toolErrorRecoveryAssistant && hasOnlyAssistantReasoningContent(toolErrorRecoveryAssistant));
          if (toolErrorReasoningRecoveryCandidate && toolErrorReasoningRecoveryAttempts < MAX_TOOL_ERROR_REASONING_RECOVERY_RETRIES) {
            toolErrorReasoningRecoveryAttempts += 1;
            reasoningOnlyRetryInstruction = null;
            emptyResponseRetryInstruction = null;
            suppressNextUserMessagePersistence = true;
            log41.warn(\`reasoning-only assistant turn after tool error: runId=\${params.runId} sessionId=\${params.sessionId} provider=\${activeErrorContext.provider}/\${activeErrorContext.model} — retrying \${toolErrorReasoningRecoveryAttempts}/\${MAX_TOOL_ERROR_REASONING_RECOVERY_RETRIES} with \${toolErrorReasoningRecoveryAttempts} request-only recovery user message(s)\`);
            continue;
          }
          const nextReasoningOnlyRetryInstruction = emptyAssistantReplyIsSilent || toolErrorReasoningRecoveryAttempts > 0 ? null : resolveReasoningOnlyRetryInstruction({
            provider: activeErrorContext.provider,
            modelId: activeErrorContext.model,
            modelApi: effectiveModel.api,
            executionContract,
            aborted: aborted3,
            timedOut,
            attempt
          });`,
    'bounded recovery retry',
    filePath,
  );

  content = replaceRequired(
    content,
    `  const thinkingOnlyTerminal = params.payloadCount !== 0 && !joinAssistantTexts(params.attempt.assistantTexts).length && !hasTerminalOutput && Boolean(assistant && hasOnlyAssistantReasoningContent(assistant));
  if (params.payloadCount !== 0 && !toolUseTerminal && !lengthTerminal && !thinkingOnlyTerminal || params.aborted && params.externalAbort || params.timedOut || params.attempt.clientToolCalls || params.attempt.yieldDetected || params.attempt.didSendDeterministicApprovalPrompt || params.attempt.lastToolError) return null;`,
    `  const thinkingOnlyTerminal = !joinAssistantTexts(params.attempt.assistantTexts).length && Boolean(assistant && hasOnlyAssistantReasoningContent(assistant));
  if (params.payloadCount !== 0 && !toolUseTerminal && !lengthTerminal && !thinkingOnlyTerminal || params.aborted && params.externalAbort || params.timedOut || params.attempt.clientToolCalls || params.attempt.yieldDetected || params.attempt.didSendDeterministicApprovalPrompt || params.attempt.lastToolError && !thinkingOnlyTerminal) return null;`,
    'exhausted recovery fallback',
    filePath,
  );

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

  const label = options.label || 'patch-openclaw-tool-error-reasoning-recovery';
  if (patched.length > 0) {
    console.log(`[${label}] Patched tool-error reasoning recovery: ${patched.join(', ')}`);
  } else if (options.verbose) {
    console.log(`[${label}] No tool-error reasoning recovery patch needed.`);
  }

  return patched;
}

function verifyPatch(runtimeDir) {
  const content = fs.readFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), 'utf8');
  const required = [
    PATCH_MARKER,
    'const MAX_TOOL_ERROR_REASONING_RECOVERY_RETRIES = 2;',
    'temporaryToolErrorRecoveryUserMessageCount: toolErrorReasoningRecoveryAttempts',
    'pendingToolErrorRecoveryUserMessageCount',
    'toolErrorReasoningRecoveryCandidate',
    'request-only recovery user message(s)',
    'const thinkingOnlyTerminal = !joinAssistantTexts(params.attempt.assistantTexts).length',
  ];
  const missing = required.filter(marker => !content.includes(marker));
  if (missing.length > 0) throw new Error(`Tool-error reasoning recovery patch is incomplete: ${missing.join(', ')}`);
  return true;
}

module.exports = {
  applyPatch,
  verifyPatch,
  MAX_RECOVERY_RETRIES,
  RECOVERY_USER_MESSAGE,
};
