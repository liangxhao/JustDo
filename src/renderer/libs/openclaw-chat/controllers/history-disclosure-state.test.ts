/** @vitest-environment jsdom */
import { expect, test } from 'vitest';

import { HistoryDisclosureState } from './history-disclosure-state';

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

test('carries a partial process choice when paging reveals the beginning of the same group', () => {
  const state = new HistoryDisclosureState();
  state.reset('native-session');
  expect(state.expanded('partial-group', false, ['native-commentary'])).toBe(false);
  const root = document.createElement('div');
  root.innerHTML = '<details data-completed-process-key="partial-group" open></details>';
  state.capture(root);
  expect(state.expanded('whole-group', false, ['native-thinking', 'native-commentary'])).toBe(true);
  expect(state.expanded('unrelated-group', false, ['different-source'])).toBe(false);
  state.clear();
  expect(state.expanded('whole-group', false, ['native-thinking', 'native-commentary'])).toBe(
    false,
  );
});
