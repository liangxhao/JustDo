import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

const { applyPatch, RETAINED_USER_HELPERS } =
  require('../scripts/patches/v2026.6.11/011-retain-user-messages-across-compaction.cjs') as {
    applyPatch: (runtimeDir: string) => string[];
    RETAINED_USER_HELPERS: string;
  };

const BUNDLE_FIXTURE = `function buildSessionContext(pathEntries) {
  const messages = [];
  if (compaction) {
    messages.push(asAgentMessage(createCompactionSummaryMessage(compaction.summary, compaction.tokensBefore, compaction.timestamp)));
  }
}
function prepareCompaction(pathEntries, settings2) {
  let previousSummary;
  let boundaryStart = 0;
  if (prevCompactionIndex >= 0) {
    const prevCompaction = pathEntries[prevCompactionIndex];
    previousSummary = prevCompaction.summary;
    const firstKeptEntryIndex = pathEntries.findIndex((entry) => entry.id === prevCompaction.firstKeptEntryId);
  }
  const messagesToSummarize = [];
  const turnPrefixMessages = [];
  const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);
  if (cutPoint.isSplitTurn) for (const msg of turnPrefixMessages) extractFileOpsFromMessage(msg, fileOps);
  return ok({
    firstKeptEntryId,
    messagesToSummarize,
    turnPrefixMessages,
    isSplitTurn: cutPoint.isSplitTurn,
    tokensBefore,
    previousSummary,
    fileOps,
  });
}
async function compactHarness() {
          const result = compactResult.value;
          const entryId = await this.session.appendCompaction(result.summary, result.firstKeptEntryId, result.tokensBefore, result.details, provided !== void 0);
          const entry = await this.session.getEntry(entryId);
          if (entry?.type === "compaction") await this.emitOwn({
            type: "session_compact",
            compactionEntry: entry,
            fromHook: provided !== void 0
          });
          return result;
}
async function runCompactionWork() {
        this.sessionManager.appendCompaction(compactionResult.summary, compactionResult.firstKeptEntryId, compactionResult.tokensBefore, compactionResult.details, fromExtension);
        return {
          status: "compacted",
          result: compactionResult
        };
}
function compactionSafeguardFixture(preparation) {
    const rawTurnPrefixMessages = preparation.turnPrefixMessages ?? [];
    let baseMessagesToSummarize = stripRuntimeContextCustomMessages(preparation.messagesToSummarize);
    let baseTurnPrefixMessages = stripRuntimeContextCustomMessages(rawTurnPrefixMessages);
}`;

type RetainedUserMessage = {
  content: string;
  timestamp: number;
};

