import { describe, expect, test, vi } from 'vitest';

import { CoworkStore } from './coworkStore';

const createStore = (permissionMode: unknown): CoworkStore => {
  const row = {
    id: 'session-1',
    title: 'Session',
    status: 'idle',
    pinned: 0,
    cwd: 'C:\\workspace',
    execution_mode: 'local',
    permission_mode: permissionMode,
    active_skill_ids: '[]',
    agent_id: 'main',
    created_at: 1,
    updated_at: 2,
  };
  const db = {
    prepare: (sql: string) => ({
      get: () => (sql.includes('FROM cowork_sessions') ? row : undefined),
      all: () => [],
    }),
  };
  return new CoworkStore(db as never);
};

describe('CoworkStore session permissions', () => {
  test('creates new sessions with full access by default', () => {
    const run = vi.fn();
    const store = new CoworkStore({ prepare: () => ({ run }) } as never);

    const session = store.createSession('New session', 'C:\\workspace');

    expect(session.permissionMode).toBe('full');
    expect(run.mock.calls[0]?.[4]).toBe('full');
  });

  test.each(['ask', 'auto', 'full'] as const)('restores stored %s permission', mode => {
    expect(createStore(mode).getSession('session-1')?.permissionMode).toBe(mode);
  });

  test.each([null, undefined, 'invalid'])('defaults missing permission %s to full', value => {
    expect(createStore(value).getSession('session-1')?.permissionMode).toBe('full');
  });
});
