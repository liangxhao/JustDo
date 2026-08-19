'use strict';

// Capability: deterministic fail-open handoffs for safeguard and native compaction failures.
// Target: pristine openclaw@2026.7.1-2, whose model/auth/provider/native failures cancel.
// Scope: non-Codex handoffs contain prior summary, the explicit retained-user details contract,
// and a bounded recent transcript tail; missing-model/auth/provider/timeout/staged/native
// failures continue while Codex-local failures preserve history and cancel without committing.
// Safety: summaries are deterministic and <= the upstream 16k limit, existing details/file
// operations survive, and no helper/marker from patch 029 or patch ordering is required.
// Remove when: both compaction paths natively commit equivalent fallbacks without stale state.

const fs = require('fs');
const path = require('path');
const { findFilesContaining, replaceUniquePattern, writeIfChanged } = require('./_patch-utils.js');
const SAFEGUARD_HELPER = 'commitJustDoEmergencyCompaction';
const NATIVE_HELPER = 'buildJustDoNativeEmergencyCompaction';

function transformSafeguard(content, filePath) {
  if (content.includes(`function ${SAFEGUARD_HELPER}(`)) {
    for (const contract of [
      'readJustDoEmergencyRetainedArchive(preparation)',
      'buildJustDoEmergencyHandoffSummary(preparation, messages, reason)',
      'justdoRetainedUserMessages: retainedArchive',
      'MAX_COMPACTION_SUMMARY_CHARS',
    ]) {
      if (!content.includes(contract)) {
        throw new Error(`${filePath}: partial safeguard emergency handoff (${contract})`);
      }
    }
    return content;
  }
  let out = replaceUniquePattern(
    content,
    /function compactionSafeguardExtension/,
    `const JUSTDO_EMERGENCY_PREVIOUS_CHARS = 4500;
const JUSTDO_EMERGENCY_RETAINED_CHARS = 5000;
const JUSTDO_EMERGENCY_RECENT_CHARS = 5500;
function sliceJustDoEmergencyTail(value, maxChars) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length <= maxChars) return text;
  let result = text.slice(-maxChars);
  if (result && /[\\uDC00-\\uDFFF]/.test(result[0])) result = result.slice(1);
  return "[...older content omitted...]\\n" + result;
}
function readJustDoEmergencyRetainedArchive(preparation) {
  const archive = preparation?.justDoRetainedUserMessages ?? preparation?.details?.justdoRetainedUserMessages;
  if (!archive || typeof archive !== "object" || !Array.isArray(archive.messages)) return void 0;
  const messages = archive.messages.filter((record) => record && typeof record === "object" && typeof record.text === "string" && record.text.trim()).map((record) => ({
    ...typeof record.sourceEntryId === "string" ? { sourceEntryId: record.sourceEntryId } : {},
    ...Number.isFinite(record.timestamp) ? { timestamp: record.timestamp } : {},
    text: record.text
  }));
  if (messages.length === 0) return void 0;
  return { ...archive, messages };
}
function renderJustDoEmergencyRetainedUsers(archive) {
  if (!archive) return "No retained user archive was available.";
  return sliceJustDoEmergencyTail(archive.messages.map((record) => record.text).join("\\n\\n"), JUSTDO_EMERGENCY_RETAINED_CHARS);
}
function renderJustDoEmergencyMessage(message) {
  const role = typeof message?.role === "string" ? message.role : "unknown";
  const text = extractMessageText(message).trim();
  return text ? role + ": " + text : "";
}
function buildJustDoEmergencyHandoffSummary(preparation, messages, reason) {
  const previous = sliceJustDoEmergencyTail(preparation.previousSummary, JUSTDO_EMERGENCY_PREVIOUS_CHARS) || "No prior summary was available.";
  const retained = renderJustDoEmergencyRetainedUsers(readJustDoEmergencyRetainedArchive(preparation));
  const recent = sliceJustDoEmergencyTail(messages.slice(-24).map(renderJustDoEmergencyMessage).filter(Boolean).join("\\n\\n"), JUSTDO_EMERGENCY_RECENT_CHARS) || "No recent conversation tail was available.";
  const boundedReason = truncateFailureText(normalizeFailureText(reason || "local summarization unavailable"), MAX_TOOL_FAILURE_CHARS);
  return capCompactionSummary([
    "# Emergency Compaction Handoff",
    "## Previous summary", previous,
    "## Retained user messages", retained,
    "## Recent conversation tail", recent,
    "## Recovery note", "Local model handoff used after compaction failure: " + boundedReason
  ].join("\\n\\n"), MAX_COMPACTION_SUMMARY_CHARS);
}
function buildJustDoEmergencyCompaction(preparation, messages, reason) {
  const retainedArchive = readJustDoEmergencyRetainedArchive(preparation);
  const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
  return { compaction: {
    summary: buildJustDoEmergencyHandoffSummary(preparation, messages, reason),
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    details: {
      ...(preparation.details && typeof preparation.details === "object" ? preparation.details : {}),
      readFiles,
      modifiedFiles,
      emergencyHandoff: true,
      ...(retainedArchive ? { justdoRetainedUserMessages: retainedArchive } : {})
    }
  } };
}
function ${SAFEGUARD_HELPER}(sessionManager, preparation, messages, reason) {
  if (preparation?.justDoCodexLocal === true) {
    const message = truncateFailureText(normalizeFailureText(reason || "local summarization unavailable"), MAX_TOOL_FAILURE_CHARS);
    setCompactionSafeguardCancelReason(sessionManager, "Codex-local compaction failed without replacing history: " + message);
    return { cancel: true };
  }
  const fallback = buildJustDoEmergencyCompaction(preparation, messages, reason);
  setCompactionSafeguardCancelReason(sessionManager, void 0);
  return fallback;
}
function compactionSafeguardExtension`,
    `${filePath}: safeguard helpers`,
  );
  out = replaceUniquePattern(
    out,
    /setCompactionSafeguardCancelReason\(\s*ctx\.sessionManager,\s*"Compaction safeguard could not resolve a summarization model\."\s*\);\s*return \{ cancel: true \};/,
    'if (signal?.aborted) return { cancel: true };\n\t\t\treturn commitJustDoEmergencyCompaction(ctx.sessionManager, preparation, [...baseMessagesToSummarize, ...baseTurnPrefixMessages], "summarization model unavailable");',
    `${filePath}: missing model`,
  );
  out = replaceUniquePattern(
    out,
    /(if \(!authResult\.ok\) \{[\s\S]*?)setCompactionSafeguardCancelReason\(ctx\.sessionManager, authResult\.reason\);\s*return \{ cancel: true \};/,
    '$1if (signal?.aborted) return { cancel: true };\n\t\t\treturn commitJustDoEmergencyCompaction(ctx.sessionManager, preparation, [...baseMessagesToSummarize, ...baseTurnPrefixMessages], authResult.reason);',
    `${filePath}: auth`,
  );
  out = replaceUniquePattern(
    out,
    /\} catch \(err\) \{\s*if \(signal\?\.aborted\) throw err;\s*if \(!isAbortError\(err\) && isTimeoutError\(err\)\) throw err;\s*log\.warn\(`Compaction provider path failed unexpectedly: \$\{err instanceof Error \? err\.message : String\(err\)\}`\);\s*\}/,
    `} catch (err) {
        if (signal?.aborted || isAbortError(err)) throw err;
        log.warn(\`Compaction provider path failed; committing local handoff: \${err instanceof Error ? err.message : String(err)}\`);
        return ${SAFEGUARD_HELPER}(ctx.sessionManager, preparation, [...baseMessagesToSummarize, ...baseTurnPrefixMessages], err);
      }`,
    `${filePath}: configured provider timeout`,
  );
  out = replaceUniquePattern(
    out,
    /log\w*\.warn\(`Compaction summarization failed; cancelling compaction to preserve history: \$\{(\w+)\}`\);\s*setCompactionSafeguardCancelReason\([\s\S]{0,400}?\);\s*return \{ cancel: true \};/,
    (_m, msg) => `if (signal?.aborted || isAbortError(error)) return { cancel: true };
      log.warn(\`Compaction summarization failed; committing local handoff: \${${msg}}\`);
      return commitJustDoEmergencyCompaction(ctx.sessionManager, preparation, [...baseMessagesToSummarize, ...baseTurnPrefixMessages], ${msg});`,
    `${filePath}: provider failure`,
  );
  return out;
}

