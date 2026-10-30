/** @vitest-environment jsdom */
import { expect, test } from 'vitest';

import { HistoryDisclosureState } from './history-disclosure-state';

test('does not retain a temporary automatic fold as an explicit expansion choice', () => {
  const state = new HistoryDisclosureState();
  state.reset('native-session');
  expect(state.expanded('process', false, ['source'])).toBe(false);
  const root = document.createElement('div');
  root.innerHTML = '<details data-completed-process-key="process" data-process-auto-fold open></details>';
  state.capture(root);
  expect(state.expanded('process', false, ['source'])).toBe(false);
  const details = root.querySelector('details')!;
  details.removeAttribute('data-process-auto-fold');
  state.capture(root);
  expect(state.expanded('process', false, ['source'])).toBe(true);
});

test('retains open and closed choices across window removal and returning summaries', () => {
  const state = new HistoryDisclosureState();
  state.reset('physical-session:history-1');
  const root = document.createElement('div');
  root.innerHTML = `<details data-completed-process-key="process" open>
    <details open><summary data-process-summary-key="thinking">Thinking</summary></details>
    <details><summary data-process-summary-key="tool">Tool</summary></details>
  </details>`;
  state.returningSummaries(['thinking', 'tool']);
  state.capture(root);
  root.replaceChildren();
  state.returningSummaries([]);
  expect(state.expanded('process', false)).toBe(true);
  expect(state.returningSummaries(['thinking', 'tool'])).toEqual({
    open: 'thinking',
    collapsed: ['tool'],
  });
  expect(state.returningSummaries(['thinking', 'tool'])).toEqual({ open: null, collapsed: [] });
  state.reset('physical-session:history-2');
  expect(state.expanded('process', false)).toBe(false);
  expect(state.returningSummaries(['thinking', 'tool'])).toEqual({ open: null, collapsed: [] });
});

test.each([false, true])(
  'keeps the latest choice across partial and whole process shapes (initially open: %s)',
  initialOpen => {
    const state = new HistoryDisclosureState();
    state.reset('native-session');
    expect(state.expanded('partial-group', false, ['native-commentary'])).toBe(false);
    const root = document.createElement('div');
    root.innerHTML = '<details data-completed-process-key="partial-group"></details>';
    root.querySelector('details')!.open = initialOpen;
    state.capture(root);
    const wholeSources = ['native-thinking', 'native-commentary'];
    expect(state.expanded('whole-group', false, wholeSources)).toBe(initialOpen);
    root.innerHTML = '<details data-completed-process-key="whole-group"></details>';
    root.querySelector('details')!.open = !initialOpen;
    state.capture(root);
    expect(state.expanded('partial-group', initialOpen, ['native-commentary'])).toBe(!initialOpen);
    root.innerHTML = '<details data-completed-process-key="partial-group"></details>';
    root.querySelector('details')!.open = initialOpen;
    state.capture(root);
    // The older whole-group member still has the opposite choice.
    expect(state.expanded('whole-group', !initialOpen, wholeSources)).toBe(initialOpen);
    expect(state.expanded('unrelated-group', false, ['different-source'])).toBe(false);
    state.clear();
    expect(state.expanded('whole-group', false, ['native-thinking', 'native-commentary'])).toBe(
      false,
    );
  },
);
