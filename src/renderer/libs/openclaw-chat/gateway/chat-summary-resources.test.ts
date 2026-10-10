import { afterEach, expect, it, vi } from 'vitest';

import { ChatSummaryResourceObserver } from './chat-summary-resources';

afterEach(() => vi.useRealTimers());
const artifact = (id: string) => ({
  id,
  title: `${id}.txt`,
  type: 'file',
  download: { mode: 'bytes' },
});
function fixture() {
  vi.useFakeTimers();
  const request = vi.fn().mockResolvedValue({ artifacts: [artifact('one')] });
  const state = {
    sessionKey: 'a',
    connected: true,
    ready: true,
    running: false,
    messages: [] as unknown[],
    client: { request },
  };
  const changed = vi.fn();
  const observer = new ChatSummaryResourceObserver(() => state, changed);
  return { observer, state, request, changed };
}

it('uses assistant-only native metadata with no image-only pagination, and coalesces stream updates', async () => {
  const { observer, request, changed } = fixture();
  observer.publish();
  observer.publish();
  observer.publish();
  await vi.advanceTimersByTimeAsync(500);
  expect(request).toHaveBeenCalledExactlyOnceWith('artifacts.list', {
    sessionKey: 'a',
    messageRole: 'assistant',
  });
  expect(changed.mock.lastCall?.[0].outputs[0].title).toBe('one.txt');
  observer.publish();
  await vi.advanceTimersByTimeAsync(500);
  expect(request).toHaveBeenCalledTimes(1);
  observer.dispose();
});

it('fences a late read after switching away and back, without publishing artifacts into another chat', async () => {
  const { observer, state, request, changed } = fixture();
  let resolve!: (value: unknown) => void;
  request.mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done;
      }),
  );
  observer.publish();
  await vi.advanceTimersByTimeAsync(500);
  state.sessionKey = 'b';
  observer.publish();
  state.sessionKey = 'a';
  observer.publish();
  resolve({ artifacts: [artifact('stale')] });
  await Promise.resolve();
  expect(
    changed.mock.calls.some(([snapshot]) =>
      snapshot.outputs.some((item: { title: string }) => item.title === 'stale.txt'),
    ),
  ).toBe(false);
  await vi.advanceTimersByTimeAsync(500);
  expect(changed.mock.lastCall?.[0].outputs[0].title).toBe('one.txt');
  observer.dispose();
});

it('preserves known output metadata on a failed refresh', async () => {
  const { observer, state, request, changed } = fixture();
  observer.publish();
  await vi.advanceTimersByTimeAsync(500);
  request.mockRejectedValue(new Error('offline'));
  state.messages = [{ role: 'user', content: 'next turn' }];
  observer.publish();
  await vi.advanceTimersByTimeAsync(500);
  expect(changed.mock.lastCall?.[0]).toMatchObject({
    outputsUnavailable: true,
    outputs: [{ title: 'one.txt' }],
  });
  observer.dispose();
});

it('publishes confirmed sources after native history readiness and clears them on a session switch', async () => {
  const { observer, state, changed } = fixture();
  state.ready = false;
  state.messages = [
    {
      role: 'user',
      __openclaw: { media: [{ path: 'E:/project/input.pdf', fileName: 'input.pdf' }] },
      content: 'Use this file',
    },
  ];
  observer.publish();
  await vi.advanceTimersByTimeAsync(500);
  expect(changed.mock.lastCall?.[0].sources).toEqual([]);

  state.ready = true;
  observer.publish();
  await vi.advanceTimersByTimeAsync(500);
  expect(changed.mock.lastCall?.[0].sources).toMatchObject([
    { title: 'input.pdf', target: { kind: 'file', path: 'E:/project/input.pdf' } },
  ]);

  state.sessionKey = 'b';
  state.ready = false;
  observer.publish();
  expect(changed.mock.lastCall?.[0]).toMatchObject({ sessionKey: 'b', sources: [] });
  observer.dispose();
});

it('publishes sources when native nested web results arrive in the loaded history', async () => {
  const { observer, state, changed } = fixture();
  observer.publish();
  await vi.advanceTimersByTimeAsync(500);
  expect(changed.mock.lastCall?.[0].sources).toEqual([]);

  state.messages = [
    {
      role: 'custom',
      customType: 'openclaw.nested-tool.v1',
      display: true,
      excludeFromContext: true,
      content: [
        { type: 'toolCall', id: 'nested-call', name: 'web_search', arguments: {} },
        {
          type: 'toolResult',
          role: 'toolResult',
          toolName: 'web_search',
          toolCallId: 'nested-call',
          isError: false,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                kind: 'results',
                results: [{ url: 'https://example.com/guide' }],
                externalContent: { source: 'web_search', untrusted: true, wrapped: true },
              }),
            },
          ],
        },
      ],
    },
  ];
  observer.publish();
  await vi.advanceTimersByTimeAsync(500);
  expect(changed.mock.lastCall?.[0].sources).toEqual([
    {
      id: 'url:https://example.com/guide',
      title: 'example.com',
      target: { kind: 'url', url: 'https://example.com/guide' },
    },
  ]);
  observer.dispose();
});

it('does not read native artifacts before history readiness, and disposes scheduled reads', async () => {
  const { observer, state, request, changed } = fixture();
  state.ready = false;
  state.messages = [{ role: 'assistant', content: '[old](./old.md)' }];
  observer.publish();
  await vi.advanceTimersByTimeAsync(500);
  expect(request).not.toHaveBeenCalled();
  expect(changed.mock.lastCall?.[0].outputs).toEqual([]);
  state.ready = true;
  observer.publish();
  observer.dispose();
  await vi.advanceTimersByTimeAsync(500);
  expect(request).not.toHaveBeenCalled();
});
