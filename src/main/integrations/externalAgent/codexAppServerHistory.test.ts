import { describe, expect, it } from 'vitest';

import type { SessionRunTiming } from '../../../shared/cowork/sessionRun';
import {
  assertCodexHistoryFullSize,
  type CodexHistoryItemEntry,
  type CodexHistoryTurn,
  paginateCodexHistoryItems,
  paginateCodexHistoryTurns,
  projectCodexHistory,
} from './codexAppServerHistory';
import type { ExternalAgentThreadHistory } from './externalAgentTypes';

const receipt = (index: number): SessionRunTiming => ({
  id: `private-receipt-${index}`,
  sessionId: 'private-product-session',
  clientTurnId: `turn-${index}`,
  rootRunId: `native-run-${index}`,
  startedAt: index * 1_000,
  endedAt: index * 1_000 + 900,
  state: 'completed',
});
const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLFsAAAAASUVORK5CYII=';
const message = (index: string, role: string, content: unknown, runId?: string) => ({
  role,
  content,
  __openclaw: { id: index, ...(runId ? { runId } : {}) },
});
const history = (): ExternalAgentThreadHistory => ({
  threadId: 'thread-one',
  identityRevision: 'opaque-physical-incarnation',
  runs: [receipt(1)],
  messages: [
    message('user-one', 'user', [{ type: 'text', text: 'Read this project' }], 'native-run-1'),
    message('assistant-process', 'assistant', [
      { type: 'thinking', thinking: 'Inspect the directory.' },
      { type: 'text', text: 'Checking the project.' },
      { type: 'toolCall', id: 'call-one', name: 'read_file', arguments: { path: 'README.md' } },
    ], 'native-run-1'),
    {
      ...message('tool-result', 'toolResult', [{ type: 'text', text: 'File content' }], 'native-run-1'),
      toolCallId: 'call-one', toolName: 'read_file', isError: false,
    },
    {
      ...message('assistant-final', 'assistant', [{ type: 'text', text: 'Project reviewed.' }], 'native-run-1'),
      phase: 'final_answer',
    },
  ],
});