const loadRetentionHelpers = (): {
  readRetainedUserMessages: (details: unknown) => RetainedUserMessage[];
  collectRetainedUserMessages: (
    existing: RetainedUserMessage[],
    messages: unknown[],
  ) => RetainedUserMessage[];
  collectRetainedUserMessagesForPreparation: (
    existing: RetainedUserMessage[],
    entries: unknown[],
    previousCompactionIndex: number,
  ) => RetainedUserMessage[];
  collectRecentUserMessagesForSummary: (
    entries: unknown[],
    firstKeptEntryId: string,
  ) => Array<{ role: string; content: string; timestamp: number }>;
  collectRecentMessagesForSummary: (entries: unknown[], firstKeptEntryId: string) => unknown[];
  sanitizeCompactionSummaryMessages: (messages: unknown[]) => unknown[];
  estimateRetainedUserTokens: (text: string) => number;
  resolveRetainedUserMessages: (compaction: unknown, entries: unknown[]) => RetainedUserMessage[];
  resolveRetainedUserMessagesForReplay: (
    compaction: unknown,
    entries: unknown[],
  ) => RetainedUserMessage[];
} =>
  new Function(
    `${RETAINED_USER_HELPERS}; return { readRetainedUserMessages, collectRetainedUserMessages, collectRetainedUserMessagesForPreparation, collectRecentUserMessagesForSummary, collectRecentMessagesForSummary, sanitizeCompactionSummaryMessages, estimateRetainedUserTokens, resolveRetainedUserMessages, resolveRetainedUserMessagesForReplay };`,
  )() as {
    readRetainedUserMessages: (details: unknown) => RetainedUserMessage[];
    collectRetainedUserMessages: (
      existing: RetainedUserMessage[],
      messages: unknown[],
    ) => RetainedUserMessage[];
    collectRetainedUserMessagesForPreparation: (
      existing: RetainedUserMessage[],
      entries: unknown[],
      previousCompactionIndex: number,
    ) => RetainedUserMessage[];
    collectRecentUserMessagesForSummary: (
      entries: unknown[],
      firstKeptEntryId: string,
    ) => Array<{ role: string; content: string; timestamp: number }>;
    collectRecentMessagesForSummary: (entries: unknown[], firstKeptEntryId: string) => unknown[];
    sanitizeCompactionSummaryMessages: (messages: unknown[]) => unknown[];
    estimateRetainedUserTokens: (text: string) => number;
    resolveRetainedUserMessages: (compaction: unknown, entries: unknown[]) => RetainedUserMessage[];
    resolveRetainedUserMessagesForReplay: (
      compaction: unknown,
      entries: unknown[],
    ) => RetainedUserMessage[];
  };

