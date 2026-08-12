'use strict';

// Purpose: Make safeguard compaction fail open. If the summarization model,
// credentials, or provider request is unavailable, commit a bounded local
// handoff instead of cancelling compaction and terminating the user's turn.
// Affected OpenClaw version: v2026.6.11.
// Risk: The emergency handoff is less complete than an LLM-generated summary,
// but retained user messages and a bounded recent-conversation tail preserve
// enough state to retry safely without leaving the session permanently stuck.
// Remove when: OpenClaw provides a deterministic compaction fallback and
// retries the active turn after summarization failures.
// Upstream tracking: TODO(openclaw): file issue/PR for fail-open compaction.
// Temporary: yes.

const fs = require('fs');
const path = require('path');

const PATCH_MARKER = 'JUSTDO_COMPACTION_EMERGENCY_FALLBACK';
const PATCH_REVISION_MARKER = 'JUSTDO_COMPACTION_EMERGENCY_FALLBACK_V3';
const MAX_EMERGENCY_SUMMARY_CHARS = 16_000;
const MAX_PREVIOUS_SUMMARY_CHARS = 4_000;
const MAX_RECENT_MESSAGE_CHARS = 2_000;
const MAX_RECENT_TRANSCRIPT_CHARS = 8_000;
const MAX_OPERATION_CONTEXT_CHARS = 2_500;

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
    throw new Error(`Compaction emergency fallback patch target not found (${label}): ${filePath}`);
  }
  return content.replace(from, to);
}

function replaceForMigration(content, from, to, label, filePath) {
  if (content.includes(from)) return content.replace(from, to);
  if (content.includes(to)) return content;
  throw new Error(
    `Compaction emergency fallback migration target not found (${label}): ${filePath}`,
  );
}

const ORIGINAL_FALLBACK_HELPER = `function buildStructuredFallbackSummary(previousSummary, _summarizationInstructions) {
  const trimmedPreviousSummary = previousSummary?.trim() ?? "";
  return trimmedPreviousSummary || "No prior conversation content was available to summarize.";
}`;

const PATCHED_FALLBACK_HELPER = `function buildStructuredFallbackSummary(previousSummary, _summarizationInstructions) {
  const trimmedPreviousSummary = previousSummary?.trim() ?? "";
  return trimmedPreviousSummary || "No prior conversation content was available to summarize.";
}
// ${PATCH_MARKER}
// ${PATCH_REVISION_MARKER}
function buildJustDoEmergencyCompaction(params) {
  const previousSummary = typeof params.preparation.previousSummary === "string"
    ? params.preparation.previousSummary.trim().slice(-${MAX_PREVIOUS_SUMMARY_CHARS})
    : "";
  const recentLines = [];
  let recentChars = 0;
  for (let index = params.messages.length - 1; index >= 0; index -= 1) {
    const message = params.messages[index];
    if (message?.role !== "user" && message?.role !== "assistant") continue;
    const text = extractMessageText2(message).trim();
    if (!text) continue;
    const clipped = text.length > ${MAX_RECENT_MESSAGE_CHARS}
      ? \`\${text.slice(0, ${MAX_RECENT_MESSAGE_CHARS})}...\`
      : text;
    const line = \`- \${message.role === "user" ? "User" : "Assistant"}: \${clipped}\`;
    if (recentLines.length > 0 && recentChars + line.length > ${MAX_RECENT_TRANSCRIPT_CHARS}) break;
    recentLines.unshift(line);
    recentChars += line.length;
  }
  const sections = [
    "## Emergency compaction handoff",
    "The normal summarizer was unavailable. Continue from the durable session state and the recent conversation below.",
    recentLines.length > 0 ? \`## Recent conversation\\n\${recentLines.join("\\n")}\` : "",
    previousSummary ? \`## Previous handoff\\n\${previousSummary}\` : ""
  ].filter(Boolean);
  const operationContext = [params.toolFailureSection, params.fileOpsSummary]
    .filter(Boolean)
    .join("\\n\\n")
    .slice(0, ${MAX_OPERATION_CONTEXT_CHARS});
  if (operationContext) sections.push(\`## Operational context\\n\${operationContext}\`);
  const summary = capCompactionSummary(sections.join("\\n\\n"), ${MAX_EMERGENCY_SUMMARY_CHARS});
  return { compaction: {
    summary,
    firstKeptEntryId: params.preparation.firstKeptEntryId,
    tokensBefore: params.preparation.tokensBefore,
    details: {
      readFiles: params.readFiles ?? [],
      modifiedFiles: params.modifiedFiles ?? [],
      emergencyFallback: true
    }
  } };
}`;

