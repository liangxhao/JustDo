// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';

import { useSessionSummaryVisibility } from './useSessionSummaryVisibility';

afterEach(cleanup);
it('reveals the first meaningful result once, without reopening after dismissal or switching back', () => {
  const hook = renderHook(({ id, meaningful }) => useSessionSummaryVisibility(id, meaningful), {
    initialProps: { id: 'a', meaningful: false },
  });
  expect(hook.result.current.visible).toBe(false);
  hook.rerender({ id: 'a', meaningful: true });
  expect(hook.result.current.visible).toBe(true);
  act(() => hook.result.current.close());
  hook.rerender({ id: 'a', meaningful: false });
  hook.rerender({ id: 'a', meaningful: true });
  expect(hook.result.current.visible).toBe(false);
  hook.rerender({ id: 'b', meaningful: true });
  expect(hook.result.current.visible).toBe(true);
  hook.rerender({ id: 'a', meaningful: true });
  expect(hook.result.current.visible).toBe(false);
  act(() => hook.result.current.toggle());
  expect(hook.result.current.visible).toBe(true);
});

it('honors manual dismissal before data arrives', () => {
  const hook = renderHook(({ meaningful }) => useSessionSummaryVisibility('a', meaningful), {
    initialProps: { meaningful: false },
  });
  act(() => hook.result.current.toggle());
  act(() => hook.result.current.close());
  hook.rerender({ meaningful: true });
  expect(hook.result.current.visible).toBe(false);
});

it('carries dismissal and visibility through temporary chat promotion without a second automatic reveal', () => {
  const hook = renderHook(({ id }) => useSessionSummaryVisibility(id, true), {
    initialProps: { id: 'temp-a' },
  });
  expect(hook.result.current.visible).toBe(true);
  act(() => hook.result.current.promote('temp-a', 'canonical-a'));
  hook.rerender({ id: 'canonical-a' });
  expect(hook.result.current.visible).toBe(true);
  act(() => hook.result.current.close());
  hook.rerender({ id: 'temp-b' });
  act(() => hook.result.current.close());
  act(() => hook.result.current.promote('temp-b', 'canonical-b'));
  hook.rerender({ id: 'canonical-b' });
  expect(hook.result.current.visible).toBe(false);
});