function transformNative(content, filePath) {
  if (content.includes(`function ${NATIVE_HELPER}(`)) {
    for (const contract of [
      'readJustDoNativeEmergencyRetainedArchive(preparation)',
      'renderJustDoNativeEmergencyMessages(recentMessages)',
      'justdoRetainedUserMessages: retainedArchive',
      'JUSTDO_NATIVE_EMERGENCY_MAX_CHARS = 16e3',
    ]) {
      if (!content.includes(contract)) {
        throw new Error(`${filePath}: partial native emergency handoff (${contract})`);
      }
    }
    return content;
  }
  let out = replaceUniquePattern(
    content,
    /\/\*\* Generate compaction summary data from prepared session history\. \*\//,
    `const JUSTDO_NATIVE_EMERGENCY_MAX_CHARS = 16e3;
const JUSTDO_NATIVE_EMERGENCY_PREVIOUS_CHARS = 4500;
const JUSTDO_NATIVE_EMERGENCY_RETAINED_CHARS = 5000;
const JUSTDO_NATIVE_EMERGENCY_RECENT_CHARS = 5500;
function sliceJustDoNativeEmergencyTail(value, maxChars) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length <= maxChars) return text;
  let result = text.slice(-maxChars);
  if (result && /[\\uDC00-\\uDFFF]/.test(result[0])) result = result.slice(1);
  return "[...older content omitted...]\\n" + result;
}
function readJustDoNativeEmergencyRetainedArchive(preparation) {
  const archive = preparation?.justDoRetainedUserMessages ?? preparation?.details?.justdoRetainedUserMessages;
  if (!archive || typeof archive !== "object" || !Array.isArray(archive.messages)) return void 0;
  const messages = archive.messages.filter((record) => record && typeof record === "object" && typeof record.text === "string" && record.text.trim()).map((record) => ({
    ...typeof record.sourceEntryId === "string" ? { sourceEntryId: record.sourceEntryId } : {},
    ...Number.isFinite(record.timestamp) ? { timestamp: record.timestamp } : {},
    text: record.text
  }));
  if (messages.length === 0) return void 0;
  return { ...archive, messages };
}
function readJustDoNativeEmergencyMessageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content.filter((block) => block && typeof block === "object" && typeof block.text === "string").map((block) => block.text).join("\\n");
}
function renderJustDoNativeEmergencyMessages(messages) {
  if (!Array.isArray(messages)) return "";
  return messages.slice(-24).map((message) => {
    const text = readJustDoNativeEmergencyMessageText(message).trim();
    return text ? (typeof message?.role === "string" ? message.role : "unknown") + ": " + text : "";
  }).filter(Boolean).join("\\n\\n");
}
function buildJustDoNativeEmergencySummary(preparation, retainedArchive, reason) {
  const previous = sliceJustDoNativeEmergencyTail(preparation.previousSummary, JUSTDO_NATIVE_EMERGENCY_PREVIOUS_CHARS) || "No prior summary was available.";
  const retained = sliceJustDoNativeEmergencyTail(retainedArchive?.messages?.map((record) => record.text).join("\\n\\n"), JUSTDO_NATIVE_EMERGENCY_RETAINED_CHARS) || "No retained user archive was available.";
  const recentMessages = [...(preparation.messagesToSummarize ?? []), ...(preparation.turnPrefixMessages ?? [])];
  const recent = sliceJustDoNativeEmergencyTail(renderJustDoNativeEmergencyMessages(recentMessages), JUSTDO_NATIVE_EMERGENCY_RECENT_CHARS) || "No recent conversation tail was available.";
  const failure = sliceJustDoNativeEmergencyTail(String(reason?.message || reason || "unknown"), 240);
  const summary = [
    "# Emergency Compaction Handoff",
    "## Previous summary", previous,
    "## Retained user messages", retained,
    "## Recent conversation tail", recent,
    "## Recovery note", "Local model handoff used after compaction failure: " + failure
  ].join("\\n\\n");
  if (summary.length <= JUSTDO_NATIVE_EMERGENCY_MAX_CHARS) return summary;
  let bounded = summary.slice(0, JUSTDO_NATIVE_EMERGENCY_MAX_CHARS);
  if (bounded && /[\\uD800-\\uDBFF]/.test(bounded.at(-1))) bounded = bounded.slice(0, -1);
  return bounded;
}
function ${NATIVE_HELPER}(preparation, reason) {
  const retainedArchive = readJustDoNativeEmergencyRetainedArchive(preparation);
  const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
  return {
    summary: buildJustDoNativeEmergencySummary(preparation, retainedArchive, reason),
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    details: {
      ...(preparation.details && typeof preparation.details === "object" ? preparation.details : {}),
      readFiles,
      modifiedFiles,
      emergencyHandoff: true,
      nativeCompactionFailure: sliceJustDoNativeEmergencyTail(String(reason?.message || reason || "unknown"), 240),
      ...(retainedArchive ? { justdoRetainedUserMessages: retainedArchive } : {})
    }
  };
}
function recoverJustDoNativeCompaction(preparation, signal, failure) {
  if (preparation?.justDoCodexLocal === true || signal?.aborted || failure?.name === "AbortError" || failure?.code === "ABORT_ERR") return err(failure);
  return ok(${NATIVE_HELPER}(preparation, failure));
}
/** Generate compaction summary data from prepared session history. */`,
    `${filePath}: native helpers`,
  );
  for (const [name, pattern] of [
    ['history', /if \(!historyResult\.ok\) return err\(historyResult\.error\);/],
    ['prefix', /if \(!turnPrefixResult\.ok\) return err\(turnPrefixResult\.error\);/],
    ['summary', /if \(!summaryResult\.ok\) return err\(summaryResult\.error\);/],
  ])
    out = replaceUniquePattern(
      out,
      pattern,
      m =>
        m.replace(
          /return err\((\w+)\.error\)/,
          'return recoverJustDoNativeCompaction(preparation, signal, $1.error)',
        ),
      `${filePath}: ${name}`,
    );
  return out;
}

