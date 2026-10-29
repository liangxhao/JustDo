import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test } from 'vitest';

import { projectPersistedTimeline } from '../../../renderer/libs/openclaw-chat/model/timeline/project-history-timeline';
import type { GatewayMessage } from '../../../renderer/libs/openclaw-chat/types';
import { normalizeLegacyToolHistory, normalizeLegacyToolHistoryContent } from './legacyToolCompletion';

type Entry = Record<string, unknown>;
const header = { type: 'session', id: 'history-session', version: 3 };
const entry = (id: string, parentId: string | null, message: Entry): Entry => ({
  type: 'message', id, parentId, timestamp: '2026-01-01T00:00:00.000Z', message,
});
const call = (id: string, name = 'sessions_yield'): Entry => ({ type: 'toolCall', id, name, arguments: {} });
const result = (id: string, content: unknown = [], extras: Entry = {}): Entry => ({
  role: 'toolResult', toolCallId: id, toolName: 'sessions_yield', isError: false, content, ...extras,
});
const jsonl = (...entries: Entry[]) => [header, ...entries].map(value => JSON.stringify(value)).join('\n') + '\n';
const read = (content: string): Entry[] => content.trim().split('\n').map(line => JSON.parse(line));
function branch(content: string, leaf?: string): Entry[] {
  const entries = read(content);
  const byId = new Map(entries.filter(entry => entry.type !== 'session').map(entry => [String(entry.id), entry]));
  let current = leaf ?? String(entries.at(-1)!.id);
  const selected: Entry[] = [];
  while (current) {
    const item = byId.get(current)!;
    if (item.type === 'leaf') { current = item.targetId as string; continue; }
    selected.push(item);
    current = item.parentId as string;
  }
  return selected.reverse();
}
function tools(entries: Entry[]) {
  const timeline = projectPersistedTimeline(entries.flatMap(item => item.type === 'message'
    ? [item.message as GatewayMessage] : []), []);
  return timeline.flatMap(item => item.kind === 'process-summary' ? item.items.filter(item => item.type === 'tool')
    : item.kind === 'live-process' ? [item.item].filter(item => item.type === 'tool') : []);
}

test('dangling tools end before later frames and user epochs without losing original final content', () => {
  const original = jsonl(
    entry('first', null, { role: 'assistant', content: [call('read', 'read')] }),
    entry('middle', 'first', { role: 'assistant', content: [call('yield')] }),
    entry('answer', 'middle', { role: 'assistant', content: [{ type: 'text', text: 'Original final' }] }),
    entry('user', 'answer', { role: 'user', content: 'Next question' }),
  );
  const normalized = normalizeLegacyToolHistoryContent(original);
  expect(tools(branch(normalized)).map(tool => tool.status)).toEqual(['failed', 'failed']);
  expect(read(normalized).find(item => item.id === 'answer')!.message).toEqual(read(original)[3].message);
  for (const item of read(normalized).filter(item => String(item.id).startsWith('history-tool-result-'))) {
    expect(item.message).toMatchObject({ isError: true,
      details: { openclawSyntheticMissingToolResult: true, reason: 'missing_tool_result' } });
    expect(item).not.toHaveProperty('executionSettled');
  }
  expect(normalizeLegacyToolHistoryContent(normalized)).toBe(normalized);
});

test('empty Yield results honor output precedence, retain real content and canonically close phase:error', () => {
  const original = jsonl(
    entry('call', null, { role: 'assistant', content: [call('yield')] }),
    entry('result', 'call', result('yield', [], { result: '' })),
    entry('final', 'result', { role: 'assistant', content: 'Final' }),
  );
  const normalized = normalizeLegacyToolHistoryContent(original);
  expect(tools(branch(normalized))).toMatchObject([{ status: 'failed' }]);
  expect(read(normalized).find(item => item.id === 'result')!.message).not.toHaveProperty('result');
  const real = jsonl(entry('call', null, { role: 'assistant', content: [call('yield')] }),
    entry('result', 'call', result('yield', [{ type: 'text', text: 'Actual result' }], { result: '' })));
  const realNormalized = normalizeLegacyToolHistoryContent(real);
  expect(tools(branch(realNormalized))).toMatchObject([{ status: 'completed', output: 'Actual result' }]);
  const phaseError = jsonl(entry('call', null, { role: 'assistant', content: [call('yield')] }),
    entry('result', 'call', result('yield', [], { phase: 'error' })));
  expect(tools(branch(normalizeLegacyToolHistoryContent(phaseError)))).toMatchObject([{ status: 'failed' }]);
  for (const extras of [{ error: '   ' }, { error: 1 }, { isError: false, is_error: true }]) {
    const empty = jsonl(entry('call', null, { role: 'assistant', content: [call('yield')] }),
      entry('result', 'call', result('yield', [], extras)));
    expect(tools(branch(normalizeLegacyToolHistoryContent(empty)))).toMatchObject([{ status: 'failed' }]);
  }
});

