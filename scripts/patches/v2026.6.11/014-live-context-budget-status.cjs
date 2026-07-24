'use strict';

// Purpose: Publish OpenClaw's authoritative pre-prompt context estimate to the
// session store after every model boundary so JustDo can display live context
// usage while a tool-heavy turn is still running.
// Affected OpenClaw version: v2026.6.11.
// Risk: Adds a best-effort session metadata write before each model request.
// The write is detached from the agent critical path, does not touch updatedAt
// or token freshness, and rejects stale session ids.
// Remove when: OpenClaw sessions.list or a dedicated runtime API exposes the
// current context budget status during active runs.
// Upstream tracking: TODO(openclaw): request live context budget status in the Gateway API.
// Temporary: yes.

const fs = require('fs');
const path = require('path');

const ORIGINAL_ATTEMPT_START = `async function runEmbeddedAttempt(params) {`;
const LEGACY_PATCHED_ATTEMPT_START = `async function persistJustDoLiveContextBudgetStatus(params) {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey || !params.status) return;
  const storePath = resolveStorePath2(params.config?.session?.store, {
    agentId: params.agentId
  });
  if (!storePath) return;
  try {
    await patchSessionEntry2({
      storePath,
      sessionKey
    }, (entry, context) => {
      if (!context.existingEntry) return null;
      if (params.sessionId && entry.sessionId && entry.sessionId !== params.sessionId) return null;
      return {
        contextBudgetStatus: params.status,
        totalTokensFresh: false
      };
    });
  } catch (error51) {
    log41.debug(\`[justdo-context-usage] failed to publish live context budget status: \${String(error51)}\`);
  }
}
async function runEmbeddedAttempt(params) {`;
const PATCHED_ATTEMPT_START = `async function persistJustDoLiveContextBudgetStatus(params) {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey || !params.status) return;
  const storePath = resolveStorePath2(params.config?.session?.store, {
    agentId: params.agentId
  });
  if (!storePath) return;
  try {
    await patchSessionEntry2({
      storePath,
      sessionKey
    }, (entry, context) => {
      if (!context.existingEntry) return null;
      if (params.sessionId && entry.sessionId !== params.sessionId) return null;
      return {
        contextBudgetStatus: params.status
      };
    });
  } catch (error51) {
    log41.debug(\`[justdo-context-usage] failed to publish live context budget status: \${String(error51)}\`);
  }
}
async function runEmbeddedAttempt(params) {`;
const LEGACY_PUBLISHER_SOURCE = LEGACY_PATCHED_ATTEMPT_START.slice(
  0,
  -ORIGINAL_ATTEMPT_START.length,
);
const PUBLISHER_SOURCE = PATCHED_ATTEMPT_START.slice(0, -ORIGINAL_ATTEMPT_START.length);

const ORIGINAL_MIDTURN_PUBLISH = `        log41.debug(\`[context-overflow-midturn-precheck] tool-result-guard check route=\${precheck.route} messages=\${contextMessages.length} prePromptMessageCount=\${prePromptMessageCount} estimatedPromptTokens=\${precheck.estimatedPromptTokens} promptBudgetBeforeReserve=\${precheck.promptBudgetBeforeReserve} overflowTokens=\${precheck.overflowTokens}\`);
        if (request5) {`;
const LEGACY_PATCHED_MIDTURN_PUBLISH = `        log41.debug(\`[context-overflow-midturn-precheck] tool-result-guard check route=\${precheck.route} messages=\${contextMessages.length} prePromptMessageCount=\${prePromptMessageCount} estimatedPromptTokens=\${precheck.estimatedPromptTokens} promptBudgetBeforeReserve=\${precheck.promptBudgetBeforeReserve} overflowTokens=\${precheck.overflowTokens}\`);
        await params.midTurnPrecheck.onContextBudgetStatus?.(precheck, contextMessages.length);
        if (request5) {`;
const PATCHED_MIDTURN_PUBLISH = `        log41.debug(\`[context-overflow-midturn-precheck] tool-result-guard check route=\${precheck.route} messages=\${contextMessages.length} prePromptMessageCount=\${prePromptMessageCount} estimatedPromptTokens=\${precheck.estimatedPromptTokens} promptBudgetBeforeReserve=\${precheck.promptBudgetBeforeReserve} overflowTokens=\${precheck.overflowTokens}\`);
        void params.midTurnPrecheck.onContextBudgetStatus?.(precheck, contextMessages.length);
        if (request5) {`;

