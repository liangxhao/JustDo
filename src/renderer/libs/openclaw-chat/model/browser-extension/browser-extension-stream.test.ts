import type { BrowserExtensionStreamEvent } from '@shared/browser/browserExtensionStream';
import { describe, expect, it } from 'vitest';

import { BrowserExtensionStream } from './browser-extension-stream';

const user = { type: 'userMessage', content: [{ type: 'text', text: 'Question' }] };
const history = (items: Array<Record<string, unknown> & { type: string }> = []) => ({
  id: 'one',
  turns: [{ id: 'history-1', items: [user, ...items] }],
});
const agent = (
  seq: number,
  stream: string,
  data: Record<string, unknown>,
): BrowserExtensionStreamEvent => ({
  kind: 'agent',
  event: {
    runId: 'run-1',
    sessionKey: 'agent:main:justdo:one',
    sessionId: null,
    lifecycleGeneration: null,
    agentId: 'main',
    spawnedBy: null,
    agentSeq: seq,
    frameSeq: seq,
    deliveryEvent: 'agent',
    stream,
    timestamp: seq,
    data,
  },
});
const chat = (
  state: 'delta' | 'final' | 'error' | 'aborted',
  text: string,
): BrowserExtensionStreamEvent => ({
  kind: 'chat',
  event: {
    runId: 'run-1',
    sessionKey: 'agent:main:justdo:one',
    sessionId: null,
    lifecycleGeneration: null,
    frameSeq: 100,
    state,
    message: { content: text },
    replace: false,
  },
});
const items = (view: BrowserExtensionStream) => view.project().turns.flatMap(turn => turn.items);