function replaceEmergencyHelper(content, filePath) {
  const markerStart = content.indexOf(`// ${PATCH_MARKER}`);
  const nextHelperStart = content.indexOf(
    '\nfunction appendSummarySection(summary, section) {',
    markerStart,
  );
  if (markerStart < 0 || nextHelperStart < 0) {
    throw new Error(`Compaction emergency fallback helper boundary not found: ${filePath}`);
  }
  const replacement = PATCHED_FALLBACK_HELPER.slice(ORIGINAL_FALLBACK_HELPER.length + 1);
  return `${content.slice(0, markerStart)}${replacement}${content.slice(nextHelperStart)}`;
}

const ORIGINAL_NO_MODEL = `      setCompactionSafeguardCancelReason(ctx.sessionManager, "Compaction safeguard could not resolve a summarization model.");
      return { cancel: true };`;

const PATCHED_NO_MODEL = `      log54.warn("Compaction safeguard: using the local emergency handoff because no summarization model was available.");
      return buildJustDoEmergencyCompaction({
        preparation,
        messages: [...baseMessagesToSummarize, ...turnPrefixMessages],
        readFiles,
        modifiedFiles,
        toolFailureSection,
        fileOpsSummary
      });`;

const ORIGINAL_NO_AUTH = `    if (!authResult.ok) {
      setCompactionSafeguardCancelReason(ctx.sessionManager, authResult.reason);
      return { cancel: true };
    }`;

const PATCHED_NO_AUTH = `    if (!authResult.ok) {
      log54.warn(\`Compaction safeguard: using the local emergency handoff because request credentials were unavailable: \${authResult.reason}\`);
      return buildJustDoEmergencyCompaction({
        preparation,
        messages: [...baseMessagesToSummarize, ...turnPrefixMessages],
        readFiles,
        modifiedFiles,
        toolFailureSection,
        fileOpsSummary
      });
    }`;

const ORIGINAL_SUMMARY_FAILURE = `    } catch (error51) {
      const message2 = formatErrorMessage(error51);
      log54.warn(\`Compaction summarization failed; cancelling compaction to preserve history: \${message2}\`);
      setCompactionSafeguardCancelReason(ctx.sessionManager, \`Compaction safeguard could not summarize the session: \${message2}\`);
      return { cancel: true };
    }
  });`;

const PATCHED_SUMMARY_FAILURE = `    } catch (error51) {
      const message2 = formatErrorMessage(error51);
      if (signal.aborted && isAbortError6(error51)) {
        log54.info("Compaction safeguard: user cancellation interrupted summarization.");
        return { cancel: true };
      }
      log54.warn(\`Compaction summarization failed; committing a local emergency handoff: \${message2}\`);
      return buildJustDoEmergencyCompaction({
        preparation,
        messages: [...baseMessagesToSummarize, ...turnPrefixMessages],
        readFiles,
        modifiedFiles,
        toolFailureSection,
        fileOpsSummary
      });
    }
  });`;

const ORIGINAL_PROVIDER_FAILURE = `      } catch (err3) {
        if (isAbortError6(err3) || isTimeoutError3(err3)) throw err3;
        log54.warn(\`Compaction provider path failed unexpectedly: \${err3 instanceof Error ? err3.message : String(err3)}\`);
      }
      else log54.warn(\`Compaction provider "\${providerId}" is configured but not registered. Falling back to LLM.\`);`;

