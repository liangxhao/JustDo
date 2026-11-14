import { describe, expect, it, vi } from 'vitest';

import { readSessionExportHistory, type SessionExportHistoryRequest } from './sessionExportHistory';

const sessionKey = 'agent:main:justdo:export-source';
const nativeSessionId = 'native-source';
const sessionInfo = { key: sessionKey, sessionId: nativeSessionId, lifecycleRevision: 'rev1' };
const message = (id: string, content: unknown, role = 'user') => ({
  role,
  content,
  __openclaw: { id },
});
const page = (messages: unknown[], extra: Record<string, unknown> = {}) => ({
  sessionKey,
  sessionId: nativeSessionId,
  sessionInfo,
  messages,
  totalMessages: 6,
  hasMore: false,
  ...extra,
});
const delta = (extra: Record<string, unknown> = {}) => ({
  kind: 'delta',
  deltaCursor: 'final',
  sessionInfo,
  messages: [],
  ...extra,
});

function fixture(request: SessionExportHistoryRequest) {
  const pages: unknown[][] = [];
  const read = (id: string | undefined = nativeSessionId) =>
    readSessionExportHistory({
      request,
      sessionKey,
      nativeSessionId: id,
      onPage: async messages => {
        pages.unshift([...messages]);
      },
    });
  return { pages, read };
}

