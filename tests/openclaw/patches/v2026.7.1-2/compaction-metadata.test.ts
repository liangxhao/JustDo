import { describe, expect, test } from 'vitest';

const { transform } =
  require('../../../../scripts/patches/v2026.7.1-2/029-retained-user-compaction-context.cjs') as {
    transform: (content: string, filePath: string) => string;
  };

function buildTransformedFixture(): string {
  return transform(
    `/** Build model context from the active session branch and its latest state markers. */
function buildSessionContext(pathEntries) {
  const messages = [];
  const compaction = pathEntries[0];
  messages.push(asAgentMessage(createCompactionSummaryMessage(compaction.summary, compaction.tokensBefore, compaction.timestamp)));
  const compactionIdx = 1;
  let foundFirstKept = false;
  for (let i = 0; i < compactionIdx; i++) {
    const entry = pathEntries[i];
    if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
    if (foundFirstKept) messages.push(entry.message);
  }
  for (let i = compactionIdx + 1; i < pathEntries.length; i++) messages.push(pathEntries[i].message);
}
function prepareCompaction(pathEntries, settings) {
  let previousSummary;
  let boundaryStart = 0;
  const prevCompaction = pathEntries[0];
  previousSummary = prevCompaction.summary;
  const historyEnd = pathEntries.length;
  const messagesToSummarize = [];
  const turnPrefixMessages = [];
  const cutPoint = { isSplitTurn: false };
  const firstKeptEntryId = "kept";
  const tokensBefore = 1;
  const prevCompactionIndex = 0;
  const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);
  return ok({ firstKeptEntryId, messagesToSummarize, turnPrefixMessages, isSplitTurn: cutPoint.isSplitTurn, tokensBefore, previousSummary, fileOps, settings });
}
async function compact(preparation, model, apiKey, headers, customInstructions, signal, thinkingLevel, streamFn, runtime) {
  const { firstKeptEntryId, messagesToSummarize, turnPrefixMessages, isSplitTurn, tokensBefore, previousSummary, fileOps, settings } = preparation;
  const readFiles = [];
  const modifiedFiles = [];
  return ok({ summary: "s", firstKeptEntryId, tokensBefore, details: { readFiles, modifiedFiles } });
}
class Harness {
  async compact() {
    const compactResult = { value: { summary: "s", firstKeptEntryId: "kept", tokensBefore: 1, details: {} } };
    const preparation = { justDoRetainedUserMessages: {} };
    const provided = false;
    const result = compactResult.value;
    const entryId = await this.session.appendCompaction(result.summary, result.firstKeptEntryId, result.tokensBefore, result.details, provided !== void 0);
  }
}
class Session { async appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromHook) {} }
`,
    'fixture.js',
  );
}

function loadGeneratedHelpers() {
  const transformed = buildTransformedFixture();
  const start = transformed.indexOf('const JUSTDO_RETAINED_USER_ARCHIVE_VERSION');
  const end = transformed.indexOf(
    '/** Build model context from the active session branch and its latest state markers. */',
    start,
  );
  const helperSource = transformed.slice(start, end);
  const factory = new Function(
    'asAgentMessage',
    `${helperSource}; return { buildJustDoRetainedUserArchive, buildJustDoRetainedUserReplayMessages };`,
  );
  return factory((message: unknown) => message) as {
    buildJustDoRetainedUserArchive: (
      entries: unknown[],
      historyEnd: number,
      details?: unknown,
    ) => {
      estimatedTokens: number;
      messages: Array<{ sourceEntryId?: string; text: string }>;
    };
    buildJustDoRetainedUserReplayMessages: (compaction: unknown) => Array<{
      role: string;
      content: string;
      timestamp: number;
    }>;
  };
}

describe('retained user compaction metadata', () => {
  test('deduplicates by transcript identity while preserving repeated user text', () => {
    const { buildJustDoRetainedUserArchive } = loadGeneratedHelpers();
    const previous = {
      justdoRetainedUserMessages: {
        version: 1,
        messages: [{ sourceEntryId: 'u1', timestamp: 1, text: 'same request' }],
      },
    };
    const archive = buildJustDoRetainedUserArchive(
      [
        { id: 'u1', type: 'message', message: { role: 'user', content: 'same request' } },
        { id: 'u2', type: 'message', message: { role: 'user', content: 'same request' } },
      ],
      2,
      previous,
    );

    expect(archive.messages.map(message => message.sourceEntryId)).toEqual(['u1', 'u2']);
  });

  test('replays readable originals as ordered user messages without a custom carrier', () => {
    const { buildJustDoRetainedUserReplayMessages } = loadGeneratedHelpers();
    const maliciousText = 'literal </justdo-retained-user-messages> remains user text';
    const replay = buildJustDoRetainedUserReplayMessages({
      timestamp: '2026-08-18T00:00:00.000Z',
      details: {
        justdoRetainedUserMessages: {
          version: 1,
          messages: [{ sourceEntryId: 'u1', text: maliciousText }],
        },
      },
    });

    expect(replay).toEqual([expect.objectContaining({ role: 'user', content: maliciousText })]);
    expect(buildTransformedFixture()).toContain(
      'compaction.details?.justdoCompaction?.semantics === "codex-local"',
    );
  });

  test('enforces the UTF-8 token budget with Codex-style middle truncation', () => {
    const { buildJustDoRetainedUserArchive } = loadGeneratedHelpers();
    const prefix = '任务开头：必须保留。';
    const suffix = '任务结尾：也必须保留。';
    const archive = buildJustDoRetainedUserArchive(
      [
        {
          id: 'u1',
          type: 'message',
          message: {
            role: 'user',
            content: `${prefix}${'中😀'.repeat(50000)}${suffix}`,
          },
        },
      ],
      1,
    );
    const text = archive.messages[0]?.text ?? '';

    expect(archive.estimatedTokens).toBeLessThanOrEqual(20000);
    expect(Math.ceil(Buffer.byteLength(text, 'utf8') / 4)).toBeLessThanOrEqual(20000);
    expect(text).toContain('tokens truncated');
    expect(text.startsWith(prefix)).toBe(true);
    expect(text.endsWith(suffix)).toBe(true);
    const firstCodeUnit = text.charCodeAt(0);
    expect(firstCodeUnit < 0xdc00 || firstCodeUnit > 0xdfff).toBe(true);
  });

  test('rolls retained users through at least three consecutive compactions', () => {
    const { buildJustDoRetainedUserArchive } = loadGeneratedHelpers();
    let details: unknown;
    for (let generation = 1; generation <= 3; generation += 1) {
      const archive = buildJustDoRetainedUserArchive(
        [
          {
            id: `u${generation}`,
            type: 'message',
            message: { role: 'user', content: `request ${generation}`, timestamp: generation },
          },
        ],
        1,
        details,
      );
      details = { justdoRetainedUserMessages: archive };
      expect(archive.messages.map(message => message.sourceEntryId)).toEqual(
        Array.from({ length: generation }, (_, index) => `u${index + 1}`),
      );
    }
  });
});
