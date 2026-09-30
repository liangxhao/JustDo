import { describe, expect, it } from 'vitest';

import { setConfig, updateConfig } from '@/features/cowork/coworkSlice';

import reducer, { setAgents, setCurrentAgentId, updateAgent } from './agentSlice';
const agent = (id: string, enabled = true, isDefault = false) => ({
  id,
  name: id,
  description: '',
  icon: '',
  model: '',
  skillIds: [],
  enabled,
  isDefault,
});
describe('new conversation agent selection', () => {
  it('starts on main and accepts only available conversation assistants', () => {
    let state = reducer(
      undefined,
      setAgents([agent('main'), agent('research', true, true), agent('disabled', false)]),
    );
    expect(state.currentAgentId).toBe('main');
    state = reducer(state, setCurrentAgentId('research'));
    expect(state.currentAgentId).toBe('research');
    state = reducer(state, setCurrentAgentId('disabled'));
    expect(state.currentAgentId).toBe('main');
    state = reducer(state, setCurrentAgentId('main'));
    expect(state.currentAgentId).toBe('main');
  });
  it('falls back to the default when the selected role is disabled', () => {
    const state = reducer(
      reducer(undefined, setAgents([agent('main'), agent('research', true, true)])),
      setCurrentAgentId('research'),
    );
    const next = reducer(state, setAgents([agent('main', true, true), agent('research', false)]));
    expect(next.currentAgentId).toBe('main');
  });
});

it('resets the selection when switching is disabled and keeps existing conversations untouched', () => {
  const selected = reducer(
    reducer(undefined, setAgents([agent('main'), agent('research')])),
    setCurrentAgentId('research'),
  );
  expect(reducer(selected, updateConfig({ allowMainAgentSwitch: false })).currentAgentId).toBe(
    'main',
  );
  expect(
    reducer(
      selected,
      setConfig({
        workingDirectory: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
        permissionMode: 'ask',
      }),
    ).currentAgentId,
  ).toBe('main');
  expect(
    reducer(selected, updateAgent({ id: 'research', updates: { deletedAt: 123 } })).currentAgentId,
  ).toBe('main');
  expect(reducer(selected, setAgents([agent('main'), agent('research')])).currentAgentId).toBe(
    'research',
  );
});
