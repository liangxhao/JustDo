// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import { getSessionStopOperationKey } from './sessionSubmission';
import { useSessionStop } from './useSessionStop';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('coalesces repeated clicks while the same session stop is in flight', async () => {
  let resolveStop!: (value: boolean) => void;
  const onStop = vi.fn(
    () =>
      new Promise<boolean>(resolve => {
        resolveStop = resolve;
      }),
  );
  const { result } = renderHook(() => useSessionStop('A', onStop));
  let first!: Promise<boolean>;
  let second!: Promise<boolean>;
  await act(async () => {
    first = result.current.requestStop();
    second = result.current.requestStop();
  });
  expect(first).toBe(second);
  expect(onStop).toHaveBeenCalledOnce();
  expect(result.current.isStopping).toBe(true);
  await act(async () => {
    resolveStop(true);
    await first;
  });
  expect(result.current.isStopping).toBe(false);
});

it('keeps stop state attached to A when navigating to B and back', async () => {
  let resolveStop!: (value: boolean) => void;
  const onStop = vi.fn(
    () =>
      new Promise<boolean>(resolve => {
        resolveStop = resolve;
      }),
  );
  const { result, rerender } = renderHook(({ sessionId }) => useSessionStop(sessionId, onStop), {
    initialProps: { sessionId: 'A' },
  });
  let request!: Promise<boolean>;
  await act(async () => {
    request = result.current.requestStop();
  });
  rerender({ sessionId: 'B' });
  expect(result.current.isStopping).toBe(false);
  rerender({ sessionId: 'A' });
  expect(result.current.isStopping).toBe(true);
  await act(async () => {
    resolveStop(true);
    await request;
  });
  expect(result.current.isStopping).toBe(false);
});

it.each(['rejected', 'unconfirmed'])('reports %s stop and allows retry', async outcome => {
  const onStop = vi
    .fn()
    .mockImplementationOnce(() => {
      if (outcome === 'rejected') throw new Error('gateway disconnected');
      return false;
    })
    .mockResolvedValue(true);
  const dispatch = vi.spyOn(window, 'dispatchEvent');
  const { result } = renderHook(() => useSessionStop('A', onStop));

  await act(async () => {
    expect(await result.current.requestStop()).toBe(false);
  });
  expect(result.current.isStopping).toBe(false);
  const event = dispatch.mock.calls[0][0] as CustomEvent;
  expect(event.type).toBe('app:showToast');
  expect(event.detail).toBe(i18nService.t('coworkStopFailed'));
  await act(async () => {
    expect(await result.current.requestStop()).toBe(true);
  });
  expect(onStop).toHaveBeenCalledTimes(2);
  expect(dispatch).toHaveBeenCalledOnce();
});

it('retains the stop lock through explicit promotion without locking another session', async () => {
  let finish!: (value: boolean) => void;
  const onStop = vi.fn(
    () =>
      new Promise<boolean>(resolve => {
        finish = resolve;
      }),
  );
  const pendingStart = {
    temporarySessionId: 'temp-A',
    canonicalSessionId: undefined as string | undefined,
  };
  const { result, rerender } = renderHook(
    ({ sessionId }) => useSessionStop(getSessionStopOperationKey(sessionId, pendingStart), onStop),
    {
      initialProps: { sessionId: 'temp-A' },
    },
  );
  let stopping!: Promise<boolean>;
  await act(async () => {
    stopping = result.current.requestStop();
  });
  pendingStart.canonicalSessionId = 'A';
  rerender({ sessionId: 'A' });
  expect(result.current.isStopping).toBe(true);
  expect(result.current.requestStop()).toBe(stopping);
  rerender({ sessionId: 'B' });
  expect(result.current.isStopping).toBe(false);
  rerender({ sessionId: 'A' });
  await act(async () => {
    finish(true);
    await stopping;
  });
  expect(result.current.isStopping).toBe(false);
  expect(onStop).toHaveBeenCalledOnce();
});