describe('authenticated native history projection', () => {
  it('retains authenticated native managed images in order without opening their paths or losing image-only history', () => {
    const input = history();
    input.messages = [{
      role: 'user', content: '', __openclaw: {
        id: 'real-media', runId: 'native-run-1', media: [
          { path: '/native/media/first.png', contentType: 'image/png' },
          { path: '/native/media/second.png', url: '/api/media/authenticated-private-route', contentType: 'image/png' },
          { url: `data:image/png;base64,${imageBase64}`, contentType: 'image/png' },
        ],
      },
    }];
    expect(projectCodexHistory(input).turns[0].items[0].content).toEqual([
      { type: 'localImage', path: '/native/media/first.png' },
      { type: 'localImage', path: '/native/media/second.png' },
      { type: 'image', url: `data:image/png;base64,${imageBase64}` },
    ]);
  });

  it('rejects unavailable or unsupported visible native media instead of returning a text-only history', () => {
    const input = history();
    input.messages = [{ role: 'user', content: 'Attached media', __openclaw: { media: [{ contentType: 'audio/wav', path: '/native/media/audio.wav' }] } }];
    expect(() => projectCodexHistory(input)).toThrow('visible media');
    input.messages = [{ role: 'user', content: [{ type: 'image', source: { mediaType: 'image/png', data: 'YWJj' } }] }];
    expect(() => projectCodexHistory(input)).toThrow('visible image');
  });
  it('projects native stamped text, reasoning and tool result records using exact run receipts', () => {
    const input = history();
    input.messages.push(
      { ...message('hidden-user', 'user', 'HIDDEN-INPUT'), display: false },
      { role: 'custom', customType: 'openclaw.runtime-context', content: 'HIDDEN-CONTEXT' },
    );

    const snapshot = projectCodexHistory(input);

    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]).toMatchObject({
      id: 'turn-1', status: 'completed', itemsView: 'full',
      startedAt: 1, completedAt: 1, durationMs: 900, error: null,
    });
    expect(snapshot.turns[0].items.map(item => item.type)).toEqual([
      'userMessage', 'reasoning', 'agentMessage', 'mcpToolCall', 'agentMessage',
    ]);
    expect(snapshot.turns[0].items[0]).toMatchObject({
      content: [{ type: 'text', text: 'Read this project', text_elements: [] }],
    });
    expect(snapshot.turns[0].items[3]).toMatchObject({
      tool: 'read_file', arguments: { path: 'README.md' }, status: 'completed',
      result: { content: [{ type: 'text', text: 'File content' }], structuredContent: null, _meta: null },
    });
    expect(snapshot.items.every(entry => entry.startedAtMs === null && entry.completedAtMs === null)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toMatch(/HIDDEN-INPUT|HIDDEN-CONTEXT|private-product-session|private-receipt/);
    expect(projectCodexHistory(history()).items.map(entry => entry.item.id)).toEqual(snapshot.items.map(entry => entry.item.id));
  });

  it('joins native user admission keys to the actual completed turn without exposing unrelated recovery timings', () => {
    const clientTurnId = '10d439a5-c768-43cd-a508-661c171864b5';
    const input: ExternalAgentThreadHistory = {
      threadId: 'thread-one', latestExternalRunId: clientTurnId,
      runs: [
        { ...receipt(1), clientTurnId, rootRunId: clientTurnId },
        { ...receipt(2), clientTurnId: '4ca811eb-bc8e-4ece-ae4f-36b082ef455a',
          rootRunId: 'unrelated-root', state: 'running', endedAt: undefined },
      ],
      messages: [
        { role: 'user', content: 'Return a short confirmation.', idempotencyKey: `${clientTurnId}:user`,
          __openclaw: { id: 'native-user', seq: 1, idempotencyKey: `${clientTurnId}:user`, senderIsOwner: true } },
        { role: 'assistant', content: [
          { type: 'thinking', thinking: 'Prepare the confirmation.' },
          { type: 'text', text: 'Confirmed.' },
        ], __openclaw: { id: 'native-answer', seq: 2, runId: clientTurnId } },
      ],
    };

    const snapshot = projectCodexHistory(input);

    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]).toMatchObject({ id: clientTurnId, status: 'completed' });
    expect(snapshot.turns[0].items.map(item => item.type)).toEqual(['userMessage', 'reasoning', 'agentMessage']);
    expect(JSON.stringify(snapshot)).not.toMatch(/4ca811eb|unrelated-root|idempotencyKey/);
  });

  it('matches complete input keys only and does not construct them from execution root aliases', () => {
    const input: ExternalAgentThreadHistory = {
      threadId: 'input-keys', runs: [receipt(1)], messages: [
        { ...message('marker-key', 'user', 'Known logical input'), __openclaw: { id: 'marker-key', idempotencyKey: 'turn-1:user' } },
        { ...message('suffix-key', 'user', 'Unrelated input'), idempotencyKey: 'turn-1:user:other' },
        { ...message('root-key', 'user', 'Execution alias is not the input admission'), idempotencyKey: 'native-run-1:user' },
      ],
    };

    const snapshot = projectCodexHistory(input);

    expect(snapshot.turns.map(turn => turn.items[0].type)).toEqual(['userMessage', 'userMessage', 'userMessage']);
    expect(snapshot.turns[0]).toMatchObject({ id: 'turn-1', status: 'completed' });
    expect(snapshot.turns.slice(1).every(turn => turn.id.startsWith('history:') && turn.status === 'failed')).toBe(true);
  });

  it('honors the confirmed steering target while rejecting conflicting execution and input identities', () => {
    const input: ExternalAgentThreadHistory = {
      threadId: 'steering', runs: [receipt(1), receipt(2)], messages: [
        { role: 'user', content: 'Update the existing work.', idempotencyKey: 'turn-2:user',
          __openclaw: { id: 'steer-input', steerTargetRunId: 'native-run-1' } },
      ],
    };

    expect(projectCodexHistory(input).turns).toMatchObject([{ id: 'turn-1', items: [{ type: 'userMessage' }] }]);
    (input.messages[0] as Record<string, unknown>).__openclaw = {
      id: 'steer-input', steerTargetRunId: 'unrecorded-target',
    };
    expect(projectCodexHistory(input).turns[0].id).toMatch(/^history:/);
    (input.messages[0] as Record<string, unknown>).__openclaw = {
      id: 'steer-input', steerTargetRunId: 'native-run-1', runId: 'native-run-2',
    };
    expect(() => projectCodexHistory(input)).toThrow('execution identity is ambiguous');
    (input.messages[0] as Record<string, unknown>).__openclaw = { id: 'steer-input', runId: 'native-run-1' };
    expect(() => projectCodexHistory(input)).toThrow('execution identity is ambiguous');
    (input.messages[0] as Record<string, unknown>).__openclaw = { id: 'steer-input', idempotencyKey: 'turn-1:user' };
    expect(() => projectCodexHistory(input)).toThrow('execution identity is ambiguous');
  });

  it('preserves only explicitly identified external receipt-only failures and unknown executions', () => {
    const input: ExternalAgentThreadHistory = {
      threadId: 'receipt-only', messages: [], latestExternalRunId: 'turn-1', unknownRunId: 'turn-2',
      runs: [
        { ...receipt(1), state: 'failed' },
        { ...receipt(2), state: 'running', endedAt: undefined },
        { ...receipt(3), state: 'running', endedAt: undefined },
      ],
    };

    const snapshot = projectCodexHistory(input);

    expect(snapshot.turns).toMatchObject([
      { id: 'turn-1', status: 'failed', items: [], completedAt: 1 },
      { id: 'turn-2', status: 'failed', items: [], completedAt: null,
        error: { message: expect.stringMatching(/^EXECUTION_UNKNOWN:/) } },
    ]);
    expect(snapshot.turns).toHaveLength(2);
    expect(snapshot.items).toEqual([]);
  });

  it('keeps unstamped and suffix-related legacy records in explicitly unknown read-only history segments', () => {
    const input: ExternalAgentThreadHistory = {
      threadId: 'legacy-thread', runs: [receipt(1)],
      messages: [
        { ...message('old-user', 'user', 'Legacy request'), timestamp: 1_100 },
        { ...message('old-answer', 'assistant', 'Legacy answer', 'native-run-1:attempt'), timestamp: 1_500 },
      ],
    };

    const first = projectCodexHistory(input);
    const legacy = first.turns.find(turn => turn.id.startsWith('history:'))!;

    expect(legacy).toMatchObject({
      status: 'failed', startedAt: null, completedAt: null, durationMs: null,
      error: { message: expect.stringMatching(/^EXECUTION_UNKNOWN:/) },
    });
    expect(legacy.items).toHaveLength(2);
    expect(first.turns.find(turn => turn.id === 'turn-1')).toBeUndefined();
    expect(projectCodexHistory(input).turns.map(turn => turn.id)).toEqual(first.turns.map(turn => turn.id));
    expect(legacy).not.toHaveProperty('executionSettled');
  });

  it('does not settle a running or unknown receipt from final-looking assistant text', () => {
    const input = history();
    input.runs = [{ ...receipt(1), state: 'running', endedAt: undefined }];

    expect(projectCodexHistory(input).turns[0]).toMatchObject({
      status: 'inProgress', completedAt: null, error: null,
    });
    input.unknownRunId = 'turn-1';
    expect(projectCodexHistory(input).turns[0]).toMatchObject({
      status: 'failed', completedAt: null,
      error: { message: expect.stringMatching(/^EXECUTION_UNKNOWN:/) },
    });
  });

  it('preserves bare tool calls as in-progress and native failure results as failed', () => {
    const input = history();
    input.messages.splice(2, 1);
    const pending = projectCodexHistory(input).turns[0].items.find(item => item.type === 'mcpToolCall');
    expect(pending).toMatchObject({ status: 'inProgress', result: null });
    input.messages.splice(2, 0, {
      ...message('failed-tool', 'toolResult', [{ type: 'text', text: 'Permission denied' }], 'native-run-1'),
      toolCallId: 'call-one', isError: true,
    });
    const failed = projectCodexHistory(input).turns[0].items.find(item => item.type === 'mcpToolCall');
    expect(failed).toMatchObject({ status: 'failed', error: { message: 'Tool execution failed.' } });
  });

  it('preserves explicit null structured tool output while retaining native details when no structured value exists', () => {
    const input = history();
    input.messages[2] = {
      ...message('tool-result', 'toolResult', [{ type: 'text', text: 'File content' }], 'native-run-1'),
      toolCallId: 'call-one', details: { fileSize: 42 }, structuredContent: null,
    };
    const explicit = projectCodexHistory(input).turns[0].items.find(item => item.type === 'mcpToolCall')!;
    expect(explicit.result).toMatchObject({ structuredContent: null });
    delete (input.messages[2] as Record<string, unknown>).structuredContent;
    const fallback = projectCodexHistory(input).turns[0].items.find(item => item.type === 'mcpToolCall')!;
    expect(fallback.result).toMatchObject({ structuredContent: { fileSize: 42 } });
  });

  it('preserves an explicit failure carried by a supported nested output result', () => {
    const input = history();
    input.messages[2] = {
      ...message('failed-output', 'toolResult', undefined, 'native-run-1'),
      toolCallId: 'call-one',
      output: { content: [{ type: 'text', text: 'Native tool failed' }], isError: true },
    };

    const tool = projectCodexHistory(input).turns[0].items.find(item => item.type === 'mcpToolCall')!;

    expect(tool).toMatchObject({
      status: 'failed',
      result: { content: [{ type: 'text', text: 'Native tool failed' }] },
      error: { message: 'Tool execution failed.' },
    });
  });

  it('supports native envelopes, image input and nested tool records without inventing item timing', () => {
    const input: ExternalAgentThreadHistory = {
      threadId: 'media-thread', runs: [receipt(1)], messages: [
        {
          runId: 'native-run-1', messageId: 'native-user',
          message: { role: 'user', content: [
            { type: 'text', text: 'Describe this image.' },
            { type: 'image', source: { mediaType: 'image/png', data: imageBase64 } },
          ] },
        },
        {
          ...message('nested-tools', 'custom', [
            { type: 'tool_use', id: 'nested-call', name: 'inspect', input: { selection: 1 } },
            { type: 'tool_result', tool_use_id: 'nested-call', content: [{ type: 'text', text: 'Inspected' }] },
          ], 'native-run-1'),
          customType: 'openclaw.nested-tool.v1',
        },
      ],
    };

    const snapshot = projectCodexHistory(input);

    expect(snapshot.turns[0].items[0]).toMatchObject({
      type: 'userMessage', content: [
        { type: 'text', text: 'Describe this image.', text_elements: [] },
        { type: 'image', url: `data:image/png;base64,${imageBase64}` },
      ],
    });
    expect(snapshot.turns[0].items[1]).toMatchObject({
      type: 'mcpToolCall', status: 'completed', arguments: { selection: 1 },
    });
    expect(snapshot.items.map(entry => entry.completedAtMs)).toEqual([null, null]);
  });

  it('rejects ambiguous execution stamps and unsupported visible content instead of dropping records', () => {
    const conflicting = history();
    conflicting.messages[0] = { ...(conflicting.messages[0] as object), runId: 'another-native-run' };
    expect(() => projectCodexHistory(conflicting)).toThrow('execution identity is ambiguous');
    const unsupported = history();
    unsupported.messages.push(message('unsupported-audio', 'assistant', [{ type: 'audio', data: 'PRIVATE-CONTENT' }]));
    expect(() => projectCodexHistory(unsupported)).toThrow(/visible audio content/);
  });
});

