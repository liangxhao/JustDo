import type { NormalizedAgentEvent } from '@shared/openclaw/agentEvent';
import { expect, test } from 'vitest';

import {
  hydrateToolPrecedingSegments,
  type RecoveredPreToolSegment,
  reduceAgentEvent,
} from './agent-event-reducer';
import { createChatTranscriptState, type ToolItem } from './chat-transcript-state';

function setup() {
  let id = 0;
  const dependencies = { now: () => 1000, createId: (prefix: string) => `${prefix}-${++id}` };
  const state = createChatTranscriptState('session-1', null);
  const emit = (seq: number, stream: string, data: Record<string, unknown>) => {
    const event: NormalizedAgentEvent = {
      runId: 'run-1',
      sessionKey: 'session-1',
      sessionId: null,
      lifecycleGeneration: null,
      agentId: null,
      spawnedBy: null,
      agentSeq: seq,
      frameSeq: null,
      deliveryEvent: 'agent',
      stream,
      timestamp: 1000 + seq,
      data,
    };
    reduceAgentEvent(state, event, dependencies);
  };
  const commentary = (seq: number, itemId: string, text: string) =>
    emit(seq, 'item', {
      kind: 'preamble',
      itemId,
      phase: 'end',
      progressText: text,
      progressSegmentFirstSeq: seq,
      progressSegmentStartedAt: 1000 + seq,
    });
  const appendTool = (seq: number, toolCallId = 'tool-1') => {
    const tool: ToolItem = {
      id: `history-${toolCallId}`,
      runId: 'run-1',
      type: 'tool',
      toolCallId,
      name: 'read',
      status: 'running',
      firstSeq: seq,
      lastSeq: seq,
      startedAt: 1000 + seq,
      updatedAt: 1000 + seq,
      agentSequencePending: true,
    };
    state.activeTurn!.items.push(tool);
    state.activeTurn!.toolById.set(toolCallId, tool);
    return tool;
  };
  const hydrate = (tool: ToolItem, segments: RecoveredPreToolSegment[]) =>
    hydrateToolPrecedingSegments(
      state.activeTurn!,
      tool,
      segments,
      tool.firstSeq,
      tool.startedAt,
      dependencies,
    );
  emit(7, 'thinking', { text: 'Initial reasoning', progressSegmentFirstSeq: 7 });
  return { state, emit, commentary, appendTool, hydrate };
}

test('a sparse session message never deletes commentary already received from the native item stream', () => {
  const { state, commentary, appendTool, hydrate } = setup();
  commentary(16, 'commentary-1', 'Diagnostic first step');
  const originalThinking = state.activeTurn!.items[0];
  const originalContent = state.activeTurn!.items[1];
  const tool = appendTool(20);

  hydrate(tool, [{ type: 'thinking', text: 'Initial reasoning' }]);

  expect(state.activeTurn!.items).toEqual([originalThinking, originalContent, tool]);
  expect(originalContent).toMatchObject({
    firstSeq: 16,
    preambleItemId: 'commentary-1',
    text: 'Diagnostic first step',
    followingToolCallId: 'tool-1',
  });
  expect(hydrate(tool, [{ type: 'thinking', text: 'Initial reasoning' }])).toBe(false);
});

test('a later complete history snapshot consumes the preserved commentary once and keeps its identity', () => {
  const { state, commentary, appendTool, hydrate } = setup();
  commentary(16, 'commentary-1', 'Diagnostic first step');
  const content = state.activeTurn!.items[1];
  const tool = appendTool(20);
  hydrate(tool, [{ type: 'thinking', text: 'Initial reasoning' }]);

  hydrate(tool, [
    { type: 'thinking', text: 'Initial reasoning' },
    { type: 'content', text: 'Diagnostic first step' },
  ]);

  expect(state.activeTurn!.items.filter(item => item.type === 'content')).toEqual([content]);
});