test.each([false, true])('a missing sibling branch does not pollute a genuine result (failed: %s)', failed => {
  const original = jsonl(
    entry('call', null, { role: 'assistant', content: [call('same')] }),
    entry('real', 'call', result('same', [{ type: 'text', text: 'Genuine output' }], { isError: failed })),
    entry('success', 'real', { role: 'assistant', content: 'Successful final' }),
    entry('missing', 'call', { role: 'assistant', content: 'Other final' }),
    { type: 'leaf', id: 'selected', parentId: 'missing', targetId: 'success', appendParentId: 'success' },
  );
  const normalized = normalizeLegacyToolHistoryContent(original);
  expect(tools(branch(normalized))).toMatchObject([{ status: failed ? 'failed' : 'completed', output: 'Genuine output' }]);
  expect(tools(branch(normalized))).toHaveLength(1);
  expect(tools(branch(normalized, 'missing'))).toMatchObject([{ status: 'failed' }]);
  expect(read(normalized).find(item => item.id === 'selected')).toEqual(read(original).at(-1));
  expect(read(normalized).find(item => item.id === 'real')).toEqual(read(original)[2]);
  expect(normalizeLegacyToolHistoryContent(normalized)).toBe(normalized);
});

test('a leaf selecting an unresolved ancestor gets its own result branch without modifying a genuine child', () => {
  const original = jsonl(
    entry('call', null, { role: 'assistant', content: [call('yield')] }),
    entry('real', 'call', result('yield', [{ type: 'text', text: 'Genuine output' }])),
    entry('answer', 'real', { role: 'assistant', content: 'Genuine final' }),
    { type: 'leaf', id: 'select-call', parentId: 'answer', targetId: 'call', appendParentId: 'call' },
  );
  const normalized = normalizeLegacyToolHistoryContent(original);
  expect(tools(branch(normalized))).toMatchObject([{ status: 'failed' }]);
  expect(tools(branch(normalized, 'answer'))).toMatchObject([{ status: 'completed', output: 'Genuine output' }]);
  expect(tools(branch(normalized, 'answer'))).toHaveLength(1);
  expect(read(normalized).find(item => item.id === 'real')).toEqual(read(original)[2]);
  const selection = read(normalized).find(item => item.id === 'select-call')!;
  expect(selection.parentId).toBe('answer');
  expect(selection.targetId).toBe(selection.appendParentId);
  expect(normalizeLegacyToolHistoryContent(normalized)).toBe(normalized);
});

test('a genuine side result does not block closing the visible tool path without a leaf control', () => {
  const original = jsonl(
    entry('call', null, { role: 'assistant', content: [call('yield')] }),
    { ...entry('side-result', 'call', result('yield', 'Actual side result')), appendMode: 'side' },
  );
  const normalized = normalizeLegacyToolHistoryContent(original);
  expect(tools(branch(normalized))).toMatchObject([{ status: 'failed' }]);
  expect(read(normalized).find(item => item.id === 'side-result')).toEqual(read(original)[2]);
  expect(tools(branch(normalized, 'side-result')))
    .toMatchObject([{ status: 'completed', output: 'Actual side result' }]);
  expect(read(normalized).at(-1)).not.toHaveProperty('appendMode');
  expect(normalizeLegacyToolHistoryContent(normalized)).toBe(normalized);
});

test('visible-path closure retains a separate missing side call sharing the final insertion slot', () => {
  const original = jsonl(
    entry('call', null, { role: 'assistant', content: [call('yield'), call('read', 'read')] }),
    { ...entry('side-result', 'call', result('yield', 'Actual side result')), appendMode: 'side' },
    { ...entry('side-call', 'call', { role: 'assistant', content: [call('side-read', 'read')] }), appendMode: 'side' },
  );
  const normalized = normalizeLegacyToolHistoryContent(original);
  expect(tools(branch(normalized))).toHaveLength(2);
  expect(tools(branch(normalized)).every(tool => tool.status !== 'running')).toBe(true);
  const sideMissing = read(normalized).find(item =>
    (item.message as Entry | undefined)?.toolCallId === 'side-read' && item.id !== 'side-call');
  expect(sideMissing).toMatchObject({ appendMode: 'side', message: { isError: true } });
  expect(read(normalized).find(item => item.id === 'side-result')!.message).toEqual(read(original)[2].message);
  expect(tools(branch(normalized, 'side-result')).find(tool => tool.toolCallId === 'yield'))
    .toMatchObject({ status: 'completed', output: 'Actual side result' });
  expect(normalizeLegacyToolHistoryContent(normalized)).toBe(normalized);
});