function applyPatch(runtimeDir) {
  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  let safeguards = findFilesContaining(runtimeDir, [
    'Compaction summarization failed; cancelling compaction to preserve history',
    'Compaction safeguard could not resolve a summarization model',
  ]);
  if (safeguards.length === 0)
    safeguards = findFilesContaining(runtimeDir, [`function ${SAFEGUARD_HELPER}(`]);
  let natives = findFilesContaining(runtimeDir, [
    'async function compact(preparation, model, apiKey',
    'TURN_PREFIX_SUMMARIZATION_PROMPT',
  ]);
  if (natives.length === 0)
    natives = findFilesContaining(runtimeDir, [`function ${NATIVE_HELPER}(`]);
  if (safeguards.length !== expected || natives.length !== expected)
    throw new Error(
      `compaction target counts safeguard=${safeguards.length}, native=${natives.length}, expected=${expected}`,
    );
  const transforms = new Map();
  for (const [filePath, transform] of [
    ...safeguards.map(p => [p, transformSafeguard]),
    ...natives.map(p => [p, transformNative]),
  ]) {
    transforms.set(filePath, [...(transforms.get(filePath) ?? []), transform]);
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
    .filter(x => writeIfChanged(x.filePath, x.original, x.updated))
    .map(x => path.relative(runtimeDir, x.filePath));
}

function verifyPatch(runtimeDir) {
  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  const safeguards = findFilesContaining(runtimeDir, [`function ${SAFEGUARD_HELPER}(`]);
  const natives = findFilesContaining(runtimeDir, [`function ${NATIVE_HELPER}(`]);
  if (safeguards.length !== expected || natives.length !== expected)
    throw new Error('compaction emergency targets are incomplete');
  for (const p of safeguards) {
    const c = fs.readFileSync(p, 'utf8');
    for (const x of [
      'setCompactionSafeguardCancelReason(sessionManager, void 0)',
      'if (signal?.aborted) return { cancel: true }',
      '## Previous summary',
      '## Retained user messages',
      '## Recent conversation tail',
      'justdoRetainedUserMessages: retainedArchive',
      'readFiles,',
      'MAX_COMPACTION_SUMMARY_CHARS',
    ])
      if (!c.includes(x)) throw new Error(`${p}: missing ${x}`);
    if (!/if \(signal\?\.aborted \|\| isAbortError\((\w+)\)\) throw \1;/.test(c))
      throw new Error(`${p}: missing provider abort propagation guard`);
    if (!/if \(signal\?\.aborted \|\| isAbortError\(\w+\)\) return \{ cancel: true \};/.test(c))
      throw new Error(`${p}: missing summarization abort cancellation guard`);
  }
  for (const p of natives) {
    const c = fs.readFileSync(p, 'utf8');
    for (const x of [
      'nativeCompactionFailure:',
      'failure?.name === "AbortError"',
      'recoverJustDoNativeCompaction(preparation, signal',
      'JUSTDO_NATIVE_EMERGENCY_MAX_CHARS = 16e3',
      '## Retained user messages',
      'renderJustDoNativeEmergencyMessages(recentMessages)',
      'justdoRetainedUserMessages: retainedArchive',
      'readFiles,',
    ])
      if (!c.includes(x)) throw new Error(`${p}: missing ${x}`);
  }
}
module.exports = { applyPatch, transformNative, transformSafeguard, verifyPatch };