test('matches the whitespace-normalized native preamble to complete history without duplicating it', () => {
  const { state, commentary, appendTool, hydrate } = setup();
  commentary(16, 'commentary-1', 'Checking the result');
  const content = state.activeTurn!.items[1];
  const tool = appendTool(20);

  hydrate(tool, [
    { type: 'thinking', text: 'Initial reasoning' },
    { type: 'content', text: 'Checking\n  the result' },
  ]);

  expect(state.activeTurn!.items.filter(item => item.type === 'content')).toEqual([content]);
  expect(content).toMatchObject({ text: 'Checking\n  the result', firstSeq: 16 });
});

test('matches a partial earlier preamble before a later exact match when history completes both', () => {
  const { state, commentary, appendTool, hydrate } = setup();
  commentary(16, 'first', 'A');
  commentary(18, 'second', 'AB');
  const originalContent = state.activeTurn!.items.filter(item => item.type === 'content');
  const tool = appendTool(20);

  hydrate(tool, [
    { type: 'thinking', text: 'Initial reasoning' },
    { type: 'content', text: 'AB' },
    { type: 'content', text: 'AB' },
  ]);

  expect(state.activeTurn!.items.filter(item => item.type === 'content')).toEqual(originalContent);
  expect(originalContent.map(item => item.text)).toEqual(['AB', 'AB']);
});

test('aligns repeated commentary by occurrence and preserves each native owner', () => {
  const { state, commentary, appendTool, hydrate } = setup();
  commentary(16, 'first', 'Checking');
  commentary(18, 'second', 'Checking');
  const originalContent = state.activeTurn!.items.filter(item => item.type === 'content');
  const tool = appendTool(20);
  hydrate(tool, [
    { type: 'thinking', text: 'Initial reasoning' },
    { type: 'content', text: 'Checking' },
  ]);
  expect(state.activeTurn!.items.filter(item => item.type === 'content')).toEqual(originalContent);

  hydrate(tool, [
    { type: 'thinking', text: 'Initial reasoning' },
    { type: 'content', text: 'Checking' },
    { type: 'content', text: 'Checking' },
  ]);

  expect(state.activeTurn!.items.filter(item => item.type === 'content')).toEqual(originalContent);
});

test('accepts authoritative reasoning corrections while retaining the omitted live preamble', () => {
  const { state, commentary, appendTool, hydrate } = setup();
  commentary(16, 'commentary-1', 'Diagnostic first step');
  const thinking = state.activeTurn!.items[0];
  const content = state.activeTurn!.items[1];
  const tool = appendTool(20);

  hydrate(tool, [{ type: 'thinking', text: 'Authoritatively revised reasoning' }]);

  expect(state.activeTurn!.items).toEqual([thinking, content, tool]);
  expect(thinking).toMatchObject({ firstSeq: 7, text: 'Authoritatively revised reasoning' });
});

test('never matches or removes a same-text commentary owner across the preceding Tool boundary', () => {
  const { state, emit, commentary, appendTool, hydrate } = setup();
  commentary(16, 'first', 'Checking');
  const firstContent = state.activeTurn!.items[1];
  const firstTool = appendTool(20);
  emit(21, 'tool', { phase: 'start', toolCallId: 'tool-1', name: 'read' });
  emit(22, 'thinking', { text: 'Next reasoning', progressSegmentFirstSeq: 22 });
  commentary(23, 'second', 'Checking');
  const secondContent = state.activeTurn!.items.find(
    item => item.type === 'content' && item.preambleItemId === 'second',
  );
  const secondTool = appendTool(30, 'tool-2');

  hydrate(secondTool, [
    { type: 'thinking', text: 'Next reasoning' },
    { type: 'content', text: 'Checking' },
  ]);

  expect(state.activeTurn!.items.filter(item => item.type === 'content')).toEqual([
    firstContent,
    secondContent,
  ]);
  expect(state.activeTurn!.items.indexOf(firstContent)).toBeLessThan(
    state.activeTurn!.items.indexOf(firstTool),
  );
  expect(state.activeTurn!.items.indexOf(secondContent!)).toBeGreaterThan(
    state.activeTurn!.items.indexOf(firstTool),
  );
});
