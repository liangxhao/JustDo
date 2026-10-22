// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';

import { useDisplayTabOrder } from './useDisplayTabOrder';

afterEach(cleanup);

test('appends new tabs across types and keeps existing tabs in opening order', () => {
  const { result, rerender } = renderHook(({ ids }) => useDisplayTabOrder('session', ids), {
    initialProps: { ids: ['terminal:1'] },
  });
  rerender({ ids: ['browser:blank', 'terminal:1'] });
  expect(result.current.orderedIds).toEqual(['terminal:1', 'browser:blank']);
  rerender({ ids: ['review', 'browser:blank', 'terminal:1'] });
  expect(result.current.orderedIds).toEqual(['terminal:1', 'browser:blank', 'review']);
  rerender({ ids: ['review', 'browser:blank'] });
  rerender({ ids: ['review', 'browser:blank', 'terminal:1'] });
  expect(result.current.orderedIds).toEqual(['browser:blank', 'review', 'terminal:1']);
});

test('retains independent tab order when switching sessions', () => {
  const { result, rerender } = renderHook(({ session, ids }) => useDisplayTabOrder(session, ids), {
    initialProps: { session: 'a', ids: ['terminal:1'] },
  });
  rerender({ session: 'a', ids: ['browser:1', 'terminal:1'] });
  rerender({ session: 'b', ids: ['review'] });
  rerender({ session: 'a', ids: ['browser:1', 'terminal:1'] });
  expect(result.current.orderedIds).toEqual(['terminal:1', 'browser:1']);
});

test('replaces a blank tab in place while its close notification is pending', () => {
  const { result, rerender } = renderHook(({ ids }) => useDisplayTabOrder('runtime', ids), {
    initialProps: { ids: ['browser:blank', 'terminal:1'] },
  });
  act(() => {
    result.current.replaceTab('browser:blank', 'files');
    rerender({ ids: ['browser:blank', 'terminal:1', 'files'] });
  });
  expect(result.current.orderedIds).toEqual(['files', 'browser:blank', 'terminal:1']);
  rerender({ ids: ['terminal:1', 'files'] });
  expect(result.current.orderedIds).toEqual(['files', 'terminal:1']);
});

test('keeps an existing singleton tool in its position when replacing a blank tab', () => {
  const { result, rerender } = renderHook(({ ids }) => useDisplayTabOrder('runtime', ids), {
    initialProps: { ids: ['browser:blank', 'terminal:1', 'files'] },
  });
  act(() => {
    result.current.replaceTab('browser:blank', 'files');
    rerender({ ids: ['terminal:1', 'files'] });
  });
  expect(result.current.orderedIds).toEqual(['terminal:1', 'files']);
});

test('preserves ordering when home tabs are promoted with their runtime identity', () => {
  const { result, rerender } = renderHook(({ runtime, ids }) => useDisplayTabOrder(runtime, ids), {
    initialProps: { runtime: 'home-runtime', ids: ['terminal:1'] },
  });
  rerender({ runtime: 'home-runtime', ids: ['browser:1', 'terminal:1'] });
  // Promotion changes the conversation key, while its runtime identity survives.
  rerender({ runtime: 'home-runtime', ids: ['browser:1', 'terminal:1'] });
  expect(result.current.orderedIds).toEqual(['terminal:1', 'browser:1']);
  rerender({ runtime: 'new-home-runtime', ids: ['files'] });
  expect(result.current.orderedIds).toEqual(['files']);
  rerender({ runtime: 'home-runtime', ids: ['browser:1', 'terminal:1'] });
  expect(result.current.orderedIds).toEqual(['terminal:1', 'browser:1']);
});
