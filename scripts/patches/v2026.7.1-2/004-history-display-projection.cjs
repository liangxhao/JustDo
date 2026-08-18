'use strict';

// Capability: preserve reasoning/redacted-thinking and mixed assistant tool blocks in history.
// Target: pristine openclaw@2026.7.1-2, whose display projection still discards these blocks.
// Scope: replaces only history display projection; native text classification (including
// text/input_text/output_text), block classification and sanitizing remain authoritative.
// Safety: replaces named functions once and verifies reasoning plus mixed-tool contracts separately.
// Remove when: native sessions history projects every supported assistant block losslessly.

const fs = require('fs');
const path = require('path');
const {
  assertSingleFile,
  findFilesContaining,
  replaceNamedFunction,
  writeIfChanged,
} = require('./_patch-utils.js');

const MARKER = 'JUSTDO_V2026_7_1_2_HISTORY_DISPLAY_BLOCKS';

const PROJECT_MIXED_CONTENT = `function projectAssistantTextFromMixedToolContent(content, maxChars) {
\t// ${MARKER}
\tif (!content.some((block) => block && typeof block === "object" && isToolHistoryBlockType(block.type))) return null;
\tconst displayBlocks = [];
\tfor (const block of content) {
\t\tif (!block || typeof block !== "object") continue;
\t\tconst type = block.type;
\t\tif (type === "thinking" || type === "reasoning" || type === "redacted_thinking" || isToolHistoryBlockType(type)) {
\t\t\tdisplayBlocks.push(block);
\t\t\tcontinue;
\t\t}
\t\tif (!isAssistantTextContentType(type) || typeof block.text !== "string" || !block.text.trim()) continue;
\t\tconst visible = truncateChatHistoryText(stripInlineDirectiveTagsForDisplay(block.text).text, maxChars);
\t\tif (visible.text.trim()) displayBlocks.push({ ...block, text: visible.text });
\t}
\treturn displayBlocks.length > 0 ? { content: displayBlocks, changed: true } : null;
}`;

const DETECT_TOOL_HISTORY = `function hasAssistantMixedToolVisibleText(message) {
\tif (!message || typeof message !== "object" || !Array.isArray(message.content)) return false;
\t// ${MARKER}: a tool-only commentary message is still auditable history.
\treturn message.content.some((block) => block && typeof block === "object" && isToolHistoryBlockType(block.type));
}`;

function applyPatch(runtimeDir) {
  const candidates = findFilesContaining(
    runtimeDir,
    [
      'function projectAssistantTextFromMixedToolContent(',
      'function hasAssistantMixedToolVisibleText(',
    ],
    { includeBundle: false },
  );
  const filePath = assertSingleFile(candidates, 'chat history display projection');
  const original = fs.readFileSync(filePath, 'utf8');
  if (original.includes(MARKER)) {
    verifyPatch(runtimeDir);
    return [];
  }
  let updated = replaceNamedFunction(
    original,
    'projectAssistantTextFromMixedToolContent',
    PROJECT_MIXED_CONTENT,
  );
  updated = replaceNamedFunction(updated, 'hasAssistantMixedToolVisibleText', DETECT_TOOL_HISTORY);
  writeIfChanged(filePath, original, updated);
  verifyPatch(runtimeDir);
  return [path.relative(runtimeDir, filePath)];
}

function verifyPatch(runtimeDir) {
  const sourceCandidates = findFilesContaining(
    runtimeDir,
    [
      MARKER,
      'isToolHistoryBlockType(type)',
      'type === "redacted_thinking"',
      'isAssistantTextContentType(type)',
    ],
    { includeBundle: false },
  );
  const filePath = assertSingleFile(sourceCandidates, 'patched chat history display projection');
  const content = fs.readFileSync(filePath, 'utf8');
  if ((content.match(new RegExp(MARKER, 'g')) ?? []).length !== 2) {
    throw new Error('History display projection must contain two independently verified changes');
  }
  if (fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs'))) {
    const bundleCandidates = findFilesContaining(runtimeDir, [
      'function projectAssistantTextFromMixedToolContent(',
      'function hasAssistantMixedToolVisibleText(',
      'type === "redacted_thinking"',
      'isAssistantTextContentType(type)',
    ]).filter(candidate => candidate.endsWith('gateway-bundle.mjs'));
    assertSingleFile(bundleCandidates, 'bundled chat history display projection');
  }
  return true;
}

module.exports = { applyPatch, verifyPatch, __testing: { PROJECT_MIXED_CONTENT } };
