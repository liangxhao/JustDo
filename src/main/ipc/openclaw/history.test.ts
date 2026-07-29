import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test, vi } from 'vitest';

import {
  collectCompactionDetailsFromFiles,
  collectToolInputsFromFiles,
  collectToolInputsFromValue,
  fetchPagedHistoryFromGateway,
  normalizeCompactionEntryIds,
  readCachedCompactionDetails,
  resolveSessionTranscriptFiles,
} from './history';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map(directory =>
      fs.promises.rm(directory, { recursive: true, force: true }),
    ),
  );
});

test('collects and parses nested OpenClaw tool inputs', () => {
  const found: Record<string, { name?: string; input: unknown }> = {};

  collectToolInputsFromValue(
    {
      message: {
        content: [
          {
            type: 'tool_call',
            toolCallId: 'call-1',
            name: 'shell',
            arguments: '{"command":"pwd"}',
          },
        ],
      },
    },
    new Set(['call-1']),
    found,
  );

  expect(found).toEqual({
    'call-1': {
      name: 'shell',
      input: { command: 'pwd' },
    },
  });
});

test('ignores unrelated and empty tool inputs', () => {
  const found: Record<string, { name?: string; input: unknown }> = {};

  collectToolInputsFromValue(
    {
      messages: [
        { type: 'tool_call', id: 'other', input: { value: true } },
        { type: 'tool_call', id: 'call-2', input: '{}' },
      ],
    },
    new Set(['call-2']),
    found,
  );

  expect(found).toEqual({});
});

test('fetches one bounded gateway history page and preserves its cursor', async () => {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    const body = {
      messages: [{ role: 'assistant', content: 'recent' }],
      hasMore: true,
      nextCursor: '2',
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const page = await fetchPagedHistoryFromGateway({
    sessionKey: 'agent:main:justdo:session-1',
    port: 42871,
    token: 'token-1',
    limit: 250,
    fetchImpl: fetchImpl as typeof fetch,
  });

  expect(calls).toEqual([
    'http://127.0.0.1:42871/sessions/agent%3Amain%3Ajustdo%3Asession-1/history?limit=250',
  ]);
  expect(page).toEqual({
    messages: [{ role: 'assistant', content: 'recent' }],
    hasMore: true,
    nextCursor: '2',
  });
});

test('resolves and reads Tool inputs only from the selected session identity', async () => {
  const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'justdo-history-'));
  temporaryDirectories.push(stateDir);
  const sessionsDir = path.join(stateDir, 'agents', 'main', 'sessions');
  await fs.promises.mkdir(sessionsDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(sessionsDir, 'sessions.json'),
    JSON.stringify({
      'agent:main:justdo:session-1': { sessionId: 'sid-1' },
      'agent:main:justdo:session-2': { sessionId: 'sid-2' },
    }),
  );
  const toolLine = (command: string) =>
    `${JSON.stringify({
      message: {
        content: [{ type: 'tool_call', id: 'same-call', name: 'exec', input: { command } }],
      },
    })}\n`;
  await fs.promises.writeFile(path.join(sessionsDir, 'sid-1.jsonl'), toolLine('safe-session'));
  await fs.promises.writeFile(path.join(sessionsDir, 'sid-2.jsonl'), toolLine('other-session'));

  const files = await resolveSessionTranscriptFiles(
    stateDir,
    'agent:main:justdo:session-1',
  );
  const inputs = await collectToolInputsFromFiles(files, new Set(['same-call']));

  expect(files).toEqual([path.join(sessionsDir, 'sid-1.jsonl')]);
  expect(inputs).toEqual({
    'same-call': { name: 'exec', input: { command: 'safe-session' } },
  });
});

test('reads compaction summaries by entry id from the selected session transcript', async () => {
  const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'justdo-history-'));
  temporaryDirectories.push(stateDir);
  const sessionsDir = path.join(stateDir, 'agents', 'main', 'sessions');
  await fs.promises.mkdir(sessionsDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(sessionsDir, 'sessions.json'),
    JSON.stringify({ 'agent:main:justdo:session-1': { sessionId: 'sid-1' } }),
  );
  await fs.promises.writeFile(
    path.join(sessionsDir, 'sid-1.jsonl'),
    [
      JSON.stringify({
        type: 'compaction',
        id: 'compaction-entry-1',
        summary: 'Continue from the retained implementation state.',
        tokensBefore: 12_000,
      }),
      JSON.stringify({
        type: 'compaction',
        id: 'unrequested-entry',
        summary: 'Must not be returned.',
      }),
    ].join('\n'),
  );

  const files = await resolveSessionTranscriptFiles(
    stateDir,
    'agent:main:justdo:session-1',
  );
  const details = await collectCompactionDetailsFromFiles(
    files,
    new Set(['compaction-entry-1']),
  );

  expect(details).toEqual({
    'compaction-entry-1': {
      summary: 'Continue from the retained implementation state.',
      tokensBefore: 12_000,
    },
  });
});

