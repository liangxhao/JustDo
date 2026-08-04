'use strict';

// Purpose: Preserve user-authored text across repeated compactions using a
// Codex-style 20k-token rolling budget, independently of summary quality.
// Affected OpenClaw version: v2026.6.11.
// Risk: Upstream changes to agent-core compaction/session bundle output require
// these narrowly scoped patch points to be updated.
// Upgrade action: Do not copy this patch into a new OpenClaw version directory.
// Re-audit prepareCompaction, both appendCompaction call sites, and
// buildSessionContext, then rewrite the exact anchors and rerun manual,
// threshold/overflow, mid-turn, and repeated-compaction tests.
// Remove when: OpenClaw natively persists and replays retained user messages
// across compaction entries.
// Upstream tracking: TODO(openclaw): request retained-user-message compaction metadata.
// Temporary: yes.

const fs = require('fs');
const path = require('path');

const RETAINED_USER_HELPERS = `var RETAINED_USER_MESSAGE_MAX_TOKENS = 2e4;
function readRetainedUserMessages(details) {
  const retained = details && typeof details === "object" ? details.retainedUserMessages : void 0;
  if (!Array.isArray(retained)) return [];
  return retained.filter((message) => message && typeof message === "object" && typeof message.content === "string" && typeof message.timestamp === "number");
}
function hasCompleteRetainedUserMessages(compaction) {
  return compaction?.details?.retainedUserMessagesComplete === true;
}
function estimateRetainedUserTokens(text) {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}
function takeRetainedUserUtf8Prefix(text, maxBytes) {
  if (maxBytes <= 0) return "";
  let bytes = 0;
  let result = "";
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}
function truncateRetainedUserText(text, maxTokens) {
  const maxBytes = maxTokens * 4;
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= maxBytes) return text;
  if (maxBytes <= 0) return "";
  const removedTokens = Math.ceil(Math.max(0, totalBytes - maxBytes) / 4);
  const marker = \`…\${removedTokens} tokens truncated…\`;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (markerBytes >= maxBytes) return takeRetainedUserUtf8Prefix(marker, maxBytes);
  const characters = Array.from(text);
  const contentBudget = maxBytes - markerBytes;
  const leftBudget = Math.floor(contentBudget / 2);
  const rightBudget = contentBudget - leftBudget;
  let leftBytes = 0;
  let leftCount = 0;
  while (leftCount < characters.length) {
    const bytes = Buffer.byteLength(characters[leftCount], "utf8");
    if (leftBytes + bytes > leftBudget) break;
    leftBytes += bytes;
    leftCount++;
  }
  let rightBytes = 0;
  let rightStart = characters.length;
  while (rightStart > leftCount) {
    const bytes = Buffer.byteLength(characters[rightStart - 1], "utf8");
    if (rightBytes + bytes > rightBudget) break;
    rightBytes += bytes;
    rightStart--;
  }
  return characters.slice(0, leftCount).join("") + marker + characters.slice(rightStart).join("");
}
function collectRetainedUserMessages(existing, compactedMessages) {
  const candidates = [...existing];
  for (const message of compactedMessages) {
    if (message?.role !== "user") continue;
    const content = typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\\n") : "";
    if (content) candidates.push({
      content,
      timestamp: typeof message.timestamp === "number" ? message.timestamp : 0
    });
  }
  const retained = [];
  let remainingTokens = RETAINED_USER_MESSAGE_MAX_TOKENS;
  for (let i = candidates.length - 1; i >= 0; i--) {
    if (remainingTokens === 0) break;
    const candidate = candidates[i];
    const tokens = estimateRetainedUserTokens(candidate.content);
    if (tokens <= remainingTokens) {
      retained.unshift(candidate);
      remainingTokens -= tokens;
      continue;
    }
    retained.unshift({
      content: truncateRetainedUserText(candidate.content, remainingTokens),
      timestamp: candidate.timestamp
    });
    break;
  }
  return retained;
}
function collectRetainedUserMessagesForPreparation(existing, pathEntries, prevCompactionIndex) {
  let entryStart = 0;
  if (prevCompactionIndex >= 0) {
    const previousCompaction = pathEntries[prevCompactionIndex];
    if (hasCompleteRetainedUserMessages(previousCompaction)) entryStart = prevCompactionIndex + 1;
    else {
      const firstKeptIndex = pathEntries.findIndex((entry) => entry.id === previousCompaction?.firstKeptEntryId);
      entryStart = firstKeptIndex >= 0 ? firstKeptIndex : prevCompactionIndex + 1;
    }
  }
  const branchUserMessages = pathEntries.slice(entryStart).filter((entry) => entry.type === "message").map((entry) => entry.message);
  return collectRetainedUserMessages(existing, branchUserMessages);
}
function collectRecentUserMessagesForSummary(pathEntries, firstKeptEntryId) {
  const firstKeptIndex = pathEntries.findIndex((entry) => entry.id === firstKeptEntryId);
  if (firstKeptIndex < 0) return [];
  const tailMessages = pathEntries.slice(firstKeptIndex).filter((entry) => entry.type === "message").map((entry) => entry.message);
  return collectRetainedUserMessages([], tailMessages).map((message) => ({
    role: "user",
    content: message.content,
    timestamp: message.timestamp
  }));
}
function collectRecentMessagesForSummary(pathEntries, firstKeptEntryId) {
  const firstKeptIndex = pathEntries.findIndex((entry) => entry.id === firstKeptEntryId);
  if (firstKeptIndex < 0) return [];
  return pathEntries.slice(firstKeptIndex).filter((entry) => entry.type === "message").map((entry) => entry.message).filter((message) => message?.role === "user" || message?.role === "assistant" || message?.role === "toolResult" || message?.role === "bashExecution");
}
function extractSummaryContentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\\n");
}
function truncateSummaryToolText(text, maxChars) {
  if (text.length <= maxChars) return text;
  if (maxChars <= 0) return "";
  const marker = \`\\n...[tool result truncated: \${text.length - maxChars} chars omitted]...\\n\`;
  if (marker.length >= maxChars) return marker.slice(0, maxChars);
  const remaining = maxChars - marker.length;
  const left = Math.ceil(remaining / 2);
  return text.slice(0, left) + marker + text.slice(text.length - (remaining - left));
}
function sanitizeCompactionSummaryMessages(messages) {
  const sanitized = [...messages];
  const omittedMarkerBudget = 256;
  let remainingToolChars = 24e3 - omittedMarkerBudget;
  const omittedIndices = [];
  for (let i = sanitized.length - 1; i >= 0; i--) {
    const message = sanitized[i];
    if (message?.role === "toolResult") {
      const text = extractSummaryContentText(message.content);
      const allowance = Math.min(6e3, remainingToolChars);
      const content = truncateSummaryToolText(text, allowance);
      if (text.length > 0 && allowance === 0) omittedIndices.push(i);
      remainingToolChars = Math.max(0, remainingToolChars - Math.min(text.length, allowance));
      sanitized[i] = {
        ...message,
        content: typeof message.content === "string" ? content : [{
          type: "text",
          text: content
        }]
      };
    } else if (message?.role === "bashExecution" && typeof message.output === "string") {
      const allowance = Math.min(6e3, remainingToolChars);
      const output = truncateSummaryToolText(message.output, allowance);
      if (message.output.length > 0 && allowance === 0) omittedIndices.push(i);
      remainingToolChars = Math.max(0, remainingToolChars - Math.min(message.output.length, allowance));
      sanitized[i] = {
        ...message,
        output
      };
    }
  }
  if (omittedIndices.length > 0) {
    const marker = \`[\${omittedIndices.length} earlier tool outputs omitted from summary input after the 24000-character shared limit]\`.slice(0, omittedMarkerBudget);
    const markerIndex = Math.min(...omittedIndices);
    const message = sanitized[markerIndex];
    if (message?.role === "toolResult") sanitized[markerIndex] = {
      ...message,
      content: typeof message.content === "string" ? marker : [{
        type: "text",
        text: marker
      }]
    };
    else if (message?.role === "bashExecution") sanitized[markerIndex] = {
      ...message,
      output: marker
    };
  }
  return sanitized;
}
function resolveRetainedUserMessages(compaction, pathEntries) {
  const persisted = compaction?.details && typeof compaction.details === "object" ? compaction.details.retainedUserMessages : void 0;
  if (Array.isArray(persisted)) return readRetainedUserMessages(compaction.details);
  const firstKeptIndex = pathEntries.findIndex((entry) => entry.id === compaction?.firstKeptEntryId);
  if (firstKeptIndex <= 0) return [];
  const legacyCompactedMessages = pathEntries.slice(0, firstKeptIndex).filter((entry) => entry.type === "message").map((entry) => entry.message);
  return collectRetainedUserMessages([], legacyCompactedMessages);
}
function resolveRetainedUserMessagesForReplay(compaction, pathEntries) {
  const retained = resolveRetainedUserMessages(compaction, pathEntries);
  if (!hasCompleteRetainedUserMessages(compaction)) return retained;
  const compactionIndex = pathEntries.findIndex((entry) => entry.id === compaction?.id);
  const firstKeptIndex = pathEntries.findIndex((entry) => entry.id === compaction?.firstKeptEntryId);
  if (compactionIndex < 0 || firstKeptIndex < 0 || firstKeptIndex >= compactionIndex) return retained;
  const nativeTailUserCount = pathEntries.slice(firstKeptIndex, compactionIndex).filter((entry) => {
    if (entry.type !== "message" || entry.message?.role !== "user") return false;
    const content = entry.message.content;
    if (typeof content === "string") return content.length > 0;
    return Array.isArray(content) && content.some((part) => part?.type === "text" && typeof part.text === "string" && part.text.length > 0);
  }).length;
  return nativeTailUserCount > 0 ? retained.slice(0, Math.max(0, retained.length - nativeTailUserCount)) : retained;
}
`;