const ORIGINAL_MIDTURN_OPTIONS = `        getSystemPrompt: () => systemPromptText,
        getPrePromptMessageCount: () => prePromptMessageCount,
        onMidTurnPrecheck
      } } : {};`;
const LEGACY_PATCHED_MIDTURN_OPTIONS = `        getSystemPrompt: () => systemPromptText,
        getPrePromptMessageCount: () => prePromptMessageCount,
        onMidTurnPrecheck,
        onContextBudgetStatus: async (result, messageCount) => {
          const reserveTokens = settingsManager.getCompactionReserveTokens();
          await persistJustDoLiveContextBudgetStatus({
            config: params.config,
            agentId: sessionAgentId,
            sessionKey: params.sessionKey,
            sessionId: params.sessionId,
            status: buildPrePromptContextBudgetStatus({
              result,
              provider: params.provider,
              modelId: params.modelId,
              messageCount,
              contextTokenBudget: contextTokenBudgetForGuard,
              reserveTokens,
              ...params.sessionId ? { sessionId: params.sessionId } : {}
            })
          });
        }
      } } : {};`;
const PATCHED_MIDTURN_OPTIONS = `        getSystemPrompt: () => systemPromptText,
        getPrePromptMessageCount: () => prePromptMessageCount,
        onMidTurnPrecheck,
        onContextBudgetStatus: (result, messageCount) => {
          const reserveTokens = settingsManager.getCompactionReserveTokens();
          void persistJustDoLiveContextBudgetStatus({
            config: params.config,
            agentId: sessionAgentId,
            sessionKey: params.sessionKey,
            sessionId: params.sessionId,
            status: buildPrePromptContextBudgetStatus({
              result,
              provider: params.provider,
              modelId: params.modelId,
              messageCount,
              contextTokenBudget: contextTokenBudgetForGuard,
              reserveTokens,
              ...params.sessionId ? { sessionId: params.sessionId } : {}
            })
          });
        }
      } } : {};`;

const ORIGINAL_INITIAL_PUBLISH = `              ...params.sessionId ? { sessionId: params.sessionId } : {},
              ...contextEnginePromptAuthority === "preassembly_may_overflow" && unwindowedContextEngineMessagesForPrecheck ? { unwindowedMessageCount: unwindowedContextEngineMessagesForPrecheck.length } : {}
            });
            log41.debug(formatPrePromptPrecheckLog({`;
const LEGACY_PATCHED_INITIAL_PUBLISH = `              ...params.sessionId ? { sessionId: params.sessionId } : {},
              ...contextEnginePromptAuthority === "preassembly_may_overflow" && unwindowedContextEngineMessagesForPrecheck ? { unwindowedMessageCount: unwindowedContextEngineMessagesForPrecheck.length } : {}
            });
            await persistJustDoLiveContextBudgetStatus({
              config: params.config,
              agentId: sessionAgentId,
              sessionKey: params.sessionKey,
              sessionId: params.sessionId,
              status: contextBudgetStatus
            });
            log41.debug(formatPrePromptPrecheckLog({`;
const PATCHED_INITIAL_PUBLISH = `              ...params.sessionId ? { sessionId: params.sessionId } : {},
              ...contextEnginePromptAuthority === "preassembly_may_overflow" && unwindowedContextEngineMessagesForPrecheck ? { unwindowedMessageCount: unwindowedContextEngineMessagesForPrecheck.length } : {}
            });
            void persistJustDoLiveContextBudgetStatus({
              config: params.config,
              agentId: sessionAgentId,
              sessionKey: params.sessionKey,
              sessionId: params.sessionId,
              status: contextBudgetStatus
            });
            log41.debug(formatPrePromptPrecheckLog({`;

function replaceExactlyOnce(content, original, replacement, description, filePath) {
  const firstIndex = content.indexOf(original);
  if (firstIndex === -1) {
    throw new Error(`OpenClaw ${description} patch target not found: ${filePath}`);
  }
  if (content.indexOf(original, firstIndex + original.length) !== -1) {
    throw new Error(`OpenClaw ${description} patch target is ambiguous: ${filePath}`);
  }
  return content.replace(original, replacement);
}

function countOccurrences(content, value) {
  return content.split(value).length - 1;
}