const PATCHED_PROVIDER_FAILURE = `      } catch (err3) {
        if (signal.aborted && isAbortError6(err3)) return { cancel: true };
        if (isAbortError6(err3) || isTimeoutError3(err3)) {
          log54.warn(\`Compaction provider timed out; committing a local emergency handoff: \${err3 instanceof Error ? err3.message : String(err3)}\`);
          return buildJustDoEmergencyCompaction({
            preparation,
            messages: [...baseMessagesToSummarize, ...turnPrefixMessages],
            readFiles,
            modifiedFiles,
            toolFailureSection,
            fileOpsSummary
          });
        }
        log54.warn(\`Compaction provider path failed unexpectedly: \${err3 instanceof Error ? err3.message : String(err3)}\`);
      }
      else log54.warn(\`Compaction provider "\${providerId}" is configured but not registered. Falling back to LLM.\`);`;

const ORIGINAL_COMPACTION_PREFLIGHT = `        const isManual = options2.mode === "manual";
        if (!this.model) {
          if (isManual) throw new Error(formatNoModelSelectedMessage());
          return { status: "skipped" };
        }
        const auth2 = isManual ? await this.getCompactionRequestAuth(this.model) : await this.getAutoCompactionRequestAuth(this.model);
        if (!auth2) return { status: "skipped" };
        const pathEntries = this.sessionManager.getBranch();`;

const PATCHED_COMPACTION_PREFLIGHT = `        const isManual = options2.mode === "manual";
        const compactionModel = this.model;
        const auth2 = compactionModel
          ? isManual
            ? await this.getCompactionRequestAuth(compactionModel)
            : await this.getAutoCompactionRequestAuth(compactionModel)
          : void 0;
        const pathEntries = this.sessionManager.getBranch();`;

const ORIGINAL_NATIVE_COMPACTION = `        compactionResult ??= unwrapCoreResult(await compact(preparation, this.model, auth2.apiKey, auth2.headers, options2.customInstructions, options2.signal, this.thinkingLevel, this.agent.streamFn));`;

const ORIGINAL_LITELLM_NATIVE_COMPACTION = `          // JUSTDO_LITELLM_NATIVE_COMPACTION_REQUEST_METADATA
        const compactionStreamFn = createLiteLLMContextCompactionStreamFn(
          this.agent.streamFn,
          this.model.api
        );
        compactionResult ??= unwrapCoreResult(await compact(preparation, this.model, auth2.apiKey, auth2.headers, options2.customInstructions, options2.signal, this.thinkingLevel, compactionStreamFn));`;

const PATCHED_NATIVE_COMPACTION = `        if (!compactionResult) {
          if (!compactionModel) {
            if (isManual) throw new Error(formatNoModelSelectedMessage());
            return { status: "skipped" };
          }
          if (!auth2) return { status: "skipped" };
          compactionResult = unwrapCoreResult(await compact(preparation, compactionModel, auth2.apiKey, auth2.headers, options2.customInstructions, options2.signal, this.thinkingLevel, this.agent.streamFn));
        }`;

const PATCHED_LITELLM_NATIVE_COMPACTION = `        if (!compactionResult) {
          if (!compactionModel) {
            if (isManual) throw new Error(formatNoModelSelectedMessage());
            return { status: "skipped" };
          }
          if (!auth2) return { status: "skipped" };
          // JUSTDO_LITELLM_NATIVE_COMPACTION_REQUEST_METADATA
          const compactionStreamFn = createLiteLLMContextCompactionStreamFn(
            this.agent.streamFn,
            compactionModel.api
          );
          compactionResult = unwrapCoreResult(await compact(preparation, compactionModel, auth2.apiKey, auth2.headers, options2.customInstructions, options2.signal, this.thinkingLevel, compactionStreamFn));
        }`;