const SESSION_CONTEXT_ANCHOR = 'function buildSessionContext(pathEntries) {';
const ORIGINAL_CONTEXT_REPLAY = `  if (compaction) {
    messages.push(asAgentMessage(createCompactionSummaryMessage(compaction.summary, compaction.tokensBefore, compaction.timestamp)));`;
const PATCHED_CONTEXT_REPLAY = `  if (compaction) {
    for (const retained of resolveRetainedUserMessagesForReplay(compaction, pathEntries)) messages.push({
      role: "user",
      content: retained.content,
      timestamp: retained.timestamp
    });
    messages.push(asAgentMessage(createCompactionSummaryMessage(compaction.summary, compaction.tokensBefore, compaction.timestamp)));`;

const ORIGINAL_PREPARATION_STATE = `  let previousSummary;
  let boundaryStart = 0;`;
const PATCHED_PREPARATION_STATE = `  let previousSummary;
  let previousRetainedUserMessages = [];
  let boundaryStart = 0;`;

const ORIGINAL_PREVIOUS_SUMMARY = `    previousSummary = prevCompaction.summary;
    const firstKeptEntryIndex = pathEntries.findIndex((entry) => entry.id === prevCompaction.firstKeptEntryId);`;
const PATCHED_PREVIOUS_SUMMARY = `    previousSummary = prevCompaction.summary;
    previousRetainedUserMessages = resolveRetainedUserMessages(prevCompaction, pathEntries);
    const firstKeptEntryIndex = pathEntries.findIndex((entry) => entry.id === prevCompaction.firstKeptEntryId);`;

