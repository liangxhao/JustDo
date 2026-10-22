// @vitest-environment jsdom
import { configureStore } from '@reduxjs/toolkit';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import agentReducer, { setAgents } from '@/features/agents/agentSlice';

import { ConversationAgentSelector } from './ConversationAgentSelector';

vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));
const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
beforeEach(() => {
  // jsdom has no layout; keep the real dropdown visible within its viewport.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    top: 100, bottom: 132, left: 20, right: 220, width: 200, height: 32,
    x: 20, y: 100, toJSON: () => ({}),
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
});
const agent = (id: string, enabled = true, deletedAt?: number) => ({
  id,
  name: id,
  enabled,
  deletedAt,
  description: '',
  icon: '',
  model: '',
  isDefault: false,
  skillIds: [],
});
function mount(options: Partial<React.ComponentProps<typeof ConversationAgentSelector>> = {}) {
  const store = configureStore({ reducer: { agent: agentReducer } });
  store.dispatch(
    setAgents([
      agent('main'),
      agent('research'),
      agent('disabled', false),
      agent('deleted', true, 123),
    ]),
  );
  render(
    <Provider store={store}>
      <ConversationAgentSelector agentId="main" disabled={false} {...options} />
    </Provider>,
  );
  return store;
}
it('offers only available assistants and changes the next conversation recipient', async () => {
  const store = mount();
  fireEvent.click(screen.getByRole('combobox'));
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual([
    'main',
    'research',
  ]);
  fireEvent.click(screen.getByRole('option', { name: 'research' }));
  await waitFor(() => expect(store.getState().agent.currentAgentId).toBe('research'));
});
it('waits for the existing-conversation handoff without changing its displayed owner', async () => {
  let finish!: () => void;
  const onChange = vi.fn(
    () =>
      new Promise<void>(resolve => {
        finish = resolve;
      }),
  );
  const store = mount({ onChange });
  const select = screen.getByRole('combobox');
  fireEvent.click(select);
  fireEvent.click(screen.getByRole('option', { name: 'research' }));
  expect(onChange).toHaveBeenCalledWith('research');
  expect(select).toHaveProperty('disabled', true);
  expect(store.getState().agent.currentAgentId).toBe('main');
  finish();
  await waitFor(() => expect(select).toHaveProperty('disabled', false));
});
it('preserves the displayed owner of an unavailable historical assistant', () => {
  mount({ agentId: 'deleted', disabled: true });
  const trigger = screen.getByRole('combobox');
  expect(trigger.textContent).toBe('deleted');
  expect(trigger).toHaveProperty('disabled', true);
  fireEvent.click(trigger);
  expect(screen.queryByRole('listbox')).toBeNull();
});
it('reports a failed switch and leaves the conversation owner unchanged', async () => {
  const toast = vi.fn();
  window.addEventListener('app:showToast', toast);
  const store = mount({ onChange: vi.fn().mockRejectedValue(new Error('failed')) });
  fireEvent.click(screen.getByRole('combobox'));
  fireEvent.click(screen.getByRole('option', { name: 'research' }));
  await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
  expect(store.getState().agent.currentAgentId).toBe('main');
  window.removeEventListener('app:showToast', toast);
});
