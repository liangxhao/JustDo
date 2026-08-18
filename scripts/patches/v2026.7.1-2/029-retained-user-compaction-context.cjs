'use strict';

// Capability: persist and replay a rolling 20k-token archive of original user messages.
// Target: pristine openclaw@2026.7.1-2, whose compaction entry has no retained-user archive.
// Scope: writes versioned CompactionEntry.details metadata and replays it in buildSessionContext.
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
  return estimateTokens({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
}
function sliceJustDoUserTextToTokenBudget(text, tokenBudget) {
  if (tokenBudget <= 0) return "";
  if (estimateJustDoUserTextTokens(text) <= tokenBudget) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    let candidate = text.slice(middle);
    if (candidate && /[\\uDC00-\\uDFFF]/.test(candidate[0])) candidate = candidate.slice(1);
    if (estimateJustDoUserTextTokens(candidate) <= tokenBudget) high = middle;
    else low = middle + 1;
  }
  let result = text.slice(low);
  if (result && /[\\uDC00-\\uDFFF]/.test(result[0])) result = result.slice(1);
  return result;
}
function readJustDoRetainedUserArchive(details) {
  const archive = details?.justdoRetainedUserMessages;
  if (archive?.version !== JUSTDO_RETAINED_USER_ARCHIVE_VERSION || !Array.isArray(archive.messages)) return [];
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
function buildJustDoRetainedUserReplayMessage(compaction) {
  const records = readJustDoRetainedUserArchive(compaction.details);
  if (records.length === 0) return null;
  const content = [{
    type: "text",
    text: "Historical user messages retained verbatim across compaction; preserve their intent and ordering."
  }];
  for (const record of records) content.push({ type: "text", text: record.text });
  return asAgentMessage(createCustomMessage(
    "justdo.retained-user-context",
    content,
    false,
    { runtimeContextCarrier: true },
    compaction.timestamp
  ));
}
/** Build model context from the active session branch and its latest state markers. */`,
    `${filePath}: retained user metadata helpers`,
  );

  updated = replaceUniquePattern(
    updated,
    /(messages\.push\(asAgentMessage\(createCompactionSummaryMessage\(compaction\.summary, compaction\.tokensBefore, compaction\.timestamp\)\)\);)/,
    `$1
    const justDoRetainedUserReplay = buildJustDoRetainedUserReplayMessage(compaction);
    if (justDoRetainedUserReplay) messages.push(justDoRetainedUserReplay);`,
    `${filePath}: buildSessionContext retained-user replay`,
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
    historyEnd,
    justDoPreviousCompactionDetails
  );
  $1`,
    `${filePath}: retained-user archive collection`,
  );
  updated = replaceUniquePattern(
    updated,
    /(return ok\(\{\s*firstKeptEntryId,\s*messagesToSummarize,\s*turnPrefixMessages,\s*isSplitTurn: cutPoint\.isSplitTurn,\s*tokensBefore,\s*previousSummary,\s*fileOps,)/,
    '$1\n    justDoRetainedUserMessages,',
    `${filePath}: retained-user preparation field`,
  );
  updated = replaceUniquePattern(
    updated,
    /const \{ firstKeptEntryId, messagesToSummarize, turnPrefixMessages, isSplitTurn, tokensBefore, previousSummary, fileOps, settings \} = preparation;/,
    'const { firstKeptEntryId, messagesToSummarize, turnPrefixMessages, isSplitTurn, tokensBefore, previousSummary, fileOps, settings, justDoRetainedUserMessages } = preparation;',
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
      'buildJustDoRetainedUserReplayMessage(compaction)',
      'justdo.retained-user-context',
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
  }
}

module.exports = { applyPatch, transform, verifyPatch };
