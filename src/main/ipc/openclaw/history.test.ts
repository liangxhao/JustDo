import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test } from 'vitest';

import {
  collectToolInputsFromFiles,
  collectToolInputsFromValue,
  fetchPagedHistoryFromGateway,
  resolveSessionTranscriptFiles,
} from './history';

const temporaryDirectories: string[] = [];

afterEach(async () => {
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