test('snake-case metadata identities and tool names close result-only historical Yield records', () => {
  const original = jsonl(entry('result', null, {
    role: 'toolResult', metadata: { tool_call_id: 'snake-yield', tool_name: 'sessions_yield' }, content: [],
  }));
  const normalized = normalizeLegacyToolHistoryContent(original);
  expect(tools(branch(normalized)))
    .toMatchObject([{ toolCallId: 'snake-yield', name: 'sessions_yield', status: 'failed' }]);
  expect(normalizeLegacyToolHistoryContent(normalized)).toBe(normalized);
});

test('reused call IDs in different frames and branches do not borrow unrelated results', () => {
  const original = jsonl(
    entry('first', null, { role: 'assistant', content: [call('reused')] }),
    entry('user', 'first', { role: 'user', content: 'Next' }),
    entry('second', 'user', { role: 'assistant', content: [call('reused')] }),
    entry('real', 'second', result('reused', [{ type: 'text', text: 'Second output' }])),
  );
  expect(tools(branch(normalizeLegacyToolHistoryContent(original))))
    .toMatchObject([{ status: 'failed' }, { status: 'completed', output: 'Second output' }]);
});

test('string identities named null or undefined do not rewrite absent or null parent references', () => {
  for (const id of ['null', 'undefined']) {
    const explicitRoot = entry(id, null, { role: 'assistant', content: [call('yield')] });
    const parentlessRoot = { type: 'message', id, message: explicitRoot.message };
    for (const root of [explicitRoot, parentlessRoot]) {
      const normalized = normalizeLegacyToolHistoryContent(jsonl(root));
      const originalRoot = read(normalized).find(item => item.id === id)!;
      if (Object.hasOwn(root, 'parentId')) expect(originalRoot.parentId).toBeNull();
      else expect(originalRoot).not.toHaveProperty('parentId');
      expect(tools(branch(normalized))).toMatchObject([{ status: 'failed' }]);
      expect(normalizeLegacyToolHistoryContent(normalized)).toBe(normalized);
    }
  }
});

test('nested result blocks close calls while true failure/cancellation and closed file bytes stay unchanged', () => {
  for (const extras of [{ isError: true }, { phase: 'cancelled' }, { status: 'failed' }, { status: 'blocked' }]) {
    const original = jsonl(entry('call', null, { role: 'assistant', content: [call('yield')] }),
      entry('result', 'call', result('yield', [{ type: 'text', text: 'Original detail' }], extras)));
    expect(normalizeLegacyToolHistoryContent(original.replaceAll('\n', '\r\n'))).toBe(original.replaceAll('\n', '\r\n'));
  }
  const nested = jsonl(entry('call', null, { role: 'assistant', content: [call('nested')] }),
    entry('result', 'call', { role: 'assistant', content: [{ type: 'tool_result', tool_use_id: 'nested', content: [] }] }));
  expect(tools(branch(normalizeLegacyToolHistoryContent(nested)))).toMatchObject([{ status: 'failed' }]);
});

test('ordinary empty successes and image-only results remain byte-for-byte intact', () => {
  for (const content of [[], '', [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }]]) {
    const original = jsonl(entry('call', null, { role: 'assistant', content: [call('read', 'read')] }),
      entry('result', 'call', { role: 'toolResult', toolCallId: 'read', toolName: 'read', isError: false, content }));
    expect(normalizeLegacyToolHistoryContent(original)).toBe(original);
  }
  const image = jsonl(entry('call', null, { role: 'assistant', content: [call('yield')] }),
    entry('result', 'call', result('yield', [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }])));
  expect(normalizeLegacyToolHistoryContent(image)).toBe(image);
});

test('parentless v2/v3/v4 linear records are repaired deterministically', () => {
  for (const version of [2, 3, 4]) {
    const original = [JSON.stringify({ ...header, version }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: [call('yield')] } }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'Final' } }), ''].join('\n');
    const normalized = normalizeLegacyToolHistoryContent(original);
    const entries = read(normalized);
    const messages = entries.filter(item => item.type === 'message').map(item => item.message as GatewayMessage);
    expect(tools(entries).map(tool => tool.status)).toEqual(['failed']);
    expect(messages.at(-1)!.content).toBe('Final');
    expect(normalizeLegacyToolHistoryContent(normalized)).toBe(normalized);
  }
});

