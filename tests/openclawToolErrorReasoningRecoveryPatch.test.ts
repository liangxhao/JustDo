import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test } from 'vitest';

const { applyPatch, MAX_RECOVERY_RETRIES, RECOVERY_USER_MESSAGE } =
  require('../scripts/patches/v2026.6.11/017-tool-error-reasoning-recovery.cjs') as {
    applyPatch: (runtimeDir: string) => string[];
    MAX_RECOVERY_RETRIES: number;
    RECOVERY_USER_MESSAGE: string;
  };

const RUNTIME_FIXTURE = `
const activeSession = {
  agent: {
    streamFn: (_model, context) => context.messages,
  },
};
function wrapStreamFnWithMessageTransform(streamFn, transform) {
  return (model, context, options) => {
    const messages = context?.messages;
    if (!Array.isArray(messages)) return streamFn(model, context, options);
    const nextMessages = transform(messages, model);
    return streamFn(model, nextMessages === messages ? context : { ...context, messages: nextMessages }, options);
  };
}
function truncateOversizedToolResultsInMessages(messages) {
  return { messages };
}
const contextTokenBudget = 0;
const promptToolResultMaxChars = 0;
const PROMPT_TOOL_RESULT_AGGREGATE_CAP_MULTIPLIER = 0;
const toolResultPromptProjectionState = {};
function resolveReasoningOnlyRetryInstruction(params) {}
function resolveIncompleteTurnPayloadText(params) {
  const toolUseTerminal = params.attempt.lastAssistant?.stopReason === "toolUse";
  const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant;
  const hasTerminalOutput = hasAttemptTerminalState(params.attempt);
  const lengthTerminal = isIncompleteTerminalAssistantTurn({});
  const thinkingOnlyTerminal = params.payloadCount !== 0 && !joinAssistantTexts(params.attempt.assistantTexts).length && !hasTerminalOutput && Boolean(assistant && hasOnlyAssistantReasoningContent(assistant));
  if (params.payloadCount !== 0 && !toolUseTerminal && !lengthTerminal && !thinkingOnlyTerminal || params.aborted && params.externalAbort || params.timedOut || params.attempt.clientToolCalls || params.attempt.yieldDetected || params.attempt.didSendDeterministicApprovalPrompt || params.attempt.lastToolError) return null;
}
async function runEmbeddedAttempt(params) {
  const installProviderPromptHistoryTransform = () => {
    const baseStreamFn = activeSession.agent.streamFn;
              const providerPromptStreamFn = wrapStreamFnWithMessageTransform(baseStreamFn, (messages) => {
                const providerPromptHistoryTruncation = truncateOversizedToolResultsInMessages(messages, contextTokenBudget, promptToolResultMaxChars, promptToolResultMaxChars * PROMPT_TOOL_RESULT_AGGREGATE_CAP_MULTIPLIER, toolResultPromptProjectionState);
                return providerPromptHistoryTruncation.messages !== messages ? providerPromptHistoryTruncation.messages : messages;
              });
    return providerPromptStreamFn;
  };
  return installProviderPromptHistoryTransform();
}
async function runEmbeddedAgent(params) {
      const maxReasoningOnlyRetryAttempts = 2;
      const maxEmptyResponseRetryAttempts = 1;
      let reasoningOnlyRetryAttempts = 0;
      let emptyResponseRetryAttempts = 0;
      while (false) {
      const rawAttempt = await runEmbeddedAttemptWithBackend({
            prompt,
            transcriptPrompt: params.transcriptPrompt,
      });
          const nextReasoningOnlyRetryInstruction = emptyAssistantReplyIsSilent ? null : resolveReasoningOnlyRetryInstruction({
            provider: activeErrorContext.provider,
            modelId: activeErrorContext.model,
            modelApi: effectiveModel.api,
            executionContract,
            aborted: aborted3,
            timedOut,
            attempt
          });
      }
}
export { runEmbeddedAttempt };
`;

