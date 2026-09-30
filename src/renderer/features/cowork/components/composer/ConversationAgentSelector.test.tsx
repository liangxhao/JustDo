// @vitest-environment jsdom
import { configureStore } from '@reduxjs/toolkit';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, expect, it, vi } from 'vitest';

import agentReducer, { setAgents } from '@/features/agents/agentSlice';

import { ConversationAgentSelector } from './ConversationAgentSelector';

vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));
afterEach(cleanup);
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
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual([
    'main',
    'research',
  ]);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'research' } });
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
  fireEvent.change(select, { target: { value: 'research' } });
  expect(onChange).toHaveBeenCalledWith('research');
  expect(select).toHaveProperty('disabled', true);
  expect(store.getState().agent.currentAgentId).toBe('main');
  finish();
  await waitFor(() => expect(select).toHaveProperty('disabled', false));
});
it('preserves the displayed owner of an unavailable historical assistant', () => {
  mount({ agentId: 'deleted', disabled: true });
  expect(screen.getByRole('combobox')).toHaveProperty('value', 'deleted');
  expect(screen.getByRole('option', { name: 'deleted' })).toHaveProperty('disabled', true);
});
it('reports a failed switch and leaves the conversation owner unchanged', async () => {
  const toast = vi.fn();
  window.addEventListener('app:showToast', toast);
  const store = mount({ onChange: vi.fn().mockRejectedValue(new Error('failed')) });
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'research' } });
  await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
  expect(store.getState().agent.currentAgentId).toBe('main');
  window.removeEventListener('app:showToast', toast);
});
