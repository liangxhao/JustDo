import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { createSessionExportDocument } from '../../../shared/cowork/sessionExport';
import { writeSessionExportFile } from './sessionExportFile';

let directory: string;
let destination: string;
const session = {
  id: 'product-session',
  title: '对话示例',
  agentId: 'main',
  cwd: 'C:\\workspace',
  createdAt: 1,
  updatedAt: 2,
};
const exportedAt = new Date('2026-11-15T08:00:00Z');
const earlier = { role: 'user', content: '较早一页', __openclaw: { id: 'earlier' } };
const later = { role: 'assistant', content: 'later', __openclaw: { id: 'later' } };
const signal = new AbortController().signal;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'session-export-test-'));
  destination = path.join(directory, 'history.json');
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

test.each([true, false])('writes an indented single JSON in chat order (raw messages %s)', async includeRawData => {
  const document = { session, includeRawData, exportedAt, sessionKey: 'exact-key' };
  await writeSessionExportFile({
    destination,
    document,
    signal,
    assertCurrent: () => {},
    readHistory: async onPage => {
      await onPage([later]);
      await onPage([earlier]);
      return { runtimeSessionId: 'physical-id', model: 'model-id' };
    },
  });

  const expected = createSessionExportDocument({
    ...document,
    messages: [earlier, later],
    runtimeSessionId: 'physical-id',
    model: 'model-id',
  });
  expect(await fs.readFile(destination, 'utf8')).toBe(
    `${JSON.stringify({ ...expected, scope: 'main', exportedAt: exportedAt.toISOString() }, null, 2)}\n`,
  );
});

test('writes a complete export beyond the generic text dialog size limit', async () => {
  const page = [{ role: 'user', content: 'x'.repeat(500_000) }];
  const pageCount = 106;
  await writeSessionExportFile({
    destination,
    document: { session, includeRawData: false },
    signal,
    assertCurrent: () => {},
    readHistory: async onPage => {
      for (let index = 0; index < pageCount; index++) await onPage(page);
      return { runtimeSessionId: 'large-session' };
    },
  });

  expect((await fs.stat(destination)).size).toBeGreaterThan(50 * 1024 * 1024);
  const exported = JSON.parse(await fs.readFile(destination, 'utf8'));
  expect(exported.messages).toHaveLength(pageCount);
  expect(exported.messages.at(-1)).toEqual(page[0]);
});

test('preserves an existing file if the session changes before publication', async () => {
  await fs.writeFile(destination, 'original');
  let assertions = 0;

  await expect(writeSessionExportFile({
    destination,
    document: { session, includeRawData: true },
    signal,
    assertCurrent: () => {
      if (++assertions > 1) throw new Error('changed');
    },
    readHistory: async onPage => {
      await onPage([later]);
      return { runtimeSessionId: 'physical-id' };
    },
  })).rejects.toThrow('changed');

  expect(await fs.readFile(destination, 'utf8')).toBe('original');
  expect(await fs.readdir(directory)).toEqual(['history.json']);
});
