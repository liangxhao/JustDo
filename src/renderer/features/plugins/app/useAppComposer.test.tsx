// @vitest-environment jsdom
import { SessionGoalStatus } from '@shared/cowork/sessionGoal';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { readAppInput } from '../../../../../plugins/extensions/runtime-services/contracts/app-input';
import type { AppMode } from './browserRegistry';
import { blocksAppComposerSubmission } from './composerAdmission';
const fixture = vi.hoisted(() => ({
  modes: [] as AppMode[],
  listeners: new Set<() => void>(),
}));
vi.mock('./runtime', () => ({
  appBrowserRegistry: {
    subscribe: (listener: () => void) => {
      fixture.listeners.add(listener);
      return () => fixture.listeners.delete(listener);
    },
    getModes: () => fixture.modes,
  },
}));
import { useAppComposer } from './useAppComposer';
afterEach(() => {
  cleanup();
  fixture.modes = [];
});
function mode(
  prepare = vi.fn(async (input: { prompt: string }) => ({
    prompt: input.prompt + ' owner intent',
    input: { chosen: true },
  })),
): AppMode {
  return {
    id: 'example',
    pluginId: 'example-plugin',
    epoch: crypto.randomUUID(),
    labelKey: 'example',
    ordinaryTurnOnly: true,
    prepare,
  };
}

test('projects declared menu order, grouped choices and the atomic selection token independently of load order', () => {
  const group = {
    id: 'choices',
    labelKey: 'Group',
    icon: 'group-icon',
    order: 20,
    backLabelKey: 'Back to features',
  };
  const first = {
    ...mode(),
    id: 'first',
    labelKey: 'First',
    group,
    order: 0,
    icon: 'first-icon',
    removeLabelKey: 'Remove grouped mode',
  };
  const second = {
    ...mode(),
    id: 'second',
    labelKey: 'Second',
    group,
    order: 1,
    icon: 'second-icon',
  };
  const direct = {
    ...mode(),
    pluginId: 'other-plugin',
    id: 'direct',
    labelKey: 'Direct',
    order: 10,
    descriptionKey: 'Direct details',
    selectionCaret: 'start' as const,
  };
  fixture.modes = [second, first, direct];
  const onSelected = vi.fn();
  const draft = crypto.randomUUID();
  const active = renderHook(() => useAppComposer(draft, true, onSelected));
  expect(active.result.current.features.map(item => item.label)).toEqual(['Direct', 'Group']);
  expect(active.result.current.features[0].description).toBe('Direct details');
  const choices = active.result.current.features[1];
  expect(choices.backLabel).toBe('Back to features');
  expect(choices.children?.map(item => [item.label, item.section])).toEqual([
    ['First', undefined],
    ['Second', undefined],
  ]);
  act(() => choices.children![0].onSelect());
  expect(onSelected).toHaveBeenLastCalledWith(first);
  expect(active.result.current.features[1].selected).toBe(true);
  expect(active.result.current.token).toEqual({
    label: 'Group · First',
    icon: 'first-icon',
    removeLabel: 'Remove grouped mode',
  });
  const previous = active.result.current.selection;
  act(() => active.result.current.features[1].children![0].onSelect());
  expect(active.result.current.selection).not.toBe(previous);
  expect(active.result.current.selected).toBe(first);
  act(() => active.result.current.features[0].onSelect());
  expect(onSelected).toHaveBeenLastCalledWith(direct);
  expect(active.result.current.token?.label).toBe('Direct');
  expect(active.result.current.features[1].selected).toBe(false);
  act(() => active.result.current.clear());
  expect(active.result.current.token).toBeUndefined();
});

test('captures mode selection before an unrelated preparation wait and rejects retirement or replacement', () => {
  const owner = mode();
  fixture.modes = [owner];
  const view = renderHook(() => useAppComposer('captured-mode-wait', true));
  const ordinary = view.result.current.isCurrentSelection;
  act(() => view.result.current.features[0].onSelect());
  expect(ordinary()).toBe(false);
  const selected = view.result.current.isCurrentSelection;
  expect(selected()).toBe(true);
  fixture.modes = [];
  // The registry proof is rechecked even before React processes its notification.
  expect(selected()).toBe(false);
  act(() => {
    fixture.listeners.forEach(listener => listener());
  });
  const idle = view.result.current.isCurrentSelection;
  expect(idle()).toBe(true);
  fixture.modes = [mode()];
  act(() => {
    fixture.listeners.forEach(listener => listener());
  });
  act(() => view.result.current.features[0].onSelect());
  expect(idle()).toBe(false);
  expect(selected()).toBe(false);
});
test('keeps ordinary chat independent and carries bounded plugin input through the native envelope', async () => {
  const owner = mode();
  fixture.modes = [owner];
  const view = renderHook(() => useAppComposer(crypto.randomUUID(), true));
  view.unmount();
  const key = crypto.randomUUID();
  const active = renderHook(() => useAppComposer(key, true));
  expect(await active.result.current.prepare({ prompt: 'ordinary' })).toEqual({
    prompt: 'ordinary',
    submission: undefined,
  });
  act(() => active.result.current.features[0].onSelect());
  const result = await active.result.current.prepare({ prompt: 'request' });
  expect(readAppInput(result.prompt)?.input).toMatchObject({
    pluginId: owner.pluginId,
    epoch: owner.epoch,
    mode: owner.id,
    input: { chosen: true },
  });
  act(() => active.result.current.accepted());
  expect(active.result.current.selected).toBeUndefined();
});
test('rejects a delayed prepare after disable and does not clear a new selection with an old acknowledgement', async () => {
  let resolve!: (value: { prompt: string }) => void;
  const owner = mode(
    vi.fn(
      () =>
        new Promise(done => {
          resolve = done;
        }),
    ) as never,
  );
  fixture.modes = [owner];
  const view = renderHook(({ draft }) => useAppComposer(draft, true), {
    initialProps: { draft: crypto.randomUUID() },
  });
  act(() => view.result.current.features[0].onSelect());
  const old = view.result.current;
  const pending = old.prepare({ prompt: 'request' });
  view.rerender({ draft: crypto.randomUUID() });
  act(() => view.result.current.features[0].onSelect());
  act(() => old.accepted());
  expect(view.result.current.selected).toBe(owner);
  act(() => {
    fixture.modes = [];
    fixture.listeners.forEach(listener => listener());
  });
  resolve({ prompt: 'late' });
  await expect(pending).rejects.toThrow('appPluginRetired');
  expect(view.result.current.features).toEqual([]);
});
test('denies special routes for ordinary-turn modes while preserving ordinary goal controls', () => {
  const input = { running: false, plan: false, prompt: 'work', completionFeedback: false };
  for (const goalStatus of Object.values(SessionGoalStatus).filter(
    status => status !== SessionGoalStatus.Complete,
  )) {
    expect(blocksAppComposerSubmission({ ordinaryTurnOnly: true }, { ...input, goalStatus })).toBe(
      true,
    );
    expect(blocksAppComposerSubmission(undefined, { ...input, goalStatus })).toBe(false);
  }
  for (const extra of [
    { plan: true },
    { prompt: '/plan work' },
    { completionFeedback: true },
    { running: true },
  ]) {
    expect(blocksAppComposerSubmission({ ordinaryTurnOnly: true }, { ...input, ...extra })).toBe(
      true,
    );
  }
  expect(
    blocksAppComposerSubmission(
      { ordinaryTurnOnly: true },
      { ...input, goalStatus: SessionGoalStatus.Complete },
    ),
  ).toBe(false);
});