describe('extension live projection', () => {
  it('hides a scoped preview and restores its complete prefix after a delta-only final', () => {
    const view = new BrowserExtensionStream('one');
    view.setHistory(history());
    view.start('Question');
    view.accept(
      agent(1, 'assistant', {
        text: 'Checking.',
        itemId: 'body-1',
        assistantTextScope: { id: 'source-1' },
      }),
    );
    view.accept(
      agent(2, 'item', {
        kind: 'preamble',
        phase: 'update',
        itemId: 'commentary-1',
        progressText: 'Checking.',
        assistantTextScope: { id: 'source-1' },
      }),
    );
    expect(items(view).filter(item => item.type === 'agentMessage')).toMatchObject([
      { text: 'Checking.' },
    ]);
    view.accept(
      agent(3, 'assistant', {
        delta: ' More.',
        itemId: 'body-1',
        assistantTextScope: { id: 'source-1', commentaryItemIds: [] },
      }),
    );
    expect(items(view).filter(item => item.type === 'agentMessage' && item.text)).toMatchObject([
      { text: 'Checking. More.' },
    ]);
  });

  it('accepts a compacted authoritative final snapshot and rebases the optimistic turn', () => {
    const view = new BrowserExtensionStream('one');
    view.setHistory({
      id: 'one',
      turns: [
        { id: 'old-1', items: [user] },
        { id: 'old-2', items: [user] },
      ],
    });
    view.start('Question');
    view.accept(agent(1, 'assistant', { text: 'Current answer' }));
    const displayId = view.project().turns[2].id;
    const compacted = history([{ type: 'agentMessage', text: 'Current answer persisted' }]);
    view.setHistory(compacted);
    expect(view.project().turns).toHaveLength(3);
    view.setHistory(compacted, true);
    expect(view.project().turns).toHaveLength(1);
    expect(view.project().turns[0].id).toBe(displayId);
    view.finish();
    expect(items(view)).toMatchObject([user, { text: 'Current answer persisted' }]);
    expect(view.project().turns).toHaveLength(1);
  });

  it('does not match post-tool text to history before an unpersisted tool', () => {
    const view = new BrowserExtensionStream('one');
    view.setHistory(history([{ type: 'agentMessage', text: 'Hello' }]));
    view.accept(agent(1, 'thinking', { thinking: 'inspect' }));
    view.accept(
      agent(2, 'tool', { phase: 'result', toolCallId: 't1', name: 'read', result: 'content' }),
    );
    view.accept(agent(3, 'assistant', { text: 'Hello' }));
    expect(items(view)).toMatchObject([
      user,
      { text: 'Hello' },
      { content: ['inspect'] },
      { toolUseId: 't1' },
      { text: 'Hello' },
    ]);
    view.setHistory(
      history([
        { type: 'agentMessage', text: 'Hello' },
        { type: 'reasoning', content: ['inspect'] },
        { type: 'toolCall', toolUseId: 't1', status: 'completed', output: 'content' },
        { type: 'agentMessage', text: 'Hello' },
      ]),
    );
    expect(items(view)).toMatchObject([
      user,
      { text: 'Hello' },
      { content: ['inspect'] },
      { toolUseId: 't1' },
      { text: 'Hello' },
    ]);
  });

  it('retains persisted tool input when joining at the result and does not rewind terminal results', () => {
    const view = new BrowserExtensionStream('one');
    view.setHistory(
      history([
        {
          type: 'toolCall',
          toolUseId: 't1',
          toolName: 'read',
          input: { path: 'a.txt' },
          status: 'inProgress',
        },
      ]),
    );
    view.accept(
      agent(10, 'tool', { phase: 'result', toolCallId: 't1', name: 'read', result: 'content' }),
    );
    expect(items(view).slice(-1)[0]).toMatchObject({
      input: { path: 'a.txt' },
      output: 'content',
      status: 'completed',
    });

    const late = new BrowserExtensionStream('one');
    late.setHistory(
      history([
        {
          type: 'toolCall',
          toolUseId: 't1',
          toolName: 'read',
          input: { path: 'a.txt' },
          output: 'content',
          status: 'completed',
        },
      ]),
    );
    late.accept(agent(1, 'tool', { phase: 'start', toolCallId: 't1', name: 'read' }));
    expect(items(late).slice(-1)[0]).toMatchObject({
      input: { path: 'a.txt' },
      output: 'content',
      status: 'completed',
    });
  });

  it('does not confuse a new text segment with the same prefix before a persisted tool', () => {
    const view = new BrowserExtensionStream('one');
    view.setHistory(
      history([
        { type: 'agentMessage', text: 'Hello previously' },
        { type: 'toolCall', toolUseId: 't1', status: 'completed' },
      ]),
    );
    view.accept(agent(20, 'assistant', { text: 'Hello' }));
    expect(items(view)).toMatchObject([
      user,
      { text: 'Hello previously' },
      { toolUseId: 't1' },
      { text: 'Hello' },
    ]);
  });

  it('preserves unmatched historical activities when a tool event arrives late', () => {
    const view = new BrowserExtensionStream('one');
    view.setHistory(
      history([
        { type: 'toolCall', toolUseId: 't1', status: 'completed', output: 'first' },
        { type: 'reasoning', content: ['Later thinking'] },
        { type: 'toolCall', toolUseId: 't2', status: 'completed', output: 'second' },
      ]),
    );
    view.accept(
      agent(10, 'tool', { phase: 'result', toolCallId: 't1', name: 'read', result: 'first' }),
    );
    expect(items(view)).toMatchObject([
      user,
      { toolUseId: 't1' },
      { content: ['Later thinking'] },
      { toolUseId: 't2' },
    ]);
  });

  it('aligns repeated text using shared tool boundaries when full history arrives', () => {
    const view = new BrowserExtensionStream('one');
    view.setHistory(history());
    view.accept(agent(1, 'assistant', { text: 'Hello first' }));
    view.accept(
      agent(2, 'tool', { phase: 'result', toolCallId: 't1', name: 'read', result: 'first' }),
    );
    view.accept(agent(3, 'assistant', { text: 'Hello second' }));
    view.setHistory(
      history([
        { type: 'agentMessage', text: 'Hello first' },
        { type: 'toolCall', toolUseId: 't1', status: 'completed', output: 'first' },
        { type: 'agentMessage', text: 'Hello second' },
      ]),
    );
    expect(items(view)).toMatchObject([
      user,
      { text: 'Hello first' },
      { toolUseId: 't1' },
      { text: 'Hello second' },
    ]);
  });

  it('keeps an optimistic turn display identity after persistence and completion', () => {
    const view = new BrowserExtensionStream('one');
    view.start('Question');
    view.accept(agent(1, 'thinking', { thinking: 'Inspect' }));
    const turnId = view.project().turns[0].id;
    view.setHistory(history([{ type: 'reasoning', content: ['Inspect'] }]));
    expect(view.project().turns[0].id).toBe(turnId);
    view.finish();
    expect(view.project().turns[0].id).toBe(turnId);
    view.setHistory(history([{ type: 'reasoning', content: ['Inspect'] }]));
    expect(view.project().turns[0].id).toBe(turnId);
  });

  it('removes a rejected optimistic turn so the next send can reconcile history', () => {
    const view = new BrowserExtensionStream('one');
    view.start('Rejected question');
    view.cancelStart();
    expect(view.project().turns).toEqual([]);
    view.start('Question');
    view.setHistory(history());
    view.accept(agent(1, 'assistant', { text: 'Reply' }));
    expect(items(view)).toMatchObject([user, { text: 'Reply' }]);
  });
  it('retains interrupted text until authoritative history contains it', () => {
    const view = new BrowserExtensionStream('one');
    view.setHistory(history());
    view.accept(agent(1, 'assistant', { text: 'Partial reply' }));
    view.finish(true);
    expect(items(view)).toMatchObject([user, { text: 'Partial reply' }]);
    expect(view.accept(agent(2, 'assistant', { text: 'Late reply' }))).toBe(false);
    view.setHistory(history([{ type: 'agentMessage', text: 'Partial reply persisted' }]));
    expect(items(view)).toMatchObject([user, { text: 'Partial reply persisted' }]);
  });
  it('shows growing text before history contains an assistant reply', () => {
    const view = new BrowserExtensionStream('one');
    view.setHistory(history());
    view.accept(agent(1, 'assistant', { text: 'Hello' }));
    expect(items(view)).toMatchObject([user, { type: 'agentMessage', text: 'Hello' }]);
    view.setHistory(history());
    view.accept(agent(2, 'assistant', { text: 'Hello world' }));
    expect(items(view)).toMatchObject([user, { text: 'Hello world' }]);
  });

  it('deduplicates repeated events and the parallel chat delivery path', () => {
    const view = new BrowserExtensionStream('one');
    view.setHistory(history());
    view.accept(agent(1, 'assistant', { delta: 'Hello' }));
    expect(view.accept(agent(1, 'assistant', { delta: 'Hello' }))).toBe(false);
    view.accept(chat('delta', 'Hello'));
    view.accept(agent(2, 'assistant', { delta: ' world' }));
    expect(items(view).slice(-1)[0]?.text).toBe('Hello world');
  });

  it('keeps Thinking, tool input/result and subsequent content in order', () => {
    const view = new BrowserExtensionStream('one');
    view.setHistory(history());
    view.accept(agent(1, 'thinking', { thinking: 'Inspect' }));
    view.accept(agent(2, 'thinking', { thinking: 'Inspect the file' }));
    view.accept(
      agent(3, 'tool', { phase: 'start', toolCallId: 't1', name: 'read', args: { path: 'a.txt' } }),
    );
    expect(items(view).slice(-1)[0]).toMatchObject({
      type: 'toolCall',
      input: { path: 'a.txt' },
      status: 'inProgress',
    });
    view.accept(
      agent(4, 'tool', { phase: 'result', toolCallId: 't1', name: 'read', result: 'file content' }),
    );
    view.accept(agent(5, 'assistant', { text: '**Done**' }));
    expect(items(view)).toMatchObject([
      user,
      { type: 'reasoning', content: ['Inspect the file'] },
      { type: 'toolCall', output: 'file content', status: 'completed' },
      { type: 'agentMessage', text: '**Done**' },
    ]);
  });

  it('does not duplicate live content when lagging history catches up', () => {
    const view = new BrowserExtensionStream('one');
    view.setHistory(history());
    view.accept(agent(1, 'assistant', { text: 'Hello world' }));
    view.setHistory(history([{ type: 'agentMessage', text: 'Hello' }]));
    expect(items(view)).toMatchObject([user, { text: 'Hello world' }]);
    view.setHistory(history([{ type: 'agentMessage', text: 'Hello world!' }]));
    view.finish();
    expect(items(view)).toMatchObject([user, { text: 'Hello world!' }]);
    expect(view.accept(agent(2, 'assistant', { text: 'late' }))).toBe(false);
  });

  it('keeps the previous turn separate while a new user message is not persisted', () => {
    const view = new BrowserExtensionStream('one');
    view.setHistory(history([{ type: 'agentMessage', text: 'Previous answer' }]));
    view.start('Next question');
    view.accept(agent(1, 'assistant', { text: 'New answer' }));
    view.setHistory(history([{ type: 'agentMessage', text: 'Previous answer' }]));
    expect(view.project().turns).toHaveLength(2);
    expect(view.project().turns[0].items.slice(-1)[0]?.text).toBe('Previous answer');
    expect(view.project().turns[1].items.slice(-1)[0]?.text).toBe('New answer');
  });

  it('retains already persisted activities when joining halfway through a run', () => {
    const view = new BrowserExtensionStream('one');
    view.setHistory(
      history([
        { type: 'reasoning', content: ['Earlier thinking'] },
        { type: 'toolCall', toolUseId: 't1', status: 'completed' },
        { type: 'agentMessage', text: 'Hel' },
      ]),
    );
    view.accept(agent(10, 'assistant', { text: 'Hello' }));
    expect(items(view)).toHaveLength(4);
    expect(items(view).slice(-1)[0]?.text).toBe('Hello');
  });

  it('rejects another session and out of order snapshots', () => {
    const view = new BrowserExtensionStream('one');
    view.setHistory(history());
    view.accept(agent(5, 'assistant', { text: 'Current' }));
    const other = agent(6, 'assistant', { text: 'Wrong session' });
    other.event.sessionKey = 'agent:main:justdo:two';
    expect(view.accept(other)).toBe(false);
    expect(view.accept(agent(4, 'assistant', { text: 'Old' }))).toBe(false);
    expect(items(view).slice(-1)[0]?.text).toBe('Current');
  });

  it('does not end a live run on a retry-attempt error', () => {
    const view = new BrowserExtensionStream('one');
    view.setHistory(history());
    view.accept(agent(1, 'thinking', { text: 'Working' }));
    expect(view.accept(chat('error', 'Gateway timeout'))).toBe(false);
    view.accept(agent(2, 'assistant', { text: 'Recovered reply' }));
    expect(items(view).slice(-1)[0]?.text).toBe('Recovered reply');
  });

  it('removes rolled back terminal observations and accepts the corrected text', () => {
    const view = new BrowserExtensionStream('one');
    view.setHistory(history());
    view.accept(
      agent(1, 'assistant', {
        text: 'Tentative',
        justdoTerminalGuardObservation: { token: 'a', action: 'update' },
      }),
    );
    view.accept(
      agent(2, 'assistant', { justdoTerminalGuardObservation: { token: 'a', action: 'rollback' } }),
    );
    expect(items(view)).toEqual([user]);
    view.accept(agent(3, 'assistant', { text: 'Corrected' }));
    expect(items(view).slice(-1)[0]?.text).toBe('Corrected');
  });

  it('supports chat-only streams and terminal final snapshots', () => {
    const view = new BrowserExtensionStream('one');
    view.setHistory(history());
    view.accept(chat('delta', 'Hel'));
    view.accept(chat('delta', 'Hello'));
    view.accept(chat('final', 'Hello world'));
    expect(items(view)).toMatchObject([user, { text: 'Hello world' }]);
  });
});
