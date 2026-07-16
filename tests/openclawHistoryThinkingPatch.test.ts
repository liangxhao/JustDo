import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

const { applyPatch } =
  require('../scripts/patches/v2026.6.11/005-history-thinking-and-subagent-yield.cjs') as {
    applyPatch: (runtimeDir: string) => string[];
  };

const HISTORY_PROJECTION = `function projectAssistantTextFromMixedToolContent(content, maxChars) {
\tif (!content.some((block) => {
\t\tif (!block || typeof block !== "object") return false;
\t\treturn isToolHistoryBlockType(block.type);
\t})) return null;
\tconst textBlocks = [];
\tfor (const block of content) {
\t\tif (!block || typeof block !== "object") continue;
\t\tconst entry = block;
\t\tif (entry.type !== "text" || typeof entry.text !== "string" || !entry.text.trim()) continue;
\t\tconst truncated = truncateChatHistoryText(stripInlineDirectiveTagsForDisplay(entry.text).text, maxChars);
\t\tif (truncated.text.trim()) textBlocks.push({
\t\t\ttype: "text",
\t\t\ttext: truncated.text
\t\t});
\t}
\treturn textBlocks.length > 0 ? {
\t\tcontent: textBlocks,
\t\tchanged: true
\t} : null;
}`;

const DELIVERY_EVIDENCE = `function hasCommittedOutboundDeliveryEvidence(result) {
\treturn hasMessagingToolDeliveryEvidence(result) || Array.isArray(result.acceptedSessionSpawns) && hasAcceptedSessionSpawn(result.acceptedSessionSpawns) || hasPositiveNumber(result.successfulCronAdds);
}`;

test('preserves history thinking blocks and treats sessions_yield as delivery evidence', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-history-patch-'));
  try {
    fs.mkdirSync(path.join(runtimeDir, 'dist'));
    fs.writeFileSync(
      path.join(runtimeDir, 'dist', 'runtime.js'),
      `${HISTORY_PROJECTION}\n${DELIVERY_EVIDENCE}`,
      'utf8',
    );

    expect(applyPatch(runtimeDir)).toEqual([path.join('dist', 'runtime.js')]);
    const patched = fs.readFileSync(path.join(runtimeDir, 'dist', 'runtime.js'), 'utf8');

    expect(patched).toContain('const displayBlocks = []');
    expect(patched).toContain('entry.type === "thinking"');
    expect(patched).toContain('result.meta.toolSummary.tools.includes("sessions_yield")');
    expect(applyPatch(runtimeDir)).toEqual([]);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('does not retry visible stops based on usage metadata', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-history-patch-'));
  try {
    fs.mkdirSync(path.join(runtimeDir, 'dist'));
    fs.writeFileSync(
      path.join(runtimeDir, 'dist', 'runtime.js'),
      `function isZeroOrMissingUsageSnapshot(usage) {
  return usage == null || hasZeroTokenUsageSnapshot(usage);
}
function isZeroUsageEmptyStopAssistantTurn(message2) {
  return Boolean(message2 && message2.stopReason === "stop" && Array.isArray(message2.content) && (message2.content.length === 0 || hasOnlyAssistantReasoningContent(message2)) && hasZeroTokenUsageSnapshot(message2.usage));
}
function isZeroUsageVisibleStopAssistantTurn(message2) {
  return Boolean(message2 && message2.stopReason === "stop" && Array.isArray(message2.content) && message2.content.some((block3) => block3 && typeof block3 === "object" && isAssistantTextContentType(block3.type) && typeof block3.text === "string" && block3.text.trim()) && isZeroOrMissingUsageSnapshot(message2.usage));
}
function resolveZeroUsageVisibleStopRetryInstruction(params) {
  if (params.timedOut) return null;
  return "The previous attempt recorded a partial assistant sentence with zero or missing model token usage before taking the next action.";
}
const retryInstruction = "The previous attempt recorded a partial assistant sentence with zero or missing model token usage before taking the next action.";
const retryLog = "zero/missing-usage visible stop";`,
      'utf8',
    );

    expect(applyPatch(runtimeDir)).toEqual([path.join('dist', 'runtime.js')]);
    const patched = fs.readFileSync(path.join(runtimeDir, 'dist', 'runtime.js'), 'utf8');

    expect(patched).not.toContain('isZeroOrMissingUsageSnapshot');
    expect(patched).toContain(
      'function isZeroUsageVisibleStopAssistantTurn(message2) {\n  return false;\n}',
    );
    expect(patched).toContain('zero model token usage');
    expect(patched).toContain('zero-usage visible stop');
    expect(patched.match(/function resolveZeroUsageVisibleStopRetryInstruction/g)).toHaveLength(1);
    expect(applyPatch(runtimeDir)).toEqual([]);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});