const ORIGINAL_PREPARATION_RESULT = `  const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);
  if (cutPoint.isSplitTurn) for (const msg of turnPrefixMessages) extractFileOpsFromMessage(msg, fileOps);
  return ok({
    firstKeptEntryId,
    messagesToSummarize,
    turnPrefixMessages,
    isSplitTurn: cutPoint.isSplitTurn,
    tokensBefore,
    previousSummary,
    fileOps,`;
const PATCHED_PREPARATION_RESULT = `  const retainedUserMessages = collectRetainedUserMessagesForPreparation(previousRetainedUserMessages, pathEntries, prevCompactionIndex);
  const recentUserMessagesForSummary = collectRecentUserMessagesForSummary(pathEntries, firstKeptEntryId);
  const recentMessagesForSummary = collectRecentMessagesForSummary(pathEntries, firstKeptEntryId);
  const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);
  if (cutPoint.isSplitTurn) for (const msg of turnPrefixMessages) extractFileOpsFromMessage(msg, fileOps);
  return ok({
    firstKeptEntryId,
    messagesToSummarize,
    turnPrefixMessages,
    isSplitTurn: cutPoint.isSplitTurn,
    tokensBefore,
    previousSummary,
    retainedUserMessages,
    recentUserMessagesForSummary,
    recentMessagesForSummary,
    fileOps,`;