function replaceNativeCompaction(content, filePath, replace) {
  if (
    content.includes(PATCHED_NATIVE_COMPACTION) ||
    content.includes(PATCHED_LITELLM_NATIVE_COMPACTION)
  ) {
    return content;
  }
  if (content.includes(ORIGINAL_LITELLM_NATIVE_COMPACTION)) {
    return replace(
      content,
      ORIGINAL_LITELLM_NATIVE_COMPACTION,
      PATCHED_LITELLM_NATIVE_COMPACTION,
      'native compaction fallback with request metadata',
      filePath,
    );
  }
  return replace(
    content,
    ORIGINAL_NATIVE_COMPACTION,
    PATCHED_NATIVE_COMPACTION,
    'native compaction fallback',
    filePath,
  );
}

const ORIGINAL_OVERFLOW_GUARD = `          if (this.overflowRecoveryAttempted) {
            this.emit({
              type: "compaction_end",
              reason: "overflow",
              result: void 0,
              aborted: false,
              willRetry: false,
              errorMessage: "Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model."
            });
            return false;
          }
          this.overflowRecoveryAttempted = true;`;

const PATCHED_OVERFLOW_GUARD = `          if (this.overflowRecoveryAttempted >= 3) {
            this.emit({
              type: "compaction_end",
              reason: "overflow",
              result: void 0,
              aborted: false,
              willRetry: false,
              errorMessage: "Context remains too large after three bounded compact-and-retry attempts."
            });
            return false;
          }
          this.overflowRecoveryAttempted += 1;`;

const ORIGINAL_AUTO_COMPACTION_SETTINGS = `        const settings2 = this.settingsManager.getCompactionSettings();
        this.emit({
          type: "compaction_start",
          reason
        });`;

const PATCHED_AUTO_COMPACTION_SETTINGS = `        const baseSettings = this.settingsManager.getCompactionSettings();
        const settings2 = reason === "overflow" && this.overflowRecoveryAttempted >= 2
          ? { ...baseSettings, keepRecentTokens: 0 }
          : baseSettings;
        this.emit({
          type: "compaction_start",
          reason
        });`;

const ORIGINAL_UNRECOVERED_COPY = `  const prefix = params.preserveSessionMapping ? "\\u26A0\\uFE0F Auto-compaction could not recover this turn. I kept this conversation mapped to the current session. Please try again, use /compact, or use /new to start a fresh session." : params.duringCompaction ? "\\u26A0\\uFE0F Context limit exceeded during compaction. I've reset our conversation to start fresh - please try again." : "\\u26A0\\uFE0F Context limit exceeded. I've reset our conversation to start fresh - please try again.";`;

const PATCHED_UNRECOVERED_COPY = `  const prefix = params.preserveSessionMapping ? "\\u26A0\\uFE0F Context remains too large after bounded automatic recovery. The current session was preserved; use /new or select a larger-context model." : params.duringCompaction ? "\\u26A0\\uFE0F Context limit exceeded during compaction. I've reset our conversation to start fresh - please try again." : "\\u26A0\\uFE0F Context limit exceeded. I've reset our conversation to start fresh - please try again.";`;

const ORIGINAL_RECOVERY_HINT_RETURN = `  return prefix + ((!params.runtimeProvider || !params.runtimeModel || params.runtimeProvider === params.activeSessionEntry?.modelProvider && params.runtimeModel === params.activeSessionEntry?.model ? resolveHeartbeatBleedHint({
    cfg: params.cfg,
    agentId: params.agentId,
    primaryProvider: params.primaryProvider,
    primaryModel: params.primaryModel,
    activeSessionEntry: params.activeSessionEntry
  }) : void 0) ?? buildContextOverflowResetHint(primaryContextWindow));`;

const PATCHED_RECOVERY_HINT_RETURN = `  if (params.preserveSessionMapping) return prefix;
  return prefix + ((!params.runtimeProvider || !params.runtimeModel || params.runtimeProvider === params.activeSessionEntry?.modelProvider && params.runtimeModel === params.activeSessionEntry?.model ? resolveHeartbeatBleedHint({
    cfg: params.cfg,
    agentId: params.agentId,
    primaryProvider: params.primaryProvider,
    primaryModel: params.primaryModel,
    activeSessionEntry: params.activeSessionEntry
  }) : void 0) ?? buildContextOverflowResetHint(primaryContextWindow));`;

function patchFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  let content = fs.readFileSync(filePath, 'utf8');
  if (content.includes(PATCH_MARKER)) {
    let migrated = false;
    if (!content.includes(PATCH_REVISION_MARKER)) {
      content = replaceEmergencyHelper(content, filePath);
      content = content.replaceAll(
        'this.overflowRecoveryAttempted = false;',
        'this.overflowRecoveryAttempted = 0;',
      );
      content = replaceForMigration(
        content,
        ORIGINAL_OVERFLOW_GUARD,
        PATCHED_OVERFLOW_GUARD,
        'bounded overflow retries',
        filePath,
      );
      content = replaceForMigration(
        content,
        ORIGINAL_AUTO_COMPACTION_SETTINGS,
        PATCHED_AUTO_COMPACTION_SETTINGS,
        'aggressive overflow compaction',
        filePath,
      );
      content = replaceForMigration(
        content,
        ORIGINAL_UNRECOVERED_COPY,
        PATCHED_UNRECOVERED_COPY,
        'unrecovered user copy',
        filePath,
      );
      content = replaceForMigration(
        content,
        ORIGINAL_RECOVERY_HINT_RETURN,
        PATCHED_RECOVERY_HINT_RETURN,
        'bounded recovery hint suppression',
        filePath,
      );
      content = content.replaceAll(
        'messages: [...baseMessagesToSummarize, ...baseTurnPrefixMessages],',
        'messages: [...baseMessagesToSummarize, ...turnPrefixMessages],',
      );
      content = replaceForMigration(
        content,
        ORIGINAL_COMPACTION_PREFLIGHT,
        PATCHED_COMPACTION_PREFLIGHT,
        'compaction preflight',
        filePath,
      );
      content = replaceNativeCompaction(content, filePath, replaceForMigration);
      content = replaceForMigration(
        content,
        ORIGINAL_PROVIDER_FAILURE,
        PATCHED_PROVIDER_FAILURE,
        'provider timeout fallback',
        filePath,
      );
      fs.writeFileSync(filePath, content, 'utf8');
      migrated = true;
    }
    const required = [
      PATCH_REVISION_MARKER,
      'function buildJustDoEmergencyCompaction(params)',
      'emergencyFallback: true',
      'committing a local emergency handoff',
      'because no summarization model was available',
      'because request credentials were unavailable',
      'const compactionModel = this.model;',
      'if (!auth2) return { status: "skipped" };',
      'Compaction provider timed out; committing a local emergency handoff',
      'this.overflowRecoveryAttempted >= 3',
      'keepRecentTokens: 0',
      'Context remains too large after bounded automatic recovery',
      'if (params.preserveSessionMapping) return prefix;',
      `.slice(-${MAX_PREVIOUS_SUMMARY_CHARS})`,
      `.slice(0, ${MAX_OPERATION_CONTEXT_CHARS})`,
      'const summary = capCompactionSummary(sections.join("\\n\\n"), 16000);',
    ];
    const missing = required.filter(marker => !content.includes(marker));
    if (missing.length > 0) {
      throw new Error(`Partial compaction emergency fallback patch detected: ${filePath}`);
    }
    return migrated;
  }
  if (!content.includes(ORIGINAL_FALLBACK_HELPER) || !content.includes(ORIGINAL_SUMMARY_FAILURE)) {
    return false;
  }

  content = replaceRequired(
    content,
    ORIGINAL_FALLBACK_HELPER,
    PATCHED_FALLBACK_HELPER,
    'fallback helper',
    filePath,
  );
  content = replaceRequired(
    content,
    ORIGINAL_RECOVERY_HINT_RETURN,
    PATCHED_RECOVERY_HINT_RETURN,
    'bounded recovery hint suppression',
    filePath,
  );
  content = content.replaceAll(
    'this.overflowRecoveryAttempted = false;',
    'this.overflowRecoveryAttempted = 0;',
  );
  content = replaceRequired(
    content,
    ORIGINAL_OVERFLOW_GUARD,
    PATCHED_OVERFLOW_GUARD,
    'bounded overflow retries',
    filePath,
  );
  content = replaceRequired(
    content,
    ORIGINAL_AUTO_COMPACTION_SETTINGS,
    PATCHED_AUTO_COMPACTION_SETTINGS,
    'aggressive overflow compaction',
    filePath,
  );
  content = replaceRequired(
    content,
    ORIGINAL_UNRECOVERED_COPY,
    PATCHED_UNRECOVERED_COPY,
    'unrecovered user copy',
    filePath,
  );
  content = replaceRequired(
    content,
    ORIGINAL_PROVIDER_FAILURE,
    PATCHED_PROVIDER_FAILURE,
    'provider timeout fallback',
    filePath,
  );
  content = replaceRequired(
    content,
    ORIGINAL_COMPACTION_PREFLIGHT,
    PATCHED_COMPACTION_PREFLIGHT,
    'compaction preflight',
    filePath,
  );
  content = replaceNativeCompaction(content, filePath, replaceRequired);
  content = replaceRequired(
    content,
    ORIGINAL_NO_MODEL,
    PATCHED_NO_MODEL,
    'missing model',
    filePath,
  );
  content = replaceRequired(content, ORIGINAL_NO_AUTH, PATCHED_NO_AUTH, 'missing auth', filePath);
  content = replaceRequired(
    content,
    ORIGINAL_SUMMARY_FAILURE,
    PATCHED_SUMMARY_FAILURE,
    'summarization failure',
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
  const label = options.label || 'patch-openclaw-compaction-emergency-fallback';
  if (patched.length > 0) {
    console.log(`[${label}] Added fail-open compaction fallback: ${patched.join(', ')}`);
  } else if (options.verbose) {
    console.log(`[${label}] No compaction emergency fallback patch needed.`);
  }
  return patched;
}

