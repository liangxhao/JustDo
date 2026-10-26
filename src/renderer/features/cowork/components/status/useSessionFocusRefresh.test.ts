// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({ currentId: 'persisted', loadSession: vi.fn() }));
vi.mock('@/features/cowork/coworkService', () => ({ coworkService: { loadSession: state.loadSession } }));
vi.mock('@/store', () => ({ store: {
  getState: () => ({ cowork: { currentSession: state.currentId ? { id: state.currentId } : null } }),
} }));

import { useSessionFocusRefresh } from './useSessionFocusRefresh';

beforeEach(() => {
  state.currentId = 'persisted';
  state.loadSession.mockReset().mockResolvedValue(null);
});
afterEach(() => vi.restoreAllMocks());

test.each([
  ['temp-pending', true], ['persisted', false], [undefined, true],
] as const)('does not read non-persisted or disabled focus metadata (%s, %s)', (id, enabled) => {
  const view = renderHook(() => useSessionFocusRefresh(id, enabled));
  act(() => window.dispatchEvent(new Event('focus')));
  expect(state.loadSession).not.toHaveBeenCalled();
  view.unmount();
});

test('refreshes a persisted running conversation and revokes selection after navigation or cleanup', () => {
  const view = renderHook(({ id }) => useSessionFocusRefresh(id, true), { initialProps: { id: 'persisted' } });
  act(() => window.dispatchEvent(new Event('focus')));
  expect(state.loadSession).toHaveBeenCalledExactlyOnceWith('persisted', { canSelect: expect.any(Function) });
  const first = state.loadSession.mock.calls[0][1].canSelect;
  expect(first()).toBe(true);
  state.currentId = 'temp-next';
  expect(first()).toBe(false);
  state.currentId = 'persisted';
  view.rerender({ id: 'replacement' });
  expect(first()).toBe(false);
  state.currentId = 'replacement';
  act(() => window.dispatchEvent(new Event('focus')));
  expect(state.loadSession).toHaveBeenCalledTimes(2);
  const second = state.loadSession.mock.calls[1][1].canSelect;
  expect(second()).toBe(true);
  view.unmount();
  expect(second()).toBe(false);
  act(() => window.dispatchEvent(new Event('focus')));
  expect(state.loadSession).toHaveBeenCalledTimes(2);
});

test.each([false, true])('handles a rejected focus read and suppresses stale diagnostics (stale=%s)', async stale => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  let fail!: (error: Error) => void;
  const failure = new Error('IPC connection closed');
  state.loadSession.mockReturnValue(new Promise((_resolve, reject) => { fail = reject; }));
  const view = renderHook(() => useSessionFocusRefresh('persisted', true));
  act(() => window.dispatchEvent(new Event('focus')));
  if (stale) state.currentId = 'temp-next';
  await act(async () => { fail(failure); });
  if (stale) expect(log).not.toHaveBeenCalled();
  else expect(log).toHaveBeenCalledWith('Failed to refresh focused session:', failure, 'sessionId=persisted');
  view.unmount();
});

test('retires earlier focus reads even when the selected session ID stays the same', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  let fail!: (error: Error) => void;
  state.loadSession.mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }))
    .mockResolvedValueOnce(null);
  const view = renderHook(() => useSessionFocusRefresh('persisted', true));
  act(() => window.dispatchEvent(new Event('focus')));
  const first = state.loadSession.mock.calls[0][1].canSelect;
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  expect(first()).toBe(false);
  expect(state.loadSession.mock.calls[1][1].canSelect()).toBe(true);
  await act(async () => { fail(new Error('Old IPC read failed')); });
  expect(log).not.toHaveBeenCalled();
  view.unmount();
});