const ORIGINAL_SUMMARY_INPUT = `    const rawTurnPrefixMessages = preparation.turnPrefixMessages ?? [];
    let baseMessagesToSummarize = stripRuntimeContextCustomMessages(preparation.messagesToSummarize);`;
const PATCHED_SUMMARY_INPUT = `    const rawTurnPrefixMessages = preparation.turnPrefixMessages ?? [];
    const recentUserMessagesForSummary = Array.isArray(preparation.recentUserMessagesForSummary) ? preparation.recentUserMessagesForSummary : [];
    const recentMessagesForSummary = Array.isArray(preparation.recentMessagesForSummary) ? preparation.recentMessagesForSummary : recentUserMessagesForSummary;
    const appendRecentToTurnPrefix = preparation.isSplitTurn === true;
    let baseMessagesToSummarize = stripRuntimeContextCustomMessages(sanitizeCompactionSummaryMessages([...preparation.messagesToSummarize, ...(appendRecentToTurnPrefix ? [] : recentMessagesForSummary)]));`;
const ORIGINAL_TURN_PREFIX_INPUT = `    let baseTurnPrefixMessages = stripRuntimeContextCustomMessages(rawTurnPrefixMessages);`;
const PATCHED_TURN_PREFIX_INPUT = `    let baseTurnPrefixMessages = stripRuntimeContextCustomMessages(sanitizeCompactionSummaryMessages([...rawTurnPrefixMessages, ...(appendRecentToTurnPrefix ? recentMessagesForSummary : [])]));`;

const ORIGINAL_COMPACTION_PERSIST = `          const result = compactResult.value;
          const entryId = await this.session.appendCompaction(result.summary, result.firstKeptEntryId, result.tokensBefore, result.details, provided !== void 0);`;
const PATCHED_COMPACTION_PERSIST = `          const result = compactResult.value;
          const resultDetails = result.details && typeof result.details === "object" && !Array.isArray(result.details) ? result.details : {};
          const persistedResult = {
            ...result,
            details: {
              ...resultDetails,
              retainedUserMessages: preparation.retainedUserMessages,
              retainedUserMessagesComplete: true
            }
          };
          const entryId = await this.session.appendCompaction(persistedResult.summary, persistedResult.firstKeptEntryId, persistedResult.tokensBefore, persistedResult.details, provided !== void 0);`;

const ORIGINAL_COMPACTION_RETURN = `          if (entry?.type === "compaction") await this.emitOwn({
            type: "session_compact",
            compactionEntry: entry,
            fromHook: provided !== void 0
          });
          return result;`;
const PATCHED_COMPACTION_RETURN = `          if (entry?.type === "compaction") await this.emitOwn({
            type: "session_compact",
            compactionEntry: entry,
            fromHook: provided !== void 0
          });
          return persistedResult;`;

const ORIGINAL_EMBEDDED_COMPACTION_PERSIST =
  '        this.sessionManager.appendCompaction(compactionResult.summary, compactionResult.firstKeptEntryId, compactionResult.tokensBefore, compactionResult.details, fromExtension);';
const PATCHED_EMBEDDED_COMPACTION_PERSIST = `        const compactionResultDetails = compactionResult.details && typeof compactionResult.details === "object" && !Array.isArray(compactionResult.details) ? compactionResult.details : {};
        compactionResult = {
          ...compactionResult,
          details: {
            ...compactionResultDetails,
            retainedUserMessages: preparation.retainedUserMessages,
            retainedUserMessagesComplete: true
          }
        };
        this.sessionManager.appendCompaction(compactionResult.summary, compactionResult.firstKeptEntryId, compactionResult.tokensBefore, compactionResult.details, fromExtension);`;

