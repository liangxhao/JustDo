'use strict';

// Capability: install Codex-local replacement history with a rolling 20k-token user archive.
// Target: pristine openclaw@2026.7.1-2, whose compaction entry has no retained-user archive.
// Scope: writes versioned CompactionEntry.details metadata, replays individual user messages before
// the summary, and suppresses the native assistant/tool tail for marked Codex-local checkpoints.
// Safety: never embeds metadata in summary text; preserves native details and transcript identity.
// Remove when: upstream persists and replays an equivalent bounded retained-user metadata field.

const fs = require('fs');
const path = require('path');
const { findFilesContaining, replaceUniquePattern, writeIfChanged } = require('./_patch-utils.js');

const HELPER = 'buildJustDoRetainedUserArchive';

function transform(content, filePath) {
  if (content.includes(`function ${HELPER}(`)) return content;
  if (content.includes('buildJustDoRetainedUserContext')) {
    throw new Error(`${filePath}: obsolete or partial retained-user patch detected`);
  }

  let updated = replaceUniquePattern(
    content,
    /\/\*\* Build model context from the active session branch and its latest state markers\. \*\//,
    `const JUSTDO_RETAINED_USER_ARCHIVE_VERSION = 1;
const JUSTDO_RETAINED_USER_TOKEN_BUDGET = 20000;
function readJustDoUserText(message) {
  if (message?.role !== "user") return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\\n");
}
function estimateJustDoUserTextTokens(text) {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}
function sliceJustDoUserTextToTokenBudget(text, tokenBudget) {
  if (tokenBudget <= 0) return "";
  if (estimateJustDoUserTextTokens(text) <= tokenBudget) return text;
  const maxBytes = tokenBudget * 4;
  const totalBytes = Buffer.byteLength(text, "utf8");
  let removedTokens = Math.ceil(Math.max(0, totalBytes - maxBytes) / 4);
  let marker = "…" + removedTokens + " tokens truncated…";
  let contentBudget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  removedTokens = Math.ceil(Math.max(0, totalBytes - contentBudget) / 4);
  marker = "…" + removedTokens + " tokens truncated…";
  contentBudget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  const leftBudget = Math.floor(contentBudget / 2);
  const rightBudget = contentBudget - leftBudget;
  let prefixEnd = 0;
  let prefixBytes = 0;
  for (const character of text) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (prefixBytes + bytes > leftBudget) break;
    prefixBytes += bytes;
    prefixEnd += character.length;
  }
  let suffixStart = text.length;
  let suffixBytes = 0;
  for (let index = text.length; index > prefixEnd;) {
    const lastCodeUnit = text.charCodeAt(index - 1);
    const width = lastCodeUnit >= 0xdc00 && lastCodeUnit <= 0xdfff ? 2 : 1;
    const start = index - width;
    const character = text.slice(start, index);
    const bytes = Buffer.byteLength(character, "utf8");
    if (suffixBytes + bytes > rightBudget) break;
    suffixBytes += bytes;
    suffixStart = start;
    index = start;
  }
  if (suffixStart < prefixEnd) suffixStart = prefixEnd;
  return text.slice(0, prefixEnd) + marker + text.slice(suffixStart);
}
function readJustDoRetainedUserArchive(details) {
  const archive = details?.justdoRetainedUserMessages;
  if (!archive || !Array.isArray(archive.messages)) return [];
  if (archive.version !== void 0 && archive.version !== JUSTDO_RETAINED_USER_ARCHIVE_VERSION) return [];
  return archive.messages.filter((record) =>
    record && typeof record === "object" && typeof record.text === "string" && record.text.length > 0
  ).map((record) => ({
    ...typeof record.sourceEntryId === "string" ? { sourceEntryId: record.sourceEntryId } : {},
    ...Number.isFinite(record.timestamp) ? { timestamp: record.timestamp } : {},
    text: record.text
  }));
}
function ${HELPER}(pathEntries, historyEnd, previousDetails) {
  const candidates = [...readJustDoRetainedUserArchive(previousDetails)];
  for (let index = 0; index < historyEnd; index += 1) {
    const entry = pathEntries[index];
    if (entry?.type !== "message") continue;
    const text = readJustDoUserText(entry.message);
    if (!text) continue;
    candidates.push({
      sourceEntryId: entry.id,
      timestamp: Number.isFinite(entry.message.timestamp) ? entry.message.timestamp : Date.parse(entry.timestamp),
      text
    });
  }
  const deduped = [];
  const seen = new Set();
  for (const record of candidates) {
    const key = record.sourceEntryId
      ? "id:" + record.sourceEntryId
      : "legacy:" + String(record.timestamp ?? "") + "\\0" + record.text;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(record);
  }
  let remainingTokens = JUSTDO_RETAINED_USER_TOKEN_BUDGET;
  const retained = [];
  for (let index = deduped.length - 1; index >= 0 && remainingTokens > 0; index -= 1) {
    const record = deduped[index];
    const fullTokens = estimateJustDoUserTextTokens(record.text);
    const text = fullTokens <= remainingTokens
      ? record.text
      : sliceJustDoUserTextToTokenBudget(record.text, remainingTokens);
    if (!text) break;
    retained.unshift({ ...record, text, ...(text !== record.text ? { truncated: true } : {}) });
    remainingTokens -= estimateJustDoUserTextTokens(text);
  }
  return {
    version: JUSTDO_RETAINED_USER_ARCHIVE_VERSION,
    tokenBudget: JUSTDO_RETAINED_USER_TOKEN_BUDGET,
    estimatedTokens: JUSTDO_RETAINED_USER_TOKEN_BUDGET - remainingTokens,
    messages: retained
  };
}
function buildJustDoRetainedUserReplayMessages(compaction) {
  const records = readJustDoRetainedUserArchive(compaction.details);
  return records.map((record) => ({
    role: "user",
    content: record.text,
    timestamp: Number.isFinite(record.timestamp) ? record.timestamp : Date.parse(compaction.timestamp)
  }));
}
/** Build model context from the active session branch and its latest state markers. */`,
    `${filePath}: retained user metadata helpers`,
  );

  updated = replaceUniquePattern(
    updated,
    /messages\.push\(asAgentMessage\(createCompactionSummaryMessage\(compaction\.summary, compaction\.tokensBefore, compaction\.timestamp\)\)\);/,
    `const justDoCodexLocalCompaction =
      compaction.details?.justdoCompaction?.semantics === "codex-local";
    const justDoRetainedUserReplay = buildJustDoRetainedUserReplayMessages(compaction);
    if (justDoRetainedUserReplay.length > 0) messages.push(...justDoRetainedUserReplay);
    messages.push(asAgentMessage(createCompactionSummaryMessage(compaction.summary, compaction.tokensBefore, compaction.timestamp)));`,
    `${filePath}: buildSessionContext Codex-local replay order`,
  );
  updated = replaceUniquePattern(
    updated,
    /(\s*let foundFirstKept = false;[\s\S]*?)(\s*for \(let i = compactionIdx \+ 1;)/,
    `
    if (!justDoCodexLocalCompaction) {$1
    }
    $2`,
    `${filePath}: suppress native retained tail for Codex-local checkpoints`,
  );
  updated = replaceUniquePattern(
    updated,
    /let previousSummary;\s*let boundaryStart = 0;/,
    'let previousSummary;\n  let justDoPreviousCompactionDetails;\n  let boundaryStart = 0;',
    `${filePath}: previous retained-user metadata state`,
  );
  updated = replaceUniquePattern(
    updated,
    /(previousSummary = prevCompaction\.summary;)/,
    '$1\n    justDoPreviousCompactionDetails = prevCompaction.details;',
    `${filePath}: previous compaction metadata read`,
  );
  updated = replaceUniquePattern(
    updated,
    /(const fileOps = extractFileOperations\(messagesToSummarize, pathEntries, prevCompactionIndex\);)/,
    `const justDoRetainedUserMessages = ${HELPER}(
    pathEntries,
    pathEntries.length,
    justDoPreviousCompactionDetails
  );
  const justDoPreviousGeneration = justDoPreviousCompactionDetails?.justdoCompaction?.generation;
  const justDoCompactionGeneration = Number.isFinite(justDoPreviousGeneration)
    ? Math.max(1, Math.floor(justDoPreviousGeneration) + 1)
    : 1;
  $1`,
    `${filePath}: retained-user archive collection`,
  );
  updated = replaceUniquePattern(
    updated,
    /(return ok\(\{\s*firstKeptEntryId,\s*messagesToSummarize,\s*turnPrefixMessages,\s*isSplitTurn: cutPoint\.isSplitTurn,\s*tokensBefore,\s*previousSummary,\s*fileOps,)/,
    '$1\n    justDoRetainedUserMessages,\n    justDoCompactionGeneration,',
    `${filePath}: retained-user preparation field`,
  );
  updated = replaceUniquePattern(
    updated,
    /const \{ firstKeptEntryId, messagesToSummarize, turnPrefixMessages, isSplitTurn, tokensBefore, previousSummary, fileOps, settings \} = preparation;/,
    'const { firstKeptEntryId, messagesToSummarize, turnPrefixMessages, isSplitTurn, tokensBefore, previousSummary, fileOps, settings, justDoRetainedUserMessages, justDoCompactionGeneration } = preparation;',
    `${filePath}: compact retained-user preparation`,
  );
  updated = replaceUniquePattern(
    updated,
    /details: \{\s*readFiles,\s*modifiedFiles\s*\}/,
    'details: {\n      readFiles,\n      modifiedFiles,\n      justdoRetainedUserMessages: justDoRetainedUserMessages\n    }',
    `${filePath}: native compaction metadata commit`,
  );
  updated = replaceUniquePattern(
    updated,
    /(const result = compactResult\.value;\s*)const entryId = await this\.session\.appendCompaction\(result\.summary, result\.firstKeptEntryId, result\.tokensBefore, result\.details, provided !== void 0\);/,
    `$1const justDoCompactionDetails = {
        ...(result.details && typeof result.details === "object" ? result.details : {}),
        justdoRetainedUserMessages: preparation.justDoRetainedUserMessages
      };
      const entryId = await this.session.appendCompaction(result.summary, result.firstKeptEntryId, result.tokensBefore, justDoCompactionDetails, provided !== void 0);`,
    `${filePath}: hook and native compaction metadata commit`,
  );
  return updated;
}

function applyPatch(runtimeDir) {
  const files = findFilesContaining(runtimeDir, [
    'function buildSessionContext(pathEntries)',
    'function prepareCompaction(pathEntries, settings',
    'async function compact(preparation, model, apiKey',
    'async appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromHook)',
  ]);
  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  if (files.length !== expected) {
    throw new Error(
      `retained user compaction target count is ${files.length}, expected ${expected}`,
    );
  }
  const staged = files.map(filePath => {
    const original = fs.readFileSync(filePath, 'utf8');
    return { filePath, original, updated: transform(original, filePath) };
  });
  return staged
    .filter(item => writeIfChanged(item.filePath, item.original, item.updated))
    .map(item => path.relative(runtimeDir, item.filePath));
}

function verifyPatch(runtimeDir) {
  const files = findFilesContaining(runtimeDir, [`function ${HELPER}(`]);
  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  if (files.length !== expected) throw new Error('retained user compaction targets are incomplete');
  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const contract of [
      'justdoRetainedUserMessages: preparation.justDoRetainedUserMessages',
      'buildJustDoRetainedUserReplayMessages(compaction)',
      'justDoCodexLocalCompaction',
      'justDoCompactionGeneration',
      'sourceEntryId: entry.id',
    ]) {
      if (!content.includes(contract)) {
        throw new Error(`${filePath}: missing retained-user contract ${contract}`);
      }
    }
    if (!/JUSTDO_RETAINED_USER_TOKEN_BUDGET = (?:20000|2e4)/.test(content)) {
      throw new Error(`${filePath}: missing retained-user 20k token budget`);
    }
    if (content.includes('<justdo-retained-user-messages')) {
      throw new Error(`${filePath}: retained-user metadata leaked into summary text`);
    }
    if (content.includes('justdo.retained-user-context')) {
      throw new Error(`${filePath}: retained users are still replayed as a custom carrier`);
    }
  }
}

module.exports = { applyPatch, transform, verifyPatch };