test('retains real user text through hook-provided and repeated compactions', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-compaction-retention-'));
  try {
    const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    fs.writeFileSync(bundlePath, BUNDLE_FIXTURE, 'utf8');

    expect(applyPatch(runtimeDir)).toEqual(['gateway-bundle.mjs']);
    const patched = fs.readFileSync(bundlePath, 'utf8');

    expect(patched).toContain('for (const retained of resolveRetainedUserMessages');
    expect(patched).toContain('retainedUserMessages: preparation.retainedUserMessages');
    expect(patched).toContain('appendRecentToTurnPrefix ? [] : recentMessagesForSummary');
    expect(patched).toContain('appendRecentToTurnPrefix ? recentMessagesForSummary : []');
    expect(patched).toContain('return persistedResult;');
    expect(patched).toContain(
      'this.sessionManager.appendCompaction(compactionResult.summary, compactionResult.firstKeptEntryId',
    );
    expect(patched.match(/retainedUserMessages: preparation\.retainedUserMessages/g)).toHaveLength(
      2,
    );
    expect(patched.match(/retainedUserMessagesComplete: true/g)).toHaveLength(2);
    expect(applyPatch(runtimeDir)).toEqual([]);

    const helperStart = patched.indexOf('var RETAINED_USER_MESSAGE_MAX_TOKENS = 2e4;');
    const contextStart = patched.indexOf('function buildSessionContext(pathEntries) {');
    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(contextStart).toBeGreaterThan(helperStart);
    const legacyPatched = `${patched.slice(0, helperStart)}var RETAINED_USER_MESSAGE_MAX_TOKENS = 2e4;\n${patched
      .slice(contextStart)
      .replace(
        'collectRetainedUserMessagesForPreparation(previousRetainedUserMessages, pathEntries, prevCompactionIndex)',
        'collectRetainedUserMessages(previousRetainedUserMessages, [...messagesToSummarize, ...turnPrefixMessages])',
      )
      .replace(
        '  const recentUserMessagesForSummary = collectRecentUserMessagesForSummary(pathEntries, firstKeptEntryId);\n',
        '',
      )
      .replace('    recentUserMessagesForSummary,\n', '')
      .replace(
        '  const recentMessagesForSummary = collectRecentMessagesForSummary(pathEntries, firstKeptEntryId);\n',
        '',
      )
      .replace('    recentMessagesForSummary,\n', '')
      .replace(
        `    const rawTurnPrefixMessages = preparation.turnPrefixMessages ?? [];
    const recentUserMessagesForSummary = Array.isArray(preparation.recentUserMessagesForSummary) ? preparation.recentUserMessagesForSummary : [];
    const recentMessagesForSummary = Array.isArray(preparation.recentMessagesForSummary) ? preparation.recentMessagesForSummary : recentUserMessagesForSummary;
    const appendRecentToTurnPrefix = preparation.isSplitTurn === true;
    let baseMessagesToSummarize = stripRuntimeContextCustomMessages(sanitizeCompactionSummaryMessages([...preparation.messagesToSummarize, ...(appendRecentToTurnPrefix ? [] : recentMessagesForSummary)]));`,
        `    const rawTurnPrefixMessages = preparation.turnPrefixMessages ?? [];
    let baseMessagesToSummarize = stripRuntimeContextCustomMessages(preparation.messagesToSummarize);`,
      )
      .replace(
        '    let baseTurnPrefixMessages = stripRuntimeContextCustomMessages(sanitizeCompactionSummaryMessages([...rawTurnPrefixMessages, ...(appendRecentToTurnPrefix ? recentMessagesForSummary : [])]));',
        '    let baseTurnPrefixMessages = stripRuntimeContextCustomMessages(rawTurnPrefixMessages);',
      )
      .replace(/,\n\s+retainedUserMessagesComplete: true/g, '')}`;
    fs.writeFileSync(bundlePath, legacyPatched, 'utf8');

    expect(applyPatch(runtimeDir)).toEqual(['gateway-bundle.mjs']);
    const upgraded = fs.readFileSync(bundlePath, 'utf8');
    expect(upgraded.match(/retainedUserMessagesComplete: true/g)).toHaveLength(2);
    expect(upgraded).toContain(
      'collectRetainedUserMessagesForPreparation(previousRetainedUserMessages, pathEntries, prevCompactionIndex)',
    );
    expect(upgraded).toContain('appendRecentToTurnPrefix ? recentMessagesForSummary : []');
    expect(applyPatch(runtimeDir)).toEqual([]);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }

  const { collectRetainedUserMessages, readRetainedUserMessages } = loadRetentionHelpers();
  const retained = collectRetainedUserMessages(
    [{ content: 'first request', timestamp: 1 }],
    [
      { role: 'assistant', content: 'not retained', timestamp: 2 },
      {
        role: 'user',
        content: [{ type: 'text', text: 'second request' }],
      },
    ],
  );

  expect(retained).toEqual([
    { content: 'first request', timestamp: 1 },
    { content: 'second request', timestamp: 0 },
  ]);
  expect(readRetainedUserMessages({ retainedUserMessages: retained })).toEqual(retained);
  expect(readRetainedUserMessages({ retainedUserMessages: [{ content: 42 }] })).toEqual([]);
});

test('recovers user originals from legacy compactions without retention metadata', () => {
  const { resolveRetainedUserMessages } = loadRetentionHelpers();
  const persisted = [{ content: 'survives transcript rotation', timestamp: 0 }];
  expect(
    resolveRetainedUserMessages(
      {
        firstKeptEntryId: 'kept-user',
        details: { retainedUserMessages: persisted },
      },
      [
        {
          type: 'message',
          id: 'kept-user',
          message: { role: 'user', content: 'recent tail only', timestamp: 2 },
        },
      ],
    ),
  ).toEqual(persisted);

  const entries = [
    {
      type: 'message',
      id: 'old-user',
      message: { role: 'user', content: 'recover this original request', timestamp: 1 },
    },
    {
      type: 'message',
      id: 'kept-user',
      message: { role: 'user', content: 'already in recent tail', timestamp: 2 },
    },
  ];

  expect(
    resolveRetainedUserMessages(
      {
        firstKeptEntryId: 'kept-user',
        details: { readFiles: [] },
      },
      entries,
    ),
  ).toEqual([{ content: 'recover this original request', timestamp: 1 }]);
  expect(
    resolveRetainedUserMessages(
      {
        firstKeptEntryId: 'kept-user',
        details: { retainedUserMessages: [] },
      },
      entries,
    ),
  ).toEqual([]);
});

