// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRendererPreferences } from './rendererPreferences';

function fixture() {
  const records = new Map<string, unknown>();
  const store = {
    get: vi.fn(async (key: string) => records.get(key)),
    set: vi.fn(async (key: string, value: unknown) => {
      records.set(key, value);
    }),
  };
  const origin = () => ({ getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() });
  return { records, store, origin };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('renderer preferences across HTTP host restarts', () => {
  it('restores selected theme, filter, pet position and unsent feedback without the old origin', async () => {
    const { store, origin } = fixture();
    const firstOrigin = origin();
    const first = createRendererPreferences(
      () => store,
      () => firstOrigin,
    );
    await first.initialize();
    const preferences = {
      'justdo-theme-id': 'midnight',
      'justdo-pet-floating-position': '{"x":120,"y":80}',
      'justdo-scheduled-task-result-preferences-v1': '{"includeRoutine":true}',
      'justdo:goal-completion-feedback:session-1': '{"completedGoalId":"goal-1"}',
    };
    for (const [key, value] of Object.entries(preferences)) first.setItem(key, value);
    await first.flush();

    const secondOrigin = origin();
    const restarted = createRendererPreferences(
      () => store,
      () => secondOrigin,
    );
    await restarted.initialize();
    for (const [key, value] of Object.entries(preferences))
      expect(restarted.getItem(key)).toBe(value);
    expect(firstOrigin.setItem).not.toHaveBeenCalled();
    expect(secondOrigin.getItem).not.toHaveBeenCalled();
  });

  it('retains removals and ordered saves on the next host', async () => {
    const { store, origin } = fixture();
    const preferences = createRendererPreferences(() => store, origin);
    await preferences.initialize();
    preferences.setItem('justdo-theme-id', 'midnight');
    preferences.setItem('justdo-theme-id', 'classic-light');
    preferences.setItem('justdo:goal-completion-feedback:session-1', '{}');
    preferences.removeItem('justdo:goal-completion-feedback:session-1');
    await preferences.flush();
    const restarted = createRendererPreferences(() => store, origin);
    await restarted.initialize();
    expect(restarted.getItem('justdo-theme-id')).toBe('classic-light');
    expect(restarted.getItem('justdo:goal-completion-feedback:session-1')).toBeNull();
  });

  it('does not replicate transcripts, failure excerpts or credentials to Main', async () => {
    const { records, store, origin } = fixture();
    records.set('app.renderer-preferences.v1', {
      'justdo-theme-id': 'midnight',
      'justdo-openclaw-interrupted-messages': 'private transcript',
      providers_export_key: 'private key',
    });
    const preferences = createRendererPreferences(() => store, origin);
    await preferences.initialize();
    preferences.setItem('justdo-openclaw-failed-runs', 'private excerpt');
    preferences.setItem('providers_export_key', 'private key');
    preferences.setItem('justdo-pet-floating-position', '{}');
    await preferences.flush();
    expect(records.get('app.renderer-preferences.v1')).toEqual({
      'justdo-theme-id': 'midnight',
      'justdo-pet-floating-position': '{}',
    });
    expect(preferences.getItem('justdo-openclaw-interrupted-messages')).toBeNull();
  });

  it('bounds draft storage while retaining fixed appearance preferences', async () => {
    const { store, origin } = fixture();
    const preferences = createRendererPreferences(() => store, origin);
    await preferences.initialize();
    preferences.setItem('justdo-theme-id', 'midnight');
    for (let index = 0; index < 130; index++)
      preferences.setItem(`justdo:goal-completion-feedback:${index}`, '{}');
    preferences.setItem('justdo:goal-completion-feedback:oversized', '界'.repeat(22_000));
    await preferences.flush();
    const restarted = createRendererPreferences(() => store, origin);
    await restarted.initialize();
    expect(restarted.getItem('justdo-theme-id')).toBe('midnight');
    expect(restarted.getItem('justdo:goal-completion-feedback:0')).toBeNull();
    expect(restarted.getItem('justdo:goal-completion-feedback:129')).toBe('{}');
    expect(restarted.getItem('justdo:goal-completion-feedback:oversized')).toBeNull();
  });

  it('keeps current preferences usable and allows a later save after persistence fails', async () => {
    const { store, origin } = fixture();
    store.get.mockRejectedValueOnce(new Error('Unavailable'));
    store.set.mockRejectedValueOnce(new Error('Unavailable'));
    const preferences = createRendererPreferences(() => store, origin);
    await preferences.initialize();
    preferences.setItem('justdo-theme-id', 'midnight');
    await preferences.flush();
    expect(preferences.getItem('justdo-theme-id')).toBe('midnight');
    preferences.setItem('justdo-theme-id', 'classic-light');
    await preferences.flush();
    expect(store.set).toHaveBeenLastCalledWith('app.renderer-preferences.v1', {
      'justdo-theme-id': 'classic-light',
    });
  });

  it.each([
    {
      label: 'theme selection',
      key: 'justdo-theme-id',
      latest: 'classic-light',
      middle: 'midnight',
    },
    {
      label: 'goal draft removal',
      key: 'justdo:goal-completion-feedback:session-1',
      latest: null,
      middle: '{"edited":true}',
    },
  ])(
    'replays the latest $label after returning to an earlier value and the last save fails',
    async ({ key, latest, middle }) => {
      const { records, store, origin } = fixture();
      records.set('app.renderer-preferences.v1', { [key]: middle });
      const save = store.set.getMockImplementation()!;
      store.set
        .mockImplementationOnce(save)
        .mockImplementationOnce(save)
        .mockRejectedValueOnce(new Error('Last save unavailable'));
      const preferences = createRendererPreferences(() => store, origin);
      await preferences.initialize();
      const edit = (value: string | null) => {
        if (value === null) preferences.removeItem(key);
        else preferences.setItem(key, value);
      };

      edit(latest);
      edit(middle);
      edit(latest);
      await preferences.flush();
      expect(store.set).toHaveBeenCalledTimes(3);
      expect(preferences.getItem(key)).toBe(latest);

      // Another preference save must also retry the uncommitted latest edit.
      preferences.setItem('justdo-pet-floating-position', '{"x":120,"y":80}');
      await preferences.flush();
      const restarted = createRendererPreferences(() => store, origin);
      await restarted.initialize();
      expect(restarted.getItem(key)).toBe(latest);
      expect(restarted.getItem('justdo-pet-floating-position')).toBe('{"x":120,"y":80}');
    },
  );

  it('retains the most recently edited goal draft when bounded pending saves are replayed', async () => {
    const { store, origin } = fixture();
    const preferences = createRendererPreferences(() => store, origin);
    await preferences.initialize();
    preferences.setItem('justdo-theme-id', 'midnight');
    for (let index = 0; index < 130; index++)
      preferences.setItem(`justdo:goal-completion-feedback:${index}`, '{}');
    preferences.setItem('justdo:goal-completion-feedback:0', '{"recent":true}');
    await preferences.flush();
    const restarted = createRendererPreferences(() => store, origin);
    await restarted.initialize();
    expect(restarted.getItem('justdo:goal-completion-feedback:0')).toBe('{"recent":true}');
    expect(restarted.getItem('justdo:goal-completion-feedback:129')).toBe('{}');
    expect(restarted.getItem('justdo:goal-completion-feedback:1')).toBeNull();
  });

  it('recovers an unknown Main baseline before saving, preserving unrelated preferences', async () => {
    const { records, store, origin } = fixture();
    records.set('app.renderer-preferences.v1', {
      'justdo-theme-id': 'midnight',
      'justdo-scheduled-task-result-preferences-v1': '{"includeRoutine":true}',
      'justdo:goal-completion-feedback:session-1': '{"completedGoalId":"goal-1"}',
    });
    store.get.mockRejectedValueOnce(new Error('Initial read unavailable'));
    const preferences = createRendererPreferences(() => store, origin);
    await preferences.initialize();
    preferences.setItem('justdo-theme-id', 'classic-light');
    await preferences.flush();
    expect(records.get('app.renderer-preferences.v1')).toEqual({
      'justdo-theme-id': 'classic-light',
      'justdo-scheduled-task-result-preferences-v1': '{"includeRoutine":true}',
      'justdo:goal-completion-feedback:session-1': '{"completedGoalId":"goal-1"}',
    });
    expect(preferences.getItem('justdo:goal-completion-feedback:session-1')).toContain('goal-1');
  });

  it('does not overwrite an unreadable baseline and merges pending changes after recovery', async () => {
    const { records, store, origin } = fixture();
    records.set('app.renderer-preferences.v1', {
      'justdo-pet-floating-position': '{"x":80,"y":40}',
      'justdo:goal-completion-feedback:session-1': '{}',
    });
    store.get
      .mockRejectedValueOnce(new Error('Unavailable'))
      .mockRejectedValueOnce(new Error('Unavailable'));
    const preferences = createRendererPreferences(() => store, origin);
    await preferences.initialize();
    preferences.setItem('justdo-theme-id', 'midnight');
    await preferences.flush();
    expect(store.set).not.toHaveBeenCalled();
    preferences.removeItem('justdo:goal-completion-feedback:session-1');
    await preferences.flush();
    expect(records.get('app.renderer-preferences.v1')).toEqual({
      'justdo-pet-floating-position': '{"x":80,"y":40}',
      'justdo-theme-id': 'midnight',
    });
  });

  it('imports only approved current-origin UI settings when Main has no preference record', async () => {
    const { records, store } = fixture();
    const legacy = new Map([
      ['justdo-theme-id', 'midnight'],
      ['justdo:goal-completion-feedback:session-1', '{}'],
      ['justdo-openclaw-interrupted-messages', 'private transcript'],
      ['providers_export_key', 'private credential'],
    ]);
    const browser = {
      length: legacy.size,
      key: (index: number) => [...legacy.keys()][index] ?? null,
      getItem: (key: string) => legacy.get(key) ?? null,
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    const preferences = createRendererPreferences(
      () => store,
      () => browser,
    );
    await preferences.initialize();
    await preferences.flush();
    expect(preferences.getItem('justdo-theme-id')).toBe('midnight');
    expect(records.get('app.renderer-preferences.v1')).toEqual({
      'justdo-theme-id': 'midnight',
      'justdo:goal-completion-feedback:session-1': '{}',
    });
  });

  it('keeps standalone browser preference behavior without a privileged bridge', async () => {
    const browser = { getItem: vi.fn(() => 'midnight'), setItem: vi.fn(), removeItem: vi.fn() };
    const preferences = createRendererPreferences(
      () => undefined,
      () => browser,
    );
    await preferences.initialize();
    expect(preferences.getItem('justdo-theme-id')).toBe('midnight');
    preferences.setItem('justdo-theme-id', 'classic-light');
    preferences.removeItem('justdo-theme-id');
    expect(browser.setItem).toHaveBeenCalledWith('justdo-theme-id', 'classic-light');
    expect(browser.removeItem).toHaveBeenCalledWith('justdo-theme-id');
  });

  it('hydrates actual result-filter slice initialization before the app imports it', async () => {
    const { records, store } = fixture();
    records.set('app.renderer-preferences.v1', {
      'justdo-scheduled-task-result-preferences-v1': '{"includeRoutine":true,"includeSystem":true}',
    });
    vi.stubGlobal('window', { electron: { store } });
    const { rendererPreferences } = await import('./rendererPreferences');
    await rendererPreferences.initialize();
    const { default: reducer } = await import('@/features/scheduled-tasks/scheduledTaskSlice');
    expect(reducer(undefined, { type: 'initial' }).resultFilter).toMatchObject({
      includeRoutine: true,
      includeSystem: true,
    });
  });
});