describe('native history pagination', () => {
  const twoTurns = () => {
    const input = history();
    input.runs.push(receipt(2));
    input.messages.push(
      message('user-two', 'user', 'Second request', 'native-run-2'),
      message('answer-two', 'assistant', 'Second answer', 'native-run-2'),
    );
    return projectCodexHistory(input);
  };

  it('pages turns in descending order and implements full, summary and notLoaded item views', () => {
    const snapshot = twoTurns();
    const first = paginateCodexHistoryTurns(snapshot, { threadId: snapshot.threadId, limit: 1 });
    const second = paginateCodexHistoryTurns(snapshot, {
      threadId: snapshot.threadId, limit: 1, cursor: first.nextCursor,
    });

    expect((first.data as CodexHistoryTurn[]).map(turn => turn.id)).toEqual(['turn-2']);
    expect((second.data as CodexHistoryTurn[]).map(turn => turn.id)).toEqual(['turn-1']);
    expect((second.data as CodexHistoryTurn[])[0]).toMatchObject({ itemsView: 'summary' });
    expect((second.data as CodexHistoryTurn[])[0].items.map(item => item.type)).toEqual(['userMessage', 'agentMessage']);
    expect(second.nextCursor).toBeNull();
    const full = paginateCodexHistoryTurns(snapshot, {
      threadId: snapshot.threadId, sortDirection: 'asc', itemsView: 'full',
    });
    expect((full.data as CodexHistoryTurn[])[0].items).toHaveLength(5);
    const metadataOnly = paginateCodexHistoryTurns(snapshot, { threadId: snapshot.threadId, itemsView: 'notLoaded' });
    expect((metadataOnly.data as CodexHistoryTurn[]).every(turn => turn.itemsView === 'notLoaded' && !turn.items.length)).toBe(true);
  });

  it('pages items within their exact turn and supports exclusive item anchors', () => {
    const snapshot = twoTurns();
    const firstItem = snapshot.items.find(entry => entry.turnId === 'turn-1')!;
    const page = paginateCodexHistoryItems(snapshot, {
      threadId: snapshot.threadId, turnId: 'turn-1', limit: 2,
      cursor: { type: 'item', itemId: firstItem.item.id },
    });
    const next = paginateCodexHistoryItems(snapshot, {
      threadId: snapshot.threadId, turnId: 'turn-1', limit: 2, cursor: page.nextCursor,
    });

    expect((page.data as CodexHistoryItemEntry[]).map(entry => entry.item.type)).toEqual(['reasoning', 'agentMessage']);
    expect((next.data as CodexHistoryItemEntry[]).map(entry => entry.item.type)).toEqual(['mcpToolCall', 'agentMessage']);
    expect((next.data as CodexHistoryItemEntry[]).every(entry => entry.turnId === 'turn-1')).toBe(true);
    expect(next.nextCursor).toBeNull();
  });

  it('rejects cursors across threads, physical incarnations, queries and changing snapshots', () => {
    const snapshot = twoTurns();
    const first = paginateCodexHistoryTurns(snapshot, { threadId: snapshot.threadId, limit: 1 });
    expect(() => paginateCodexHistoryTurns(snapshot, {
      threadId: 'another-thread', cursor: first.nextCursor,
    })).toThrow('threadId');
    expect(() => paginateCodexHistoryTurns(snapshot, {
      threadId: snapshot.threadId, cursor: first.nextCursor, itemsView: 'full',
    })).toThrow('another query');
    expect(() => paginateCodexHistoryItems(snapshot, {
      threadId: snapshot.threadId, cursor: first.nextCursor,
    })).toThrow('another query');
    const changed = history();
    changed.identityRevision = 'different-physical-incarnation';
    expect(() => paginateCodexHistoryTurns(projectCodexHistory(changed), {
      threadId: snapshot.threadId, cursor: first.nextCursor,
    })).toThrow('History changed');
  });

  it('limits full replies by bytes while allowing large histories to be paged as items', () => {
    const input: ExternalAgentThreadHistory = {
      threadId: 'large-history', runs: [], messages: [
        message('large-user', 'user', 'u'.repeat(4 * 1024 * 1024)),
        message('large-answer', 'assistant', 'a'.repeat(4 * 1024 * 1024)),
      ],
    };
    const snapshot = projectCodexHistory(input);

    expect(() => assertCodexHistoryFullSize(snapshot.turns)).toThrow('Use thread/turns/list or thread/items/list');
    expect(() => paginateCodexHistoryTurns(snapshot, {
      threadId: input.threadId, itemsView: 'full',
    })).toThrow('exceeds the response limit');
    const first = paginateCodexHistoryItems(snapshot, { threadId: input.threadId });
    const second = paginateCodexHistoryItems(snapshot, { threadId: input.threadId, cursor: first.nextCursor });
    expect(first.data as CodexHistoryItemEntry[]).toHaveLength(1);
    expect(second.data as CodexHistoryItemEntry[]).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
  });
});