function normalizePublisher(content, filePath) {
  let normalized = content;
  let changed = false;

  if (normalized.includes(LEGACY_PUBLISHER_SOURCE)) {
    normalized = normalized.split(LEGACY_PUBLISHER_SOURCE).join(PUBLISHER_SOURCE);
    changed = true;
  }

  const publisherCount = countOccurrences(normalized, PUBLISHER_SOURCE);
  if (publisherCount === 0) {
    normalized = replaceExactlyOnce(
      normalized,
      ORIGINAL_ATTEMPT_START,
      `${PUBLISHER_SOURCE}${ORIGINAL_ATTEMPT_START}`,
      'live context publisher',
      filePath,
    );
    changed = true;
  } else if (publisherCount > 1) {
    const firstPublisherIndex = normalized.indexOf(PUBLISHER_SOURCE);
    const prefixEnd = firstPublisherIndex + PUBLISHER_SOURCE.length;
    normalized =
      normalized.slice(0, prefixEnd) + normalized.slice(prefixEnd).split(PUBLISHER_SOURCE).join('');
    changed = true;
  }

  return { content: normalized, changed };
}

function patchFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  const publisherResult = normalizePublisher(content, filePath);
  content = publisherResult.content;
  const upgrades = [
    [LEGACY_PATCHED_MIDTURN_PUBLISH, PATCHED_MIDTURN_PUBLISH, 'legacy mid-turn context publish'],
    [LEGACY_PATCHED_MIDTURN_OPTIONS, PATCHED_MIDTURN_OPTIONS, 'legacy mid-turn context callback'],
    [LEGACY_PATCHED_INITIAL_PUBLISH, PATCHED_INITIAL_PUBLISH, 'legacy initial context publish'],
  ];
  const targets = [
    [ORIGINAL_MIDTURN_PUBLISH, PATCHED_MIDTURN_PUBLISH, 'mid-turn context publish'],
    [ORIGINAL_MIDTURN_OPTIONS, PATCHED_MIDTURN_OPTIONS, 'mid-turn context callback'],
    [ORIGINAL_INITIAL_PUBLISH, PATCHED_INITIAL_PUBLISH, 'initial context publish'],
  ];

  let changed = publisherResult.changed;
  for (const [legacy, replacement, description] of upgrades) {
    if (!content.includes(legacy)) continue;
    content = replaceExactlyOnce(content, legacy, replacement, description, filePath);
    changed = true;
  }

  const alreadyPatched = targets.every(([, replacement]) => content.includes(replacement));
  if (alreadyPatched && changed) {
    fs.writeFileSync(filePath, content, 'utf8');
    return true;
  }
  if (alreadyPatched) return false;

  for (const [original, replacement, description] of targets) {
    if (content.includes(replacement)) continue;
    content = replaceExactlyOnce(content, original, replacement, description, filePath);
    changed = true;
  }
  if (changed) fs.writeFileSync(filePath, content, 'utf8');
  return changed;
}

function applyPatch(runtimeDir, options = {}) {
  const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
  const label = options.label || 'patch-openclaw-live-context-budget-status';
  if (!fs.existsSync(bundlePath)) {
    if (options.verbose) {
      console.log(`[${label}] Gateway bundle not generated yet; deferring live context patch.`);
    }
    return [];
  }

  const patched = patchFile(bundlePath) ? ['gateway-bundle.mjs'] : [];
  if (patched.length > 0) {
    console.log(`[${label}] Published live context budget status to sessions.list.`);
  } else if (options.verbose) {
    console.log(`[${label}] Live context budget status patch already applied.`);
  }
  return patched;
}

module.exports = {
  applyPatch,
  __testing: {
    ORIGINAL_ATTEMPT_START,
    LEGACY_PATCHED_ATTEMPT_START,
    PATCHED_ATTEMPT_START,
    ORIGINAL_MIDTURN_PUBLISH,
    LEGACY_PATCHED_MIDTURN_PUBLISH,
    PATCHED_MIDTURN_PUBLISH,
    ORIGINAL_MIDTURN_OPTIONS,
    LEGACY_PATCHED_MIDTURN_OPTIONS,
    PATCHED_MIDTURN_OPTIONS,
    ORIGINAL_INITIAL_PUBLISH,
    LEGACY_PATCHED_INITIAL_PUBLISH,
    PATCHED_INITIAL_PUBLISH,
  },
};