test('retains recent-tail user originals before manual hardening drops tool results', () => {
  const {
    collectRecentUserMessagesForSummary,
    collectRetainedUserMessagesForPreparation,
    resolveRetainedUserMessagesForReplay,
  } = loadRetentionHelpers();
  const firstCompactionEntries = [
    {
      type: 'message',
      id: 'old-user',
      message: { role: 'user', content: 'old request', timestamp: 1 },
    },
    {
      type: 'message',
      id: 'large-tool-result',
      message: { role: 'toolResult', content: 'x'.repeat(50_000), timestamp: 2 },
    },
    {
      type: 'message',
      id: 'tail-user',
      message: { role: 'user', content: 'latest request verbatim', timestamp: 3 },
    },
  ];

  expect(collectRetainedUserMessagesForPreparation([], firstCompactionEntries, -1)).toEqual([
    { content: 'old request', timestamp: 1 },
    { content: 'latest request verbatim', timestamp: 3 },
  ]);
  expect(collectRecentUserMessagesForSummary(firstCompactionEntries, 'large-tool-result')).toEqual([
    {
      role: 'user',
      content: 'latest request verbatim',
      timestamp: 3,
    },
  ]);

  const previousRetained = [
    { content: 'old request', timestamp: 1 },
    { content: 'latest request verbatim', timestamp: 3 },
  ];
  const repeatedEntries = [
    ...firstCompactionEntries,
    {
      type: 'compaction',
      id: 'previous-compaction',
      firstKeptEntryId: 'tail-user',
      details: {
        retainedUserMessages: previousRetained,
        retainedUserMessagesComplete: true,
      },
    },
    {
      type: 'message',
      id: 'new-user',
      message: { role: 'user', content: 'new request', timestamp: 4 },
    },
  ];

  expect(collectRetainedUserMessagesForPreparation(previousRetained, repeatedEntries, 3)).toEqual([
    ...previousRetained,
    { content: 'new request', timestamp: 4 },
  ]);

  const automaticCompaction = repeatedEntries[3];
  expect(resolveRetainedUserMessagesForReplay(automaticCompaction, repeatedEntries)).toEqual([
    { content: 'old request', timestamp: 1 },
  ]);
  expect(
    resolveRetainedUserMessagesForReplay(
      {
        ...automaticCompaction,
        firstKeptEntryId: 'previous-compaction',
      },
      repeatedEntries,
    ),
  ).toEqual(previousRetained);

  const rebuildContextTexts = (entries: typeof repeatedEntries): string[] => {
    const compactionIndex = entries.findIndex(entry => entry.type === 'compaction');
    const compaction = entries[compactionIndex];
    const texts = resolveRetainedUserMessagesForReplay(compaction, entries).map(
      message => message.content,
    );
    texts.push('SUMMARY');
    let foundFirstKept = false;
    for (let index = 0; index < compactionIndex; index += 1) {
      const entry = entries[index];
      if (entry?.id === compaction?.firstKeptEntryId) foundFirstKept = true;
      if (foundFirstKept && entry?.type === 'message' && entry.message.role === 'user') {
        texts.push(String(entry.message.content));
      }
    }
    for (const entry of entries.slice(compactionIndex + 1)) {
      if (entry.type === 'message' && entry.message.role === 'user') {
        texts.push(String(entry.message.content));
      }
    }
    return texts;
  };

  const automaticTexts = rebuildContextTexts(repeatedEntries);
  expect(automaticTexts.filter(text => text === 'latest request verbatim')).toHaveLength(1);

  const manuallyHardenedEntries = repeatedEntries.map(entry =>
    entry.type === 'compaction'
      ? {
          ...entry,
          firstKeptEntryId: entry.id,
        }
      : entry,
  );
  const manualTexts = rebuildContextTexts(manuallyHardenedEntries);
  expect(manualTexts.filter(text => text === 'old request')).toHaveLength(1);
  expect(manualTexts.filter(text => text === 'latest request verbatim')).toHaveLength(1);
  expect(manualTexts).not.toContain('x'.repeat(50_000));
});