test('closes the transcript stream after finding all requested compaction entries', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'justdo-history-'));
  temporaryDirectories.push(directory);
  const transcript = path.join(directory, 'session.jsonl');
  await fs.promises.writeFile(
    transcript,
    `${JSON.stringify({
      type: 'compaction',
      id: 'compaction-entry-1',
      summary: 'Recovered summary.',
    })}\n${JSON.stringify({ type: 'message', content: 'x'.repeat(5 * 1024 * 1024) })}\n`,
  );
  const createReadStream = vi.spyOn(fs, 'createReadStream');

  await collectCompactionDetailsFromFiles(
    [transcript],
    new Set(['compaction-entry-1']),
  );

  const stream = createReadStream.mock.results[0]?.value as fs.ReadStream;
  const transcriptSize = (await fs.promises.stat(transcript)).size;
  expect(stream.destroyed).toBe(true);
  expect(stream.bytesRead).toBeLessThan(transcriptSize);
});

test('scans only appended transcript bytes after caching hits and misses', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'justdo-history-'));
  temporaryDirectories.push(directory);
  const transcript = path.join(directory, 'session.jsonl');
  await fs.promises.writeFile(
    transcript,
    `${JSON.stringify({
      type: 'compaction',
      id: 'compaction-entry-1',
      summary: 'Cached summary.',
    })}\n`,
  );
  const initialSize = (await fs.promises.stat(transcript)).size;
  const createReadStream = vi.spyOn(fs, 'createReadStream');
  const cacheKey = `test-cache-${directory}`;

  await readCachedCompactionDetails(
    cacheKey,
    [transcript],
    new Set(['compaction-entry-1', 'missing-entry']),
  );
  expect(createReadStream).toHaveBeenCalledTimes(1);

  await readCachedCompactionDetails(
    cacheKey,
    [transcript],
    new Set(['compaction-entry-1', 'missing-entry']),
  );
  expect(createReadStream).toHaveBeenCalledTimes(1);

  await fs.promises.appendFile(
    transcript,
    `${JSON.stringify({ type: 'message', content: 'new turn' })}\n`,
  );
  await readCachedCompactionDetails(
    cacheKey,
    [transcript],
    new Set(['compaction-entry-1', 'missing-entry']),
  );
  expect(createReadStream).toHaveBeenCalledTimes(2);
  expect(createReadStream.mock.calls[1]?.[1]).toEqual(
    expect.objectContaining({ start: initialSize }),
  );
  const appendedStream = createReadStream.mock.results[1]?.value as fs.ReadStream;
  expect(appendedStream.bytesRead).toBeLessThan(initialSize);
  expect(
    createReadStream.mock.results.every(result => (result.value as fs.ReadStream).destroyed),
  ).toBe(true);
});

test('invalidates cached compaction details when a session switches transcripts', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'justdo-history-'));
  temporaryDirectories.push(directory);
  const firstTranscript = path.join(directory, 'first.jsonl');
  const secondTranscript = path.join(directory, 'second.jsonl');
  await fs.promises.writeFile(
    firstTranscript,
    `${JSON.stringify({
      type: 'compaction',
      id: 'old-entry',
      summary: 'Old generation summary.',
    })}\n`,
  );
  await fs.promises.writeFile(
    secondTranscript,
    `${JSON.stringify({
      type: 'compaction',
      id: 'new-entry',
      summary: 'New generation summary.',
    })}\n`,
  );
  const cacheKey = `test-cache-${directory}`;

  expect(
    await readCachedCompactionDetails(
      cacheKey,
      [firstTranscript],
      new Set(['old-entry']),
    ),
  ).toEqual({
    'old-entry': { summary: 'Old generation summary.' },
  });
  expect(
    await readCachedCompactionDetails(
      cacheKey,
      [secondTranscript],
      new Set(['old-entry', 'new-entry']),
    ),
  ).toEqual({
    'new-entry': { summary: 'New generation summary.' },
  });
});

test('rescans the committed prefix when an older compaction id is requested later', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'justdo-history-'));
  temporaryDirectories.push(directory);
  const transcript = path.join(directory, 'session.jsonl');
  await fs.promises.writeFile(
    transcript,
    [
      JSON.stringify({
        type: 'compaction',
        id: 'older-entry',
        summary: 'Older summary.',
      }),
      JSON.stringify({
        type: 'compaction',
        id: 'newer-entry',
        summary: 'Newer summary.',
      }),
    ].join('\n') + '\n',
  );
  const cacheKey = `test-cache-${directory}`;

  expect(
    await readCachedCompactionDetails(
      cacheKey,
      [transcript],
      new Set(['newer-entry']),
    ),
  ).toEqual({
    'newer-entry': { summary: 'Newer summary.' },
  });
  expect(
    await readCachedCompactionDetails(
      cacheKey,
      [transcript],
      new Set(['older-entry']),
    ),
  ).toEqual({
    'older-entry': { summary: 'Older summary.' },
  });
});

