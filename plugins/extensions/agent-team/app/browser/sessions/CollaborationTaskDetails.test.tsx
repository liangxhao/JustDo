// @vitest-environment jsdom
import { configureStore } from '@reduxjs/toolkit';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, expect, it, vi } from 'vitest';

import { coworkService } from '@/features/cowork/coworkService';
import { i18nService } from '@/services/i18n';

import CollaborationTaskDetails from './CollaborationTaskDetails';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('shows only assistant identities and opens the selected assistant details', async () => {
  i18nService.setLanguage('en', { persist: false });
  const session = {
    id: 'main-session',
    agentId: 'main',
    title: 'Task',
    status: 'idle' as const,
    pinned: false,
    createdAt: 1,
    updatedAt: 1,
    cwd: '/project',
    executionMode: 'local' as const,
    activeSkillIds: [],
    model: '',
    permissionMode: 'auto' as const,
  };
  vi.spyOn(coworkService, 'getSessionDetails').mockImplementation(async id =>
    id === session.id
      ? {
          session,
          stats: {
            totalTokens: 123,
            hasTokenUsage: true,
            models: ['model-a'],
            summary: null,
            messageCount: 4,
            userMessageCount: 1,
            assistantMessageCount: 3,
            toolCallCount: 2,
            tokenUsage: { input: 100, output: 23, cacheRead: 0, cacheWrite: 0 },
          },
        }
      : { session: null },
  );
  const select = vi.fn();
  const store = configureStore({
    reducer: {
      agent: () => ({
        agents: [
          { id: 'main', name: 'Main' },
          { id: 'review', name: 'Reviewer' },
        ],
      }),
    },
  });
  render(
    <Provider store={store}>
      <CollaborationTaskDetails
        onSelect={select}
        room={{
          id: 'room',
          anchorSessionId: session.id,
          members: [
            {
              agentId: 'main',
              sessionId: session.id,
              sessionKey: 'agent:main:justdo:main-session',
            },
            {
              agentId: 'review',
              sessionId: 'peer-session',
              sessionKey: 'agent:review:justdo:peer-session',
            },
          ],
        }}
      />
    </Provider>,
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Main' }).hasAttribute('disabled')).toBe(false),
  );
  expect(screen.queryByText('123')).toBeNull();
  expect(screen.queryByText('model-a')).toBeNull();
  expect(screen.getByRole('button', { name: /Reviewer/ }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: /Main/ }));
  expect(select).toHaveBeenCalledWith(session);
});