test('upgrades incomplete retention metadata with user messages from the old recent tail', () => {
  const { collectRetainedUserMessagesForPreparation } = loadRetentionHelpers();
  const previousRetained = [{ content: 'old request', timestamp: 1 }];
  const entries = [
    {
      type: 'message',
      id: 'old-user',
      message: { role: 'user', content: 'old request', timestamp: 1 },
    },
    {
      type: 'message',
      id: 'tail-user',
      message: { role: 'user', content: 'tail request', timestamp: 2 },
    },
    {
      type: 'compaction',
      id: 'previous-compaction',
      firstKeptEntryId: 'tail-user',
      details: { retainedUserMessages: previousRetained },
    },
    {
      type: 'message',
      id: 'new-user',
      message: { role: 'user', content: 'new request', timestamp: 3 },
    },
  ];

  expect(collectRetainedUserMessagesForPreparation(previousRetained, entries, 2)).toEqual([
    { content: 'old request', timestamp: 1 },
    { content: 'tail request', timestamp: 2 },
    { content: 'new request', timestamp: 3 },
  ]);
});

test('includes recent assistant replies and bounds tool output in summary input', () => {
  const { collectRecentMessagesForSummary, sanitizeCompactionSummaryMessages } =
    loadRetentionHelpers();
  const entries = [
    {
      type: 'message',
      id: 'kept-user',
      message: { role: 'user', content: 'latest request', timestamp: 1 },
    },
    {
      type: 'message',
      id: 'assistant-reply',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'reasoning used to reach the reply' },
          { type: 'text', text: 'latest assistant reply' },
        ],
        timestamp: 2,
      },
    },
    ...Array.from({ length: 5 }, (_, index) => ({
      type: 'message',
      id: `tool-${index}`,
      message: {
        role: 'toolResult',
        content: [{ type: 'text', text: `tool-${index}-start-${'x'.repeat(10_000)}-end` }],
        timestamp: index + 3,
      },
    })),
  ];

  const recent = collectRecentMessagesForSummary(entries, 'kept-user') as Array<{
    role: string;
    content: string | Array<{ type: string; text?: string; thinking?: string }>;
  }>;
  expect(recent.map(message => message.role)).toEqual([
    'user',
    'assistant',
    'toolResult',
    'toolResult',
    'toolResult',
    'toolResult',
    'toolResult',
  ]);

  const sanitized = sanitizeCompactionSummaryMessages(recent) as typeof recent;
  const assistant = sanitized.find(message => message.role === 'assistant');
  expect(JSON.stringify(assistant?.content)).toContain('latest assistant reply');
  expect(JSON.stringify(assistant?.content)).toContain('reasoning used to reach the reply');

  const toolTexts = sanitized
    .filter(message => message.role === 'toolResult')
    .map(message =>
      typeof message.content === 'string'
        ? message.content
        : message.content.map(part => part.text ?? '').join('\n'),
    );
  expect(toolTexts.every(text => text.length <= 6_000)).toBe(true);
  expect(toolTexts.reduce((total, text) => total + text.length, 0)).toBeLessThanOrEqual(24_000);
  expect(toolTexts[0]).toMatch(/earlier tool outputs omitted from summary input/);
  expect(toolTexts.at(-1)).toMatch(/^tool-4-start-/);
  expect(toolTexts.at(-1)).toMatch(/-end$/);

  const manyOutputs = Array.from({ length: 200 }, (_, index) =>
    index % 2 === 0
      ? {
          role: 'toolResult',
          content: `tool-${index}-${'x'.repeat(10_000)}`,
        }
      : {
          role: 'bashExecution',
          command: `command-${index}`,
          output: `bash-${index}-${'x'.repeat(10_000)}`,
        },
  );
  const manySanitized = sanitizeCompactionSummaryMessages(manyOutputs) as Array<{
    role: string;
    content?: string | Array<{ type: string; text: string }>;
    output?: string;
  }>;
  const totalToolChars = manySanitized.reduce((total, message) => {
    if (message.role === 'bashExecution') return total + (message.output?.length ?? 0);
    if (typeof message.content === 'string') return total + message.content.length;
    return total + (message.content?.reduce((sum, part) => sum + part.text.length, 0) ?? 0);
  }, 0);
  expect(totalToolChars).toBeLessThanOrEqual(24_000);
  expect(
    JSON.stringify(manySanitized).match(/earlier tool outputs omitted from summary input/g),
  ).toHaveLength(1);
});

