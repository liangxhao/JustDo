// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { afterEach, expect, test } from 'vitest';

import { useDisplayTabOrder } from './useDisplayTabOrder';
import { useDisplayTabSelection } from './useDisplayTabSelection';
import { useSessionDisplayState } from './useSessionDisplayState';

afterEach(cleanup);

function renderSelection(sessionId = 'session', ids = ['app:team']) {
  return renderHook(({ sessionId, ids }) => {
    const display = useSessionDisplayState(sessionId, 520);
    const { orderedIds } = useDisplayTabOrder(display.state.runtimeId, ids);
    const selected = useDisplayTabSelection(
      display.state.runtimeId,
      orderedIds,
      display.state.preferredDisplayTabId,
      display.setters.setPreferredDisplayTabId,
    );
    return { display, selected };
  }, { initialProps: { sessionId, ids } });
}

test('commits an implicit visible tab before a background browser page is appended', () => {
  const { result, rerender } = renderSelection();
  expect(result.current.selected).toBe('app:team');
  expect(result.current.display.state.preferredDisplayTabId).toBe('app:team');

  rerender({ sessionId: 'session', ids: ['browser:child', 'app:team'] });

  expect(result.current.selected).toBe('app:team');
  expect(result.current.display.state.preferredDisplayTabId).toBe('app:team');
  act(() => result.current.display.setters.setPreferredDisplayTabId('browser:child'));
  expect(result.current.selected).toBe('browser:child');
});

test('uses the existing last-tab fallback only when the selected tab disappears', () => {
  const { result, rerender } = renderSelection('session', ['browser:a', 'terminal:b']);
  expect(result.current.selected).toBe('terminal:b');
  rerender({ sessionId: 'session', ids: ['browser:a', 'terminal:b', 'app:team'] });
  expect(result.current.selected).toBe('terminal:b');

  rerender({ sessionId: 'session', ids: ['browser:a', 'app:team'] });
  expect(result.current.selected).toBe('app:team');
  expect(result.current.display.state.preferredDisplayTabId).toBe('app:team');
  rerender({ sessionId: 'session', ids: [] });
  expect(result.current.selected).toBeNull();
  expect(result.current.display.state.preferredDisplayTabId).toBeNull();
});

test('keeps selection in the owning session across switching and runtime promotion', () => {
  const { result, rerender } = renderSelection('a', ['app:team']);
  const runtimeId = result.current.display.state.runtimeId;
  rerender({ sessionId: 'b', ids: ['terminal:b'] });
  expect(result.current.selected).toBe('terminal:b');
  rerender({ sessionId: 'a', ids: ['app:team', 'browser:child'] });
  expect(result.current.selected).toBe('app:team');

  act(() => result.current.display.promote('a', 'promoted'));
  rerender({ sessionId: 'promoted', ids: ['app:team', 'browser:child'] });
  expect(result.current.display.state.runtimeId).toBe(runtimeId);
  expect(result.current.selected).toBe('app:team');
});

test('does not overwrite an explicit selection queued by an earlier layout effect', () => {
  const { result } = renderHook(() => {
    const display = useSessionDisplayState('session', 520);
    useLayoutEffect(() => {
      display.setters.setPreferredDisplayTabId('browser:user-opened');
    }, [display.setters]);
    const selected = useDisplayTabSelection(
      display.state.runtimeId,
      ['browser:user-opened', 'app:team'],
      display.state.preferredDisplayTabId,
      display.setters.setPreferredDisplayTabId,
    );
    return { display, selected };
  });

  expect(result.current.selected).toBe('browser:user-opened');
  expect(result.current.display.state.preferredDisplayTabId).toBe('browser:user-opened');
});