describe('session export history', () => {
  it('collects all visible pages in transcript order, preserving overlapping display siblings', async () => {
    const oldest = message('first', 'same text');
    const newerRepeat = message('second', 'same text');
    const commentary = {
      ...message('third', 'in progress', 'assistant'),
      openclawStreamFallback: { source: 'segment' },
    };
    const reply = message('third', 'final reply', 'assistant');
    const hidden = { ...message('fourth', 'internal instructions'), display: false };
    const newest = message('fifth', 'newest', 'assistant');
    const request = vi
      .fn<SessionExportHistoryRequest>()
      .mockResolvedValueOnce(
        page([commentary, reply, hidden, newest], {
          hasMore: true,
          nextOffset: 3,
          deltaCursor: 'initial',
          sessionInfo: { ...sessionInfo, model: 'native/model' },
        }),
      )
      .mockResolvedValueOnce(
        page([newerRepeat, commentary, reply], { hasMore: true, nextOffset: 5 }),
      )
      .mockResolvedValueOnce(page([oldest]))
      .mockResolvedValueOnce(delta());
    const { pages, read } = fixture(request);

    const result = await read();

    expect(pages.flat()).toEqual([oldest, newerRepeat, commentary, reply, newest]);
    expect(
      request.mock.calls.map(([method, params]) => [
        method,
        params.sessionKey,
        params.cursor ?? params.offset,
      ]),
    ).toEqual([0, 3, 5, 'initial'].map(offset => ['chat.history', sessionKey, offset]));
    expect(result).toEqual({
      runtimeSessionId: nativeSessionId,
      messageCount: 5,
      model: 'native/model',
    });
  });

  it('restores display siblings cut by the head count cap with the same physical message anchor', async () => {
    const oldest = message('before-anchor', 'older');
    const commentary = {
      ...message('anchor', 'earlier visible activity', 'assistant'),
      openclawStreamFallback: { source: 'segment' },
    };
    const reply = message('anchor', 'reply', 'assistant');
    const newer = Array.from({ length: 249 }, (_, index) =>
      message(`after-${index}`, `Text ${index}`),
    );
    const request = vi
      .fn<SessionExportHistoryRequest>()
      .mockResolvedValueOnce(
        page([reply, ...newer], {
          hasMore: true,
          nextOffset: 250,
          totalMessages: 251,
          deltaCursor: 'initial',
        }),
      )
      .mockResolvedValueOnce({
        sessionKey,
        sessionId: nativeSessionId,
        sessionInfo,
        messages: [oldest, commentary, reply, newer[0]],
      })
      .mockResolvedValueOnce(page([oldest], { totalMessages: 251 }))
      .mockResolvedValueOnce(delta());
    const { pages, read } = fixture(request);

    await expect(read()).resolves.toMatchObject({ messageCount: 252 });

    expect(pages.flat()).toEqual([oldest, commentary, reply, ...newer]);
    expect(request).toHaveBeenNthCalledWith(
      2,
      'chat.history',
      expect.objectContaining({
        sessionKey,
        sessionId: nativeSessionId,
        messageId: 'anchor',
      }),
    );
  });

  it.each([
    ['another instance', page([], { sessionId: 'replacement' })],
    ['same-sized reset', page([], { windowReset: true })],
    ['different total', page([], { totalMessages: 7 })],
  ])('rejects a history page from %s', async (_case, changed) => {
    const { read } = fixture(
      vi
        .fn<SessionExportHistoryRequest>()
        .mockResolvedValueOnce(
          page([message('tail', 'tail')], { hasMore: true, nextOffset: 3, deltaCursor: 'initial' }),
        )
        .mockResolvedValueOnce(changed),
    );

    await expect(read()).rejects.toMatchObject({ reason: 'history_changed' });
  });

  it('rejects an advancing-looking partial chain that repeats the same offset', async () => {
    const request = vi
      .fn<SessionExportHistoryRequest>()
      .mockResolvedValueOnce(page([], { hasMore: true, nextOffset: 3, deltaCursor: 'initial' }))
      .mockResolvedValueOnce(page([], { hasMore: true, nextOffset: 3 }));
    const { read } = fixture(request);

    await expect(read()).rejects.toMatchObject({ reason: 'history_unavailable' });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['reset', { kind: 'reset' }, 'history_changed'],
    ['appended message', delta({ messages: [message('new', 'later')] }), 'history_changed'],
    ['native run', delta({ sessionInfo: { ...sessionInfo, hasActiveRun: true } }), 'running'],
  ])(
    'rejects the completed read when final verification sees a %s',
    async (_case, verification, reason) => {
      const { read } = fixture(
        vi
          .fn<SessionExportHistoryRequest>()
          .mockResolvedValueOnce(page([message('tail', 'tail')], { deltaCursor: 'initial' }))
          .mockResolvedValueOnce(verification),
      );

      await expect(read()).rejects.toMatchObject({ reason });
    },
  );

  it.each(['stable', 'changed'])(
    'verifies the head on archived history without a delta cursor (%s)',
    async scenario => {
      const source = page([message('tail', 'tail')], { totalMessages: 1 });
      const request = vi
        .fn<SessionExportHistoryRequest>()
        .mockResolvedValueOnce(source)
        .mockResolvedValueOnce(
          scenario === 'stable' ? source : page([message('tail', 'edited')], { totalMessages: 1 }),
        );
      const { pages, read } = fixture(request);

      if (scenario === 'stable') {
        await expect(read()).resolves.toMatchObject({ messageCount: 1 });
        expect(pages.flat()).toEqual(source.messages);
      } else {
        await expect(read()).rejects.toMatchObject({ reason: 'history_changed' });
      }
      expect(request.mock.calls.map(([, params]) => params.offset)).toEqual([0, 0]);
    },
  );

  it('accepts an explicitly empty new conversation without inventing a physical session ID', async () => {
    const request = vi
      .fn<SessionExportHistoryRequest>()
      .mockResolvedValue({ sessionKey, messages: [], hasMore: false, totalMessages: 0 });
    const onPage = vi.fn();

    await expect(readSessionExportHistory({ request, sessionKey, onPage })).resolves.toMatchObject({
      runtimeSessionId: null,
      messageCount: 0,
    });
    expect(onPage).not.toHaveBeenCalled();
  });

  it('hydrates capped rows and tool arguments with exact native identity', async () => {
    const placeholder = {
      ...message('older', 'placeholder'),
      __openclaw: { id: 'older', truncated: true },
    };
    const user = message('older', 'whole message');
    const withTool = message(
      'newer',
      [
        { type: 'toolCall', name: 'exec', id: 'visible-tool' },
        { type: 'toolCall', name: 'sessions_yield', id: 'private-yield' },
      ],
      'assistant',
    );
    const request = vi.fn<SessionExportHistoryRequest>(async (method, params) => {
      if (method === 'chat.message.get') return { ok: true, message: user };
      if (method === 'runtimeServices.historyDetails')
        return {
          sessionId: nativeSessionId,
          toolInputs: { 'visible-tool': { name: 'exec', input: { command: 'pwd' } } },
          compactionDetails: {},
        };
      return params.cursor ? delta() : page([placeholder, withTool], { deltaCursor: 'initial' });
    });
    const { pages, read } = fixture(request);

    await expect(read()).resolves.toMatchObject({ messageCount: 2 });

    expect(request).toHaveBeenCalledWith(
      'chat.message.get',
      expect.objectContaining({ sessionKey, sessionId: nativeSessionId, messageId: 'older' }),
    );
    expect(request).toHaveBeenCalledWith('runtimeServices.historyDetails', {
      sessionKey,
      sessionId: nativeSessionId,
      toolCallIds: ['visible-tool'],
    });
    expect(pages.flat()).toEqual([
      user,
      message(
        'newer',
        [{ ...withTool.content[0], arguments: { command: 'pwd' } }, withTool.content[1]],
        'assistant',
      ),
    ]);
  });

  it('fails safely when an oversized assistant source cannot be recovered as display history', async () => {
    const request = vi
      .fn<SessionExportHistoryRequest>()
      .mockResolvedValueOnce(
        page(
          [
            {
              ...message('large', 'placeholder', 'assistant'),
              __openclaw: { id: 'large', truncated: true },
            },
          ],
          { deltaCursor: 'initial' },
        ),
      )
      .mockResolvedValueOnce({ ok: false, unavailableReason: 'oversized' });
    const { pages, read } = fixture(request);

    await expect(read()).rejects.toMatchObject({ reason: 'history_unavailable' });
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'chat.history',
      'chat.message.get',
    ]);
    expect(pages).toEqual([]);
  });

  it('recovers a plain text row through chunks without transferring private source fields into the export', async () => {
    const source = message('large', 'full text');
    const placeholder = {
      ...source,
      content: 'placeholder',
      __openclaw: { id: 'large', truncated: true },
    };
    const serialized = JSON.stringify({ ...source, providerReplay: 'private replay state' });
    const splitAt = Math.floor(serialized.length / 2);
    const request = vi
      .fn<SessionExportHistoryRequest>()
      .mockResolvedValueOnce(page([placeholder], { deltaCursor: 'initial' }))
      .mockResolvedValueOnce({ ok: false, unavailableReason: 'oversized' })
      .mockResolvedValueOnce({
        ok: true,
        chunk: serialized.slice(0, splitAt),
        nextCursor: splitAt,
        transferId: 'pinned',
      })
      .mockResolvedValueOnce({
        ok: true,
        chunk: serialized.slice(splitAt),
        complete: true,
        transferId: 'pinned',
      })
      .mockResolvedValueOnce(delta());
    const { pages, read } = fixture(request);

    await expect(read()).resolves.toMatchObject({ messageCount: 1 });
    expect(pages.flat()).toEqual([source]);
    expect(request).toHaveBeenNthCalledWith(
      4,
      'runtimeServices.historyMessage',
      expect.objectContaining({
        sessionKey,
        sessionId: nativeSessionId,
        messageId: 'large',
        cursor: splitAt,
        transferId: 'pinned',
      }),
    );
  });
});