test('retries an incomplete UTF-8 compaction line until its CRLF terminator is complete', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'justdo-history-'));
  temporaryDirectories.push(directory);
  const transcript = path.join(directory, 'session.jsonl');
  const line = Buffer.from(
    JSON.stringify({
      type: 'compaction',
      id: 'split-entry',
      summary: '继续处理当前任务',
    }),
    'utf-8',
  );
  const multibyteStart = line.indexOf(Buffer.from('继', 'utf-8'));
  const splitAt = multibyteStart + 1;
  await fs.promises.writeFile(transcript, line.subarray(0, splitAt));
  const cacheKey = `test-cache-${directory}`;

  expect(
    await readCachedCompactionDetails(
      cacheKey,
      [transcript],
      new Set(['split-entry']),
    ),
  ).toEqual({});

  await fs.promises.appendFile(transcript, Buffer.concat([line.subarray(splitAt), Buffer.from('\r')]));
  expect(
    await readCachedCompactionDetails(
      cacheKey,
      [transcript],
      new Set(['split-entry']),
    ),
  ).toEqual({});

  await fs.promises.appendFile(transcript, '\n');
  expect(
    await readCachedCompactionDetails(
      cacheKey,
      [transcript],
      new Set(['split-entry']),
    ),
  ).toEqual({
    'split-entry': { summary: '继续处理当前任务' },
  });
});

test('invalidates a same-path cache when the scanned prefix is rewritten and regrown', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'justdo-history-'));
  temporaryDirectories.push(directory);
  const transcript = path.join(directory, 'session.jsonl');
  await fs.promises.writeFile(
    transcript,
    `${JSON.stringify({
      type: 'compaction',
      id: 'old-entry',
      summary: 'Old generation summary.',
    })}\n`,
  );
  const cacheKey = `test-cache-${directory}`;
  await readCachedCompactionDetails(cacheKey, [transcript], new Set(['old-entry']));

  await fs.promises.writeFile(
    transcript,
    `${JSON.stringify({
      type: 'compaction',
      id: 'new-entry',
      summary: 'New generation summary.',
    })}\n${JSON.stringify({ type: 'message', content: 'padding'.repeat(100) })}\n`,
  );

  expect(
    await readCachedCompactionDetails(
      cacheKey,
      [transcript],
      new Set(['old-entry', 'new-entry']),
    ),
  ).toEqual({
    'new-entry': { summary: 'New generation summary.' },
  });
});

test('bounds and deduplicates compaction detail entry ids', () => {
  expect(normalizeCompactionEntryIds([' entry-1 ', 'entry-1', '', 42])).toEqual({
    ids: ['entry-1'],
  });
  expect(normalizeCompactionEntryIds(Array.from({ length: 251 }, () => 'entry'))).toEqual({
    ids: [],
    error: 'Too many compaction entry IDs',
  });
  expect(normalizeCompactionEntryIds(['x'.repeat(257)])).toEqual({
    ids: [],
    error: 'Compaction entry ID is too long',
  });
});

test('limits reset fallback to archives of the same transcript', async () => {
  const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'justdo-history-'));
  temporaryDirectories.push(stateDir);
  const sessionsDir = path.join(stateDir, 'agents', 'main', 'sessions');
  await fs.promises.mkdir(sessionsDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(sessionsDir, 'sessions.json'),
    JSON.stringify({ 'agent:main:justdo:session-1': { sessionId: 'sid-1' } }),
  );
  await Promise.all([
    fs.promises.writeFile(path.join(sessionsDir, 'sid-1.jsonl'), ''),
    fs.promises.writeFile(path.join(sessionsDir, 'sid-1.jsonl.reset.2026-07-26'), ''),
    fs.promises.writeFile(path.join(sessionsDir, 'sid-2.jsonl.reset.2026-07-26'), ''),
  ]);

  const files = await resolveSessionTranscriptFiles(
    stateDir,
    'agent:main:justdo:session-1',
  );

  expect(files.map(file => path.basename(file)).sort()).toEqual([
    'sid-1.jsonl',
    'sid-1.jsonl.reset.2026-07-26',
  ]);
});

test('rejects unsafe agent ids before resolving a transcript directory', async () => {
  const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'justdo-history-'));
  temporaryDirectories.push(stateDir);

  await expect(
    resolveSessionTranscriptFiles(stateDir, 'agent:..:justdo:session-1'),
  ).resolves.toEqual([]);
  await expect(
    resolveSessionTranscriptFiles(stateDir, 'agent:main/other:justdo:session-1'),
  ).resolves.toEqual([]);
});
