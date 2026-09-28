import { expect, test } from 'vitest';

import type { ToolItem } from './chat-transcript-state';
import { fileToolCode, fileToolPatch } from './file-tool-presentation';
const tool = (name: string, input: unknown, output = ''): ToolItem => ({
  name,
  input,
  output,
  type: 'tool',
  status: 'completed',
  id: 't',
  toolCallId: 't',
  runId: 'r',
  firstSeq: 1,
  lastSeq: 2,
  startedAt: 1,
  updatedAt: 2,
});
test('renders only returned read content and leaves missing files as raw results', () => {
  const json = '{"kind":"text","content":"const x = 1;"}';
  expect(fileToolCode(tool('read', { path: 'a.json' }, json), true)?.text).toBe(json);
  expect(
    fileToolCode(
      { ...tool('read', { path: 'a.ts' }), presentation: { fileRead: { kind: 'not_found' } } },
      true,
    ),
  ).toBeNull();
  expect(
    fileToolCode({ ...tool('read', { path: 'a.ts' }, 'error'), status: 'failed' }, true),
  ).toBeNull();
});
test('supports verified core wrappers without matching third party suffixes', () => {
  expect(
    fileToolCode(
      tool('tool_call', { id: 'openclaw:core:write', args: { path: 'a.ts', content: '' } }),
      false,
    )?.text,
  ).toBe('');
  expect(
    fileToolCode(
      tool('tool_call', { id: 'third:write', args: { path: 'a.ts', content: 'x' } }),
      false,
    ),
  ).toBeNull();
});
test('groups patch operations without inventing deleted file contents', () => {
  const patch =
    '*** Begin Patch\n*** Add File: a.ts\n+hello\n*** Update File: b.ts\n*** Move to: c.ts\n@@\n-old\n+new\n*** Delete File: d.ts\n*** End Patch\n';
  expect(fileToolPatch(tool('apply_patch', { input: patch }))).toEqual([
    { path: 'a.ts', operation: 'Add', text: '+hello\n' },
    { path: 'b.ts', operation: 'Update', moveTo: 'c.ts', text: '@@\n-old\n+new\n' },
    { path: 'd.ts', operation: 'Delete', text: '' },
  ]);
  expect(
    fileToolPatch(tool('apply_patch', { input: patch.replace('*** Begin Patch', 'bad') })),
  ).toEqual([]);
  expect(fileToolPatch(tool('apply_patch', { input: patch.replace('*** End Patch', '') }))).toEqual(
    [],
  );
});

test('highlights the exact read output even when native details contain another projection', () => {
  const output = 'line one\r\nline two\n[truncated]';
  const read = { ...tool('read', { path: 'a.ts' }, output), presentation: { fileRead: { kind: 'truncated' as const, content: 'line one' } } };
  expect(fileToolCode(read, true)?.text).toBe(output);
});