test('keeps split-turn summary input in history-prefix-recent order', () => {
  const history = ['old-history'];
  const prefix = ['turn-user', 'assistant-tool-call'];
  const recent = ['tool-result', 'assistant-reply'];

  const appendRecentToTurnPrefix = true;
  const base = [...history, ...(appendRecentToTurnPrefix ? [] : recent)];
  const turnPrefix = [...prefix, ...(appendRecentToTurnPrefix ? recent : [])];

  expect([...base, ...turnPrefix]).toEqual([
    'old-history',
    'turn-user',
    'assistant-tool-call',
    'tool-result',
    'assistant-reply',
  ]);
});

test('caps retained user text at the Codex-style rolling budget', () => {
  const { collectRetainedUserMessages, estimateRetainedUserTokens } = loadRetentionHelpers();
  const oversized = `begin-${'x'.repeat(100_000)}-end`;
  const withinBudgetChinese = '你'.repeat(25_000);

  const retained = collectRetainedUserMessages(
    [],
    [{ role: 'user', content: oversized, timestamp: 1 }],
  );

  expect(retained).toHaveLength(1);
  expect(retained[0]?.content.length).toBeLessThan(oversized.length);
  expect(retained[0]?.content).toMatch(/^begin-/);
  expect(retained[0]?.content).toMatch(/-end$/);
  expect(retained[0]?.content).toMatch(/…\d+ tokens truncated…/);
  expect(estimateRetainedUserTokens(retained[0]?.content ?? '')).toBeLessThanOrEqual(20_000);
  expect(estimateRetainedUserTokens('你')).toBe(1);

  const nearlyFullNewest = 'n'.repeat((20_000 - 1) * 4);
  const oneTokenForOldest = collectRetainedUserMessages(
    [],
    [
      { role: 'user', content: oversized, timestamp: 1 },
      { role: 'user', content: nearlyFullNewest, timestamp: 2 },
    ],
  );
  expect(oneTokenForOldest).toHaveLength(2);
  expect(estimateRetainedUserTokens(oneTokenForOldest[0]?.content ?? '')).toBeLessThanOrEqual(1);
  expect(
    oneTokenForOldest.reduce(
      (total, message) => total + estimateRetainedUserTokens(message.content),
      0,
    ),
  ).toBeLessThanOrEqual(20_000);

  const retainedChinese = collectRetainedUserMessages(
    [],
    [{ role: 'user', content: withinBudgetChinese, timestamp: 2 }],
  );
  expect(retainedChinese).toEqual([{ content: withinBudgetChinese, timestamp: 2 }]);
});

test('fails loudly when the upstream compaction bundle shape changes', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-compaction-mismatch-'));
  try {
    fs.writeFileSync(
      path.join(runtimeDir, 'gateway-bundle.mjs'),
      'function buildSessionContextChanged() {}',
      'utf8',
    );

    expect(() => applyPatch(runtimeDir)).toThrow(/patch target not found/i);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});