// Exact shapes emitted by the first version of this patch. Supporting this
// narrow upgrade path lets incremental development builds update an existing
// bundle without broadening any upstream anchors.
const USER_ONLY_PATCHED_PREPARATION_RESULT = PATCHED_PREPARATION_RESULT.replace(
  '  const recentMessagesForSummary = collectRecentMessagesForSummary(pathEntries, firstKeptEntryId);\n',
  '',
).replace('    recentMessagesForSummary,\n', '');
const PREVIOUS_PATCHED_PREPARATION_RESULT = USER_ONLY_PATCHED_PREPARATION_RESULT.replace(
  '  const recentUserMessagesForSummary = collectRecentUserMessagesForSummary(pathEntries, firstKeptEntryId);\n',
  '',
).replace('    recentUserMessagesForSummary,\n', '');
const LEGACY_PATCHED_PREPARATION_RESULT = PREVIOUS_PATCHED_PREPARATION_RESULT.replace(
  'collectRetainedUserMessagesForPreparation(previousRetainedUserMessages, pathEntries, prevCompactionIndex)',
  'collectRetainedUserMessages(previousRetainedUserMessages, [...messagesToSummarize, ...turnPrefixMessages])',
);
const LEGACY_PATCHED_CONTEXT_REPLAY = PATCHED_CONTEXT_REPLAY.replace(
  'resolveRetainedUserMessagesForReplay(compaction, pathEntries)',
  'resolveRetainedUserMessages(compaction, pathEntries)',
);
const UNSPLIT_PATCHED_SUMMARY_INPUT = PATCHED_SUMMARY_INPUT.replace(
  '    const appendRecentToTurnPrefix = preparation.isSplitTurn === true;\n',
  '',
).replace(
  '...(appendRecentToTurnPrefix ? [] : recentMessagesForSummary)',
  '...recentMessagesForSummary',
);
const UNSPLIT_PATCHED_TURN_PREFIX_INPUT = PATCHED_TURN_PREFIX_INPUT.replace(
  '[...rawTurnPrefixMessages, ...(appendRecentToTurnPrefix ? recentMessagesForSummary : [])]',
  'rawTurnPrefixMessages',
);
const PREVIOUS_PATCHED_SUMMARY_INPUT = UNSPLIT_PATCHED_SUMMARY_INPUT.replace(
  '    const recentMessagesForSummary = Array.isArray(preparation.recentMessagesForSummary) ? preparation.recentMessagesForSummary : recentUserMessagesForSummary;\n',
  '',
).replace(
  'sanitizeCompactionSummaryMessages([...preparation.messagesToSummarize, ...recentMessagesForSummary])',
  '[...preparation.messagesToSummarize, ...recentUserMessagesForSummary]',
);
const LEGACY_PATCHED_COMPACTION_PERSIST = PATCHED_COMPACTION_PERSIST.replace(
  ',\n              retainedUserMessagesComplete: true',
  '',
);
const LEGACY_PATCHED_EMBEDDED_COMPACTION_PERSIST = PATCHED_EMBEDDED_COMPACTION_PERSIST.replace(
  ',\n            retainedUserMessagesComplete: true',
  '',
);

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

function patchFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  const legacyContextPatchPresent = content.includes(LEGACY_PATCHED_CONTEXT_REPLAY);
  const harnessPatchPresent =
    (content.includes(PATCHED_CONTEXT_REPLAY) || legacyContextPatchPresent) &&
    content.includes(PATCHED_PREPARATION_STATE) &&
    content.includes(PATCHED_PREVIOUS_SUMMARY) &&
    content.includes(PATCHED_PREPARATION_RESULT) &&
    content.includes(PATCHED_COMPACTION_PERSIST) &&
    content.includes(PATCHED_COMPACTION_RETURN);
  const previousHarnessPatchPresent =
    (content.includes(PATCHED_CONTEXT_REPLAY) || legacyContextPatchPresent) &&
    content.includes(PATCHED_PREPARATION_STATE) &&
    content.includes(PATCHED_PREVIOUS_SUMMARY) &&
    content.includes(PREVIOUS_PATCHED_PREPARATION_RESULT) &&
    content.includes(PATCHED_COMPACTION_PERSIST) &&
    content.includes(PATCHED_COMPACTION_RETURN);
  const userOnlyHarnessPatchPresent =
    (content.includes(PATCHED_CONTEXT_REPLAY) || legacyContextPatchPresent) &&
    content.includes(PATCHED_PREPARATION_STATE) &&
    content.includes(PATCHED_PREVIOUS_SUMMARY) &&
    content.includes(USER_ONLY_PATCHED_PREPARATION_RESULT) &&
    content.includes(PATCHED_COMPACTION_PERSIST) &&
    content.includes(PATCHED_COMPACTION_RETURN);
  const embeddedPatchPresent = content.includes(PATCHED_EMBEDDED_COMPACTION_PERSIST);
  const legacyHarnessPatchPresent =
    (content.includes(PATCHED_CONTEXT_REPLAY) || legacyContextPatchPresent) &&
    content.includes(PATCHED_PREPARATION_STATE) &&
    content.includes(PATCHED_PREVIOUS_SUMMARY) &&
    content.includes(LEGACY_PATCHED_PREPARATION_RESULT) &&
    content.includes(LEGACY_PATCHED_COMPACTION_PERSIST) &&
    content.includes(PATCHED_COMPACTION_RETURN);
  const legacyEmbeddedPatchPresent = content.includes(LEGACY_PATCHED_EMBEDDED_COMPACTION_PERSIST);
  const summaryInputPatchPresent = content.includes(PATCHED_SUMMARY_INPUT);
  const unsplitSummaryInputPatchPresent = content.includes(UNSPLIT_PATCHED_SUMMARY_INPUT);
  const previousSummaryInputPatchPresent = content.includes(PREVIOUS_PATCHED_SUMMARY_INPUT);
  const turnPrefixPatchPresent = content.includes(PATCHED_TURN_PREFIX_INPUT);
  const unsplitTurnPrefixPatchPresent = content.includes(UNSPLIT_PATCHED_TURN_PREFIX_INPUT);
  if (
    harnessPatchPresent ||
    userOnlyHarnessPatchPresent ||
    previousHarnessPatchPresent ||
    legacyHarnessPatchPresent
  ) {
    let changed = false;
    if (!content.includes(RETAINED_USER_HELPERS)) {
      const helperStart = content.indexOf('var RETAINED_USER_MESSAGE_MAX_TOKENS = 2e4;');
      const helperEnd = content.indexOf(SESSION_CONTEXT_ANCHOR, helperStart);
      if (helperStart < 0 || helperEnd < 0) {
        throw new Error(`OpenClaw retained user helper upgrade target not found: ${filePath}`);
      }
      content = `${content.slice(0, helperStart)}${RETAINED_USER_HELPERS}${content.slice(helperEnd)}`;
      changed = true;
    }
    if (legacyContextPatchPresent) {
      content = replaceExactlyOnce(
        content,
        LEGACY_PATCHED_CONTEXT_REPLAY,
        PATCHED_CONTEXT_REPLAY,
        'retained user native-tail replay upgrade',
        filePath,
      );
      changed = true;
    }
    if (userOnlyHarnessPatchPresent || previousHarnessPatchPresent || legacyHarnessPatchPresent) {
      content = replaceExactlyOnce(
        content,
        userOnlyHarnessPatchPresent
          ? USER_ONLY_PATCHED_PREPARATION_RESULT
          : previousHarnessPatchPresent
            ? PREVIOUS_PATCHED_PREPARATION_RESULT
            : LEGACY_PATCHED_PREPARATION_RESULT,
        PATCHED_PREPARATION_RESULT,
        'recent user summary preparation upgrade',
        filePath,
      );
      if (legacyHarnessPatchPresent) {
        content = replaceExactlyOnce(
          content,
          LEGACY_PATCHED_COMPACTION_PERSIST,
          PATCHED_COMPACTION_PERSIST,
          'complete retained user AgentHarness persistence upgrade',
          filePath,
        );
      }
      changed = true;
    }
    if (!summaryInputPatchPresent) {
      content = replaceExactlyOnce(
        content,
        unsplitSummaryInputPatchPresent
          ? UNSPLIT_PATCHED_SUMMARY_INPUT
          : previousSummaryInputPatchPresent
            ? PREVIOUS_PATCHED_SUMMARY_INPUT
            : ORIGINAL_SUMMARY_INPUT,
        PATCHED_SUMMARY_INPUT,
        'recent conversation summary input',
        filePath,
      );
      changed = true;
    }
    if (!turnPrefixPatchPresent) {
      content = replaceExactlyOnce(
        content,
        unsplitTurnPrefixPatchPresent
          ? UNSPLIT_PATCHED_TURN_PREFIX_INPUT
          : ORIGINAL_TURN_PREFIX_INPUT,
        PATCHED_TURN_PREFIX_INPUT,
        'split-turn tool result summary truncation',
        filePath,
      );
      changed = true;
    }
    if (!embeddedPatchPresent) {
      content = replaceExactlyOnce(
        content,
        legacyEmbeddedPatchPresent
          ? LEGACY_PATCHED_EMBEDDED_COMPACTION_PERSIST
          : ORIGINAL_EMBEDDED_COMPACTION_PERSIST,
        PATCHED_EMBEDDED_COMPACTION_PERSIST,
        'embedded AgentSession compaction persistence',
        filePath,
      );
      changed = true;
    }
    if (changed) fs.writeFileSync(filePath, content, 'utf8');
    return changed;
  }

  content = replaceExactlyOnce(
    content,
    SESSION_CONTEXT_ANCHOR,
    `${RETAINED_USER_HELPERS}${SESSION_CONTEXT_ANCHOR}`,
    'retained user helper insertion',
    filePath,
  );
  content = replaceExactlyOnce(
    content,
    ORIGINAL_CONTEXT_REPLAY,
    PATCHED_CONTEXT_REPLAY,
    'retained user context replay',
    filePath,
  );
  content = replaceExactlyOnce(
    content,
    ORIGINAL_PREPARATION_STATE,
    PATCHED_PREPARATION_STATE,
    'compaction preparation state',
    filePath,
  );
  content = replaceExactlyOnce(
    content,
    ORIGINAL_PREVIOUS_SUMMARY,
    PATCHED_PREVIOUS_SUMMARY,
    'previous retained user messages',
    filePath,
  );
  content = replaceExactlyOnce(
    content,
    ORIGINAL_PREPARATION_RESULT,
    PATCHED_PREPARATION_RESULT,
    'retained user preparation result',
    filePath,
  );
  content = replaceExactlyOnce(
    content,
    ORIGINAL_SUMMARY_INPUT,
    PATCHED_SUMMARY_INPUT,
    'recent user summary input',
    filePath,
  );
  content = replaceExactlyOnce(
    content,
    ORIGINAL_TURN_PREFIX_INPUT,
    PATCHED_TURN_PREFIX_INPUT,
    'split-turn tool result summary truncation',
    filePath,
  );
  content = replaceExactlyOnce(
    content,
    ORIGINAL_COMPACTION_PERSIST,
    PATCHED_COMPACTION_PERSIST,
    'retained user compaction persistence',
    filePath,
  );
  content = replaceExactlyOnce(
    content,
    ORIGINAL_COMPACTION_RETURN,
    PATCHED_COMPACTION_RETURN,
    'retained user compaction return',
    filePath,
  );
  content = replaceExactlyOnce(
    content,
    ORIGINAL_EMBEDDED_COMPACTION_PERSIST,
    PATCHED_EMBEDDED_COMPACTION_PERSIST,
    'embedded AgentSession compaction persistence',
    filePath,
  );

  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