test('side append, reset and compaction anchors retain their identities and do not capture new epochs', () => {
  const original = jsonl(
    entry('call', null, { role: 'assistant', content: [call('yield')] }),
    { type: 'custom', id: 'side', parentId: 'call', appendMode: 'side', customType: 'progress' },
    { type: 'compaction', id: 'compact', parentId: 'side', firstKeptEntryId: 'call', summary: 'Summary', tokensBefore: 1 },
    { type: 'reset', id: 'reset', parentId: 'compact', reason: 'new' },
    entry('final', 'reset', { role: 'assistant', content: 'New final' }),
  );
  const normalized = normalizeLegacyToolHistoryContent(original);
  expect(read(normalized).find(item => item.id === 'compact')!.firstKeptEntryId).toBe('call');
  expect(read(normalized).find(item => item.id === 'side')!.appendMode).toBe('side');
  expect(tools(branch(normalized))).toMatchObject([{ status: 'failed' }]);
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
test('file repair is atomic, does not touch an untouched file, and rejects conflicting identities without overwriting input', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'history-tools-'));
  roots.push(directory);
  const file = path.join(directory, 'history.jsonl');
  const plain = jsonl(entry('plain', null, { role: 'assistant', content: 'Plain' }));
  fs.writeFileSync(file, plain);
  const before = fs.statSync(file).mtimeMs;
  normalizeLegacyToolHistory(file);
  expect(fs.readFileSync(file, 'utf8')).toBe(plain);
  expect(fs.statSync(file).mtimeMs).toBe(before);
  const broken = jsonl(entry('same', null, { role: 'assistant', content: [call('yield')] }),
    entry('same', null, { role: 'assistant', content: 'Conflicting identity' }));
  fs.writeFileSync(file, broken);
  expect(() => normalizeLegacyToolHistory(file)).toThrow(/conflicting duplicate entry identity/);
  expect(fs.readFileSync(file, 'utf8')).toBe(broken);
  fs.writeFileSync(file, jsonl(entry('call', null, { role: 'assistant', content: [call('yield')] })));
  normalizeLegacyToolHistory(file);
  const once = fs.readFileSync(file, 'utf8');
  normalizeLegacyToolHistory(file);
  expect(fs.readFileSync(file, 'utf8')).toBe(once);
  const legacy = JSON.stringify({ ...header, version: 1 }) + '\n' +
    JSON.stringify(entry('call', null, { role: 'assistant', content: [call('yield')] })) + '\n';
  expect(() => normalizeLegacyToolHistoryContent(legacy)).toThrow(/versions 2, 3 and 4 only/);
  const indexed = jsonl(entry('call', null, { role: 'assistant', content: [call('yield')] }),
    { type: 'compaction', id: 'compact', parentId: 'call', firstKeptEntryIndex: 1 });
  expect(() => normalizeLegacyToolHistoryContent(indexed)).toThrow(/index-based legacy compaction/);
});

test('ambiguous same-frame IDs and unsupported roles fail without guessing tool ownership', () => {
  const duplicate = jsonl(entry('call', null, { role: 'assistant', content: [call('same'), call('same')] }),
    entry('result', 'call', result('same', [{ type: 'text', text: 'Only one actual result' }])));
  expect(() => normalizeLegacyToolHistoryContent(duplicate)).toThrow(/within one assistant frame/);
  for (const role of ['tool_call', 'functioncall']) {
    const standalone = jsonl(entry('call', null, { role, id: 'yield', name: 'sessions_yield', input: {} }));
    expect(() => normalizeLegacyToolHistoryContent(standalone)).toThrow(/standalone legacy tool roles/);
  }
  const whitespace = jsonl(entry('call', null, { role: 'assistant', content: [call(' padded-id ')] }));
  expect(() => normalizeLegacyToolHistoryContent(whitespace)).toThrow(/whitespace in native identities/);
  const paddedParent = jsonl(entry('call', null, { role: 'assistant', content: [call('yield')] }),
    entry('final', ' call ', { role: 'assistant', content: 'Final' }));
  expect(() => normalizeLegacyToolHistoryContent(paddedParent)).toThrow(/whitespace in native identities/);
});

test('standalone legacy tool-use roles and function results preserve completed history and close missing results', () => {
  for (const role of ['tooluse', 'tool_use']) {
    const standalone = entry('call', null, { role, id: 'yield', name: 'sessions_yield', input: {} });
    const complete = jsonl(standalone, entry('result', 'call', {
      role: 'function', toolCallId: 'yield', name: 'sessions_yield', content: 'Actual function result',
    }));
    expect(normalizeLegacyToolHistoryContent(complete)).toBe(complete);
    const missing = jsonl(standalone, entry('final', 'call', { role: 'assistant', content: 'Final' }));
    expect(tools(branch(normalizeLegacyToolHistoryContent(missing)))).toMatchObject([{ status: 'failed' }]);
    const empty = jsonl(standalone, entry('result', 'call', {
      role: 'function', toolCallId: 'yield', name: 'sessions_yield', content: [],
    }));
    expect(tools(branch(normalizeLegacyToolHistoryContent(empty)))).toMatchObject([{ status: 'failed' }]);
  }
});