function verifyPatch(runtimeDir) {
  const content = fs.readFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), 'utf8');
  const required = [
    PATCH_MARKER,
    PATCH_REVISION_MARKER,
    'function buildJustDoEmergencyCompaction(params)',
    'emergencyFallback: true',
    'committing a local emergency handoff',
    'because no summarization model was available',
    'because request credentials were unavailable',
    'const compactionModel = this.model;',
    'if (!auth2) return { status: "skipped" };',
    'Compaction provider timed out; committing a local emergency handoff',
    'this.overflowRecoveryAttempted >= 3',
    'keepRecentTokens: 0',
    'Context remains too large after bounded automatic recovery',
    'if (params.preserveSessionMapping) return prefix;',
    `.slice(-${MAX_PREVIOUS_SUMMARY_CHARS})`,
    `.slice(0, ${MAX_OPERATION_CONTEXT_CHARS})`,
    'const summary = capCompactionSummary(sections.join("\\n\\n"), 16000);',
  ];
  const missing = required.filter(marker => !content.includes(marker));
  if (missing.length > 0) {
    throw new Error(`Compaction emergency fallback patch is incomplete: ${missing.join(', ')}`);
  }
  const helperStart = content.indexOf(`// ${PATCH_MARKER}`);
  const helperEnd = content.indexOf(
    '\nfunction appendSummarySection(summary, section) {',
    helperStart,
  );
  const helper =
    helperStart >= 0 && helperEnd > helperStart ? content.slice(helperStart, helperEnd) : '';
  if (!helper || helper.includes('capCompactionSummaryPreservingSuffix')) {
    throw new Error('Compaction emergency fallback helper is stale or incomplete');
  }
  return true;
}

module.exports = {
  applyPatch,
  verifyPatch,
  MAX_EMERGENCY_SUMMARY_CHARS,
  MAX_PREVIOUS_SUMMARY_CHARS,
  MAX_RECENT_MESSAGE_CHARS,
  MAX_RECENT_TRANSCRIPT_CHARS,
  MAX_OPERATION_CONTEXT_CHARS,
};