function applyPatch(runtimeDir, options = {}) {
  const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
  const label = options.label || 'patch-openclaw-retain-user-messages-across-compaction';
  if (!fs.existsSync(bundlePath)) {
    if (options.verbose) {
      console.log(`[${label}] Gateway bundle not generated yet; deferring compaction patch.`);
    }
    return [];
  }

  const patched = patchFile(bundlePath) ? ['gateway-bundle.mjs'] : [];
  if (patched.length > 0) {
    console.log(`[${label}] Preserved user messages across compaction boundaries.`);
  } else if (options.verbose) {
    console.log(`[${label}] User-message compaction retention already applied.`);
  }
  return patched;
}

function verifyPatch(runtimeDir) {
  const content = fs.readFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), 'utf8');
  const required = [
    RETAINED_USER_HELPERS,
    PATCHED_CONTEXT_REPLAY,
    PATCHED_PREPARATION_STATE,
    PATCHED_PREVIOUS_SUMMARY,
    PATCHED_PREPARATION_RESULT,
    PATCHED_SUMMARY_INPUT,
    PATCHED_TURN_PREFIX_INPUT,
    PATCHED_COMPACTION_PERSIST,
    PATCHED_COMPACTION_RETURN,
    PATCHED_EMBEDDED_COMPACTION_PERSIST,
  ];
  const missing = required.filter(marker => !content.includes(marker));
  if (missing.length > 0) throw new Error(`Retained user message compaction patch is incomplete: ${missing.length} replacement(s) missing`);
  return true;
}

module.exports = {
  applyPatch,
  verifyPatch,
  RETAINED_USER_HELPERS,
};