test('adds bounded one-shot request-only recovery messages without changing the persisted prompt', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-tool-error-recovery-'));
  try {
    const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    fs.writeFileSync(bundlePath, RUNTIME_FIXTURE);

    expect(applyPatch(runtimeDir)).toEqual(['gateway-bundle.mjs']);
    const patched = fs.readFileSync(bundlePath, 'utf8');

    expect(MAX_RECOVERY_RETRIES).toBe(2);
    expect(RECOVERY_USER_MESSAGE).toBe(
      'Immediately fix the previous tool error. Your next response must call a tool. Do not only describe the plan, and do not output a final summary.',
    );
    expect(patched).toContain(
      'temporaryToolErrorRecoveryUserMessageCount: toolErrorReasoningRecoveryAttempts',
    );
    expect(patched).toContain('pendingToolErrorRecoveryUserMessageCount = 0');
    expect(patched).toContain(
      'Array.from({ length: recoveryMessageCount }, () => ({\n' +
        '                  role: "user",\n' +
        '                  content: JUSTDO_TOOL_ERROR_REASONING_RECOVERY_MESSAGE,',
    );
    expect(patched).toContain('suppressNextUserMessagePersistence = true');
    expect(patched).not.toContain(`${RECOVERY_USER_MESSAGE}\n\n`);
    expect(patched).toContain(
      'const thinkingOnlyTerminal = !joinAssistantTexts(params.attempt.assistantTexts).length',
    );
    expect(patched).toContain(
      '(!emptyAssistantReplyIsSilent || toolErrorReasoningRecoveryAttempts > 0)',
    );

    const runtime = (await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`)) as {
      runEmbeddedAttempt: (params: {
        temporaryToolErrorRecoveryUserMessageCount: number;
      }) => Promise<
        (model: unknown, context: { messages: unknown[] }, options?: unknown) => unknown[]
      >;
    };
    const streamFn = await runtime.runEmbeddedAttempt({
      temporaryToolErrorRecoveryUserMessageCount: MAX_RECOVERY_RETRIES,
    });
    const transcriptMessages = [{ role: 'user', content: 'original prompt' }];
    const firstDispatch = streamFn({}, { messages: transcriptMessages });
    const secondDispatch = streamFn({}, { messages: transcriptMessages });

    expect(firstDispatch).toHaveLength(1 + MAX_RECOVERY_RETRIES);
    expect(firstDispatch.slice(1)).toEqual(
      Array.from({ length: MAX_RECOVERY_RETRIES }, () =>
        expect.objectContaining({
          role: 'user',
          content: RECOVERY_USER_MESSAGE,
        }),
      ),
    );
    expect(secondDispatch).toBe(transcriptMessages);
    expect(transcriptMessages).toEqual([{ role: 'user', content: 'original prompt' }]);
    expect(applyPatch(runtimeDir)).toEqual([]);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('fails closed when a supported bundle is missing a required injection target', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-tool-error-recovery-broken-'));
  try {
    fs.writeFileSync(
      path.join(runtimeDir, 'gateway-bundle.mjs'),
      'function resolveReasoningOnlyRetryInstruction(params) {}\n' +
        'const rawAttempt = await runEmbeddedAttemptWithBackend({});\n',
    );

    expect(() => applyPatch(runtimeDir)).toThrow(
      /tool-error reasoning recovery patch target not found \(constants\)/i,
    );
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('rejects a partially patched bundle instead of silently accepting it', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-tool-error-recovery-partial-'));
  try {
    fs.writeFileSync(
      path.join(runtimeDir, 'gateway-bundle.mjs'),
      'const JUSTDO_TOOL_ERROR_REASONING_RECOVERY_MESSAGE = "partial";\n',
    );

    expect(() => applyPatch(runtimeDir)).toThrow(
      /partial tool-error reasoning recovery patch detected/i,
    );
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});
