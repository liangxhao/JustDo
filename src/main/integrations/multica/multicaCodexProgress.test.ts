import { describe, expect, it, vi } from 'vitest';

import {
  type NormalizedAgentEvent,
  TERMINAL_GUARD_OBSERVATION_KEY,
} from '../../../shared/openclaw/agentEvent';
import { MulticaCodexProgress } from './multicaCodexProgress';

const event = (stream: string, data: Record<string, unknown>): NormalizedAgentEvent => ({
  runId: 'run',
  sessionKey: 'key',
  sessionId: null,
  lifecycleGeneration: null,
  agentId: 'main',
  spawnedBy: null,
  agentSeq: 1,
  frameSeq: null,
  deliveryEvent: 'agent',
  stream,
  timestamp: 1,
  data,
});

function fixture() {
  const notify = vi.fn<(method: string, params: Record<string, unknown>) => void>();
  const fail = vi.fn();
  const progress = new MulticaCodexProgress('Actual user input', notify, fail);
  return { progress, notify, fail };
}

describe('Multica Codex progress', () => {
  it('admits the actual user item once at native start while the model is silent', () => {
    const { progress, notify } = fixture();
    progress.accept(event('lifecycle', { phase: 'model' }));
    expect(notify).not.toHaveBeenCalled();
    progress.accept(event('lifecycle', { phase: 'start' }));
    progress.accept(event('lifecycle', { phase: 'start' }));
    expect(notify.mock.calls.map(([method]) => method)).toEqual(['item/started', 'item/completed']);
    const item = notify.mock.calls[0][1].item;
    expect(item).toEqual({
      id: expect.any(String),
      type: 'userMessage',
      content: [{ type: 'text', text: 'Actual user input' }],
    });
    expect(notify.mock.calls[1][1].item).toEqual(item);
    progress.finish();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('streams text before settlement and completes the same item without repeating the final answer', () => {
    const { progress, notify } = fixture();
    progress.accept(event('assistant', { text: 'Hello', delta: 'Hello' }));
    progress.accept(event('assistant', { text: 'Hello world', delta: ' world' }));
    progress.accept(event('assistant', { text: 'Hello world' }));
    const itemId = (notify.mock.calls[0][1].item as { id: string }).id;
    expect(notify.mock.calls).toEqual([
      [
        'item/started',
        { item: { id: itemId, type: 'agentMessage', text: '', phase: 'commentary' } },
      ],
      ['item/agentMessage/delta', { itemId, delta: 'Hello' }],
      ['item/agentMessage/delta', { itemId, delta: ' world' }],
    ]);
    progress.finish('Hello world!');
    expect(notify.mock.calls.slice(3)).toEqual([
      ['item/agentMessage/delta', { itemId, delta: '!' }],
      [
        'item/completed',
        { item: { id: itemId, type: 'agentMessage', text: 'Hello world!', phase: 'final_answer' } },
      ],
    ]);
  });

  it('closes real reasoning and commentary at tool boundaries across multiple responses', () => {
    const { progress, notify } = fixture();
    progress.accept(event('thinking', { text: 'Check', delta: 'Check' }));
    progress.accept(event('thinking', { text: 'Check the file', delta: ' the file' }));
    progress.accept(event('assistant', { delta: 'Reading now.' }));
    progress.beforeTool();
    progress.accept(event('thinking', { thinking: 'Confirm result' }));
    progress.accept(event('assistant', { text: 'Verified' }));
    progress.finish('Verified');
    const completed = notify.mock.calls
      .filter(([method]) => method === 'item/completed')
      .map(([, params]) => params.item);
    expect(completed).toEqual([
      { id: expect.any(String), type: 'reasoning', summary: [], content: ['Check the file'] },
      { id: expect.any(String), type: 'agentMessage', phase: 'commentary', text: 'Reading now.' },
      { id: expect.any(String), type: 'reasoning', summary: [], content: ['Confirm result'] },
      { id: expect.any(String), type: 'agentMessage', phase: 'final_answer', text: 'Verified' },
    ]);
    expect(
      notify.mock.calls
        .filter(([method]) => method === 'item/reasoning/textDelta')
        .map(([, params]) => params.delta),
    ).toEqual(['Check', ' the file', 'Confirm result']);
    expect(
      notify.mock.calls
        .filter(([method]) => method === 'item/agentMessage/delta')
        .map(([, params]) => params.delta),
    ).toEqual(['Reading now.', 'Verified']);
  });

  it('holds guarded output until its native commit and discards rolled-back text', () => {
    const { progress, notify } = fixture();
    const guard = (token: string, action: 'update' | 'commit' | 'rollback') => ({
      [TERMINAL_GUARD_OBSERVATION_KEY]: { token, action },
    });
    progress.accept(
      event('assistant', { text: 'Hidden provisional output', ...guard('one', 'update') }),
    );
    progress.accept(event('assistant', guard('one', 'rollback')));
    progress.accept(event('assistant', { text: 'Visible', ...guard('two', 'update') }));
    progress.accept(event('assistant', { delta: ' answer', ...guard('two', 'update') }));
    progress.accept(event('assistant', guard('other', 'commit')));
    expect(notify).not.toHaveBeenCalled();
    progress.accept(event('assistant', guard('two', 'commit')));
    progress.finish('Visible answer');
    expect(
      notify.mock.calls
        .filter(([method]) => method === 'item/agentMessage/delta')
        .map(([, params]) => params.delta),
    ).toEqual(['Visible answer']);
    expect(JSON.stringify(notify.mock.calls)).not.toContain('Hidden provisional');
  });

  it('keeps interrupted partial text as commentary without inventing a final answer', () => {
    const { progress, notify } = fixture();
    progress.accept(event('assistant', { text: 'Partial' }));
    progress.finish();
    expect(notify.mock.calls.at(-1)).toEqual([
      'item/completed',
      {
        item: {
          id: expect.any(String),
          type: 'agentMessage',
          phase: 'commentary',
          text: 'Partial',
        },
      },
    ]);
  });

  it('never carries uncommitted text across native guard tokens', () => {
    const { progress, notify } = fixture();
    progress.accept(
      event('assistant', {
        text: 'Hidden',
        [TERMINAL_GUARD_OBSERVATION_KEY]: { token: 'one', action: 'update' },
      }),
    );
    progress.accept(
      event('assistant', {
        delta: 'Visible',
        [TERMINAL_GUARD_OBSERVATION_KEY]: { token: 'two', action: 'update' },
      }),
    );
    progress.accept(
      event('assistant', {
        [TERMINAL_GUARD_OBSERVATION_KEY]: { token: 'two', action: 'commit' },
      }),
    );
    expect(
      notify.mock.calls
        .filter(([method]) => method === 'item/agentMessage/delta')
        .map(([, params]) => params.delta),
    ).toEqual(['Visible']);
    expect(JSON.stringify(notify.mock.calls)).not.toContain('Hidden');
  });

  it.each(['assistant', 'thinking'])('rejects oversized %s events before sending text', stream => {
    const { progress, notify, fail } = fixture();
    progress.accept(event(stream, { text: 'x'.repeat(2 * 1024 * 1024 + 1) }));
    expect(fail).toHaveBeenCalledOnce();
    expect(notify).not.toHaveBeenCalled();
  });

  it('rejects an oversized terminal payload without labelling partial output as final', () => {
    const { progress, notify, fail } = fixture();
    progress.accept(event('assistant', { text: 'Partial' }));
    progress.finish('x'.repeat(2 * 1024 * 1024 + 1));
    expect(fail).toHaveBeenCalledWith('Assistant output exceeded the event limit.');
    expect(notify.mock.calls.at(-1)?.[1]).toMatchObject({ item: { phase: 'commentary' } });
  });
});
