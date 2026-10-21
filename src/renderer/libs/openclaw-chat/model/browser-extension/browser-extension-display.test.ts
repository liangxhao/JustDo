import type { BrowserExtensionStreamEvent } from '@shared/browser/browserExtensionStream';
import { describe, expect, it } from 'vitest';

import { prepareBrowserExtensionStreamEvent as prepare } from './browser-extension-display';
import { BrowserExtensionStream } from './browser-extension-stream';

const agent = (data: Record<string, unknown>): BrowserExtensionStreamEvent => ({
  kind: 'agent',
  event: {
    runId: 'run',
    sessionKey: 'session',
    sessionId: null,
    lifecycleGeneration: null,
    agentId: null,
    spawnedBy: null,
    agentSeq: 1,
    frameSeq: 1,
    deliveryEvent: 'agent',
    stream: 'assistant',
    timestamp: 1,
    data,
  },
});
const chat = (state: 'delta' | 'final', message: unknown): BrowserExtensionStreamEvent => ({
  kind: 'chat',
  event: {
    runId: 'run',
    sessionKey: 'session',
    sessionId: null,
    lifecycleGeneration: null,
    frameSeq: 1,
    state,
    message,
    replace: false,
  },
});

describe('extension stream display rules', () => {
  it.each(['NO_REPLY', 'NO_RE', 'HEARTBEAT_OK', 'The agent run failed before producing a reply.'])(
    'never retains hidden live text %s after authoritative empty history',
    text => {
      const view = new BrowserExtensionStream('one');
      view.accept(agent({ text }));
      expect(view.project().turns.flatMap(turn => turn.items)).toEqual([]);
      view.accept(chat('final', { content: text }));
      view.finish(true);
      view.setHistory({ id: 'one', turns: [] });
      expect(view.project().turns.flatMap(turn => turn.items)).toEqual([]);
    },
  );
  it('keeps the complete 10K live answer when final carries an 8K preview', () => {
    const view = new BrowserExtensionStream('one');
    const text = 'x'.repeat(10_000);
    view.accept(agent({ text }));
    view.accept(
      chat('final', {
        content: text.slice(0, 8_000),
        __openclaw: { truncated: true },
      }),
    );
    expect(view.project().turns.flatMap(turn => turn.items)).toMatchObject([
      { type: 'agentMessage', text },
    ]);
    view.finish(true);
    view.setHistory({ id: 'one', turns: [] });
    expect(view.project().turns.flatMap(turn => turn.items)).toMatchObject([
      { type: 'agentMessage', text },
    ]);
  });
  it.each(['NO_REPLY', 'NO_RE', 'HEARTBEAT_OK', 'The agent run failed before producing a reply.'])(
    'hides control text %s without losing final lifecycle',
    text => {
      expect(prepare(agent({ text }))).toBeNull();
      expect(prepare(chat('delta', { content: text }))).toBeNull();
      expect(prepare(chat('final', { content: text }))).toMatchObject({
        kind: 'chat',
        event: { state: 'final', message: undefined },
      });
    },
  );
  it('does not replace full streamed content with a truncated final preview', () => {
    expect(
      prepare(
        chat('final', {
          content: 'preview',
          __openclaw: { truncated: true },
        }),
      ),
    ).toMatchObject({ event: { state: 'final', message: undefined } });
    expect(prepare(chat('final', { content: 'complete' }))).toMatchObject({
      event: { message: { content: 'complete' } },
    });
  });
  it('preserves whitespace deltas, ordinary token mentions and rollback events', () => {
    for (const data of [
      { delta: ' ' },
      { text: 'The HEARTBEAT_OK token is described here.' },
      { justdoTerminalGuardObservation: { token: 'a', action: 'rollback' } },
    ])
      expect(prepare(agent(data))).toEqual(agent(data));
  });
  it('removes a trailing silent marker from visible answers', () => {
    expect(prepare(agent({ text: 'Answer\nNO_REPLY' }))).toMatchObject({
      event: { data: { text: 'Answer' } },
    });
    expect(
      prepare(chat('final', { content: [{ type: 'text', text: 'AnswerNO_REPLY' }] })),
    ).toMatchObject({ event: { message: { content: 'Answer' } } });
  });
});
