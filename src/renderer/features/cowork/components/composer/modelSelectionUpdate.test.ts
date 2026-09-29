import { describe, expect, test, vi } from 'vitest';

import { LatestSerialTaskQueue } from '@/features/cowork/components/composer/latestSerialTaskQueue';
import {
  applyModelSelectionUpdate,
  DefaultModelApplyError,
  resolvePersistedSessionModelRefAfterApplyError,
  SessionModelApplyError,
} from '@/features/cowork/components/composer/modelSelectionUpdate';
import type { Model } from '@/features/models/modelSlice';

const model: Model = {
  id: 'gpt-5',
  name: 'GPT-5',
  providerKey: 'openai',
};

describe('resolvePersistedSessionModelRefAfterApplyError', () => {
  test('keeps a session model when only the default update failed', () => {
    const error = new DefaultModelApplyError('sync failed', 'openai/gpt-5');

    expect(resolvePersistedSessionModelRefAfterApplyError(error, model)).toBe('openai/gpt-5');
  });

  test('keeps an ambiguous session result when it matches the requested model', () => {
    const error = new SessionModelApplyError('gateway unavailable', 'openai/gpt-5');

    expect(resolvePersistedSessionModelRefAfterApplyError(error, model)).toBe('openai/gpt-5');
  });

  test('ignores a case variant that the main process does not persist', () => {
    const error = new SessionModelApplyError('gateway unavailable', 'OPENAI/gpt-5');

    expect(resolvePersistedSessionModelRefAfterApplyError(error, model)).toBeUndefined();
  });

  test('ignores a runtime fallback that differs from the requested model', () => {
    const error = new SessionModelApplyError('gateway unavailable', 'openai/gpt-4o');

    expect(resolvePersistedSessionModelRefAfterApplyError(error, model)).toBeUndefined();
  });
});

describe('applyModelSelectionUpdate', () => {
  test('finishes an existing-session switch before a slow default save and lets the next switch proceed', async () => {
    const queue = new LatestSerialTaskQueue();
    let releaseDefault!: (result: { success: boolean }) => void;
    const pendingDefault = new Promise<{ success: boolean }>(resolve => { releaseDefault = resolve; });
    const onDefaultModelUpdated = vi.fn();
    const onBackgroundDefaultError = vi.fn();
    const onBackgroundDefaultStart = vi.fn();
    const patchSessionModel = vi.fn(async ({ model: reference }: { model: string }) => ({
      success: true, modelRef: reference,
    }));
    const setDefaultModel = vi.fn(() => {
      expect(onBackgroundDefaultStart).toHaveBeenCalledTimes(patchSessionModel.mock.calls.length);
      return pendingDefault;
    });
    const select = (selected: Model) => queue.enqueue(() => applyModelSelectionUpdate({
      sessionId: 'session-1', agentId: 'main', model: selected,
      onDefaultModelUpdated, onBackgroundDefaultError, onBackgroundDefaultStart,
    }, { patchSessionModel, setDefaultModel })).completion;

    await expect(select(model)).resolves.toEqual({ sessionModelRef: 'openai/gpt-5' });
    await expect(select({ ...model, id: 'gpt-6' })).resolves.toEqual({ sessionModelRef: 'openai/gpt-6' });
    expect(patchSessionModel).toHaveBeenCalledTimes(2);
    expect(onDefaultModelUpdated).not.toHaveBeenCalled();
    releaseDefault({ success: true });
    await vi.waitFor(() => expect(onDefaultModelUpdated).toHaveBeenCalledTimes(2));
    expect(onBackgroundDefaultError).not.toHaveBeenCalled();
  });

  test('reports a late default-save failure separately from the confirmed session switch', async () => {
    let rejectDefault!: (error: Error) => void;
    const pendingDefault = new Promise<{ success: boolean }>((_resolve, reject) => { rejectDefault = reject; });
    const onBackgroundDefaultError = vi.fn();
    const onDefaultModelUpdated = vi.fn();
    const patchSessionModel = vi.fn(async () => ({ success: true, modelRef: 'openai/gpt-5' }));
    await expect(applyModelSelectionUpdate({
      sessionId: 'session-1', agentId: 'main', model,
      onDefaultModelUpdated, onBackgroundDefaultError,
    }, { patchSessionModel, setDefaultModel: () => pendingDefault }))
      .resolves.toEqual({ sessionModelRef: 'openai/gpt-5' });

    rejectDefault(new Error('save failed'));
    await vi.waitFor(() => expect(onBackgroundDefaultError).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'DefaultModelApplyError', sessionModelRef: 'openai/gpt-5' }),
    ));
    expect(onDefaultModelUpdated).not.toHaveBeenCalled();
    expect(patchSessionModel).toHaveBeenCalledTimes(1);
  });

  test('keeps a new-chat selection pending until its default has actually been applied', async () => {
    let releaseDefault!: (result: { success: boolean }) => void;
    const pendingDefault = new Promise<{ success: boolean }>(resolve => { releaseDefault = resolve; });
    const completed = vi.fn();
    const onBackgroundDefaultError = vi.fn();
    const selecting = applyModelSelectionUpdate({
      agentId: 'main', model, onDefaultModelUpdated: vi.fn(), onBackgroundDefaultError,
    }, { patchSessionModel: vi.fn(), setDefaultModel: () => pendingDefault }).then(completed);
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    releaseDefault({ success: true });
    await selecting;
    expect(completed).toHaveBeenCalledOnce();
    expect(onBackgroundDefaultError).not.toHaveBeenCalled();
  });

  test('does not update defaults without a confirmed session model', async () => {
    const setDefaultModel = vi.fn();
    const onDefaultModelUpdated = vi.fn();
    await expect(
      applyModelSelectionUpdate(
        { sessionId: 'session-1', agentId: 'main', model, onDefaultModelUpdated },
        { patchSessionModel: vi.fn(async () => ({ success: true })), setDefaultModel },
      ),
    ).rejects.toThrow('patchSessionModel returned no confirmed model');
    expect(setDefaultModel).not.toHaveBeenCalled();
    expect(onDefaultModelUpdated).not.toHaveBeenCalled();
  });

  test('locks the existing-session model before updating the default', async () => {
    const calls: string[] = [];
    const setDefaultModel = vi.fn(async () => {
      calls.push('default');
      return { success: true };
    });
    const onDefaultModelUpdated = vi.fn(() => calls.push('redux'));
    const patchSessionModel = vi.fn(async () => {
      calls.push('session');
      return { success: true, modelRef: 'openai/gpt-5' };
    });

    const result = await applyModelSelectionUpdate(
      { sessionId: 'session-1', agentId: 'main', model, onDefaultModelUpdated },
      { setDefaultModel, patchSessionModel },
    );

    expect(calls).toEqual(['session', 'default', 'redux']);
    expect(setDefaultModel).toHaveBeenCalledWith({
      modelId: 'gpt-5',
      providerKey: 'openai',
      modelRef: 'openai/gpt-5',
      agentId: 'main',
    });
    expect(patchSessionModel).toHaveBeenCalledWith({
      sessionId: 'session-1',
      model: 'openai/gpt-5',
      agentId: 'main',
    });
    expect(result).toEqual({ sessionModelRef: 'openai/gpt-5' });
  });

  test('updates the default directly for a new session', async () => {
    const onDefaultModelUpdated = vi.fn();
    const setDefaultModel = vi.fn(async () => ({ success: true }));
    const patchSessionModel = vi.fn();

    await expect(
      applyModelSelectionUpdate(
        { agentId: 'main', model, onDefaultModelUpdated },
        { setDefaultModel, patchSessionModel },
      ),
    ).resolves.toEqual({});

    expect(patchSessionModel).not.toHaveBeenCalled();
    expect(setDefaultModel).toHaveBeenCalledOnce();
    expect(onDefaultModelUpdated).toHaveBeenCalledOnce();
  });

  test('does not update the default when the current-session patch fails', async () => {
    const onDefaultModelUpdated = vi.fn();
    const setDefaultModel = vi.fn(async () => ({ success: true }));
    const patchSessionModel = vi.fn(async () => ({
      success: false,
      error: 'gateway unavailable',
      modelRef: 'openai/gpt-4o',
    }));

    const update = applyModelSelectionUpdate(
      { sessionId: 'session-1', agentId: 'main', model, onDefaultModelUpdated },
      {
        setDefaultModel,
        patchSessionModel,
      },
    );

    await expect(update).rejects.toBeInstanceOf(SessionModelApplyError);
    await expect(update).rejects.toMatchObject({
      name: 'SessionModelApplyError',
      message: 'gateway unavailable',
      currentModelRef: 'openai/gpt-4o',
    });
    expect(setDefaultModel).not.toHaveBeenCalled();
    expect(onDefaultModelUpdated).not.toHaveBeenCalled();
  });

  test('reports a rejected session IPC call without changing the default', async () => {
    const onDefaultModelUpdated = vi.fn();
    const setDefaultModel = vi.fn(async () => ({ success: true }));
    const update = applyModelSelectionUpdate(
      { sessionId: 'session-1', agentId: 'main', model, onDefaultModelUpdated },
      {
        setDefaultModel,
        patchSessionModel: vi.fn(async () => {
          throw new Error('IPC disconnected');
        }),
      },
    );

    await expect(update).rejects.toMatchObject({
      name: 'SessionModelApplyError',
      message: 'IPC disconnected',
    });
    expect(setDefaultModel).not.toHaveBeenCalled();
    expect(onDefaultModelUpdated).not.toHaveBeenCalled();
  });

  test('reports partial success when the session patch succeeds but the default update fails', async () => {
    const onDefaultModelUpdated = vi.fn();
    const patchSessionModel = vi.fn(async () => ({
      success: true,
      modelRef: 'openai/gpt-5',
    }));

    const update = applyModelSelectionUpdate(
      { sessionId: 'session-1', agentId: 'main', model, onDefaultModelUpdated },
      {
        setDefaultModel: vi.fn(async () => ({ success: false, error: 'sync failed' })),
        patchSessionModel,
      },
    );

    await expect(update).rejects.toBeInstanceOf(DefaultModelApplyError);
    await expect(update).rejects.toMatchObject({
      name: 'DefaultModelApplyError',
      message: 'sync failed',
      sessionModelRef: 'openai/gpt-5',
    });
    expect(onDefaultModelUpdated).not.toHaveBeenCalled();
    expect(patchSessionModel).toHaveBeenCalledOnce();
  });

  test('preserves the switched session when the default IPC rejects', async () => {
    const update = applyModelSelectionUpdate(
      { sessionId: 'session-1', agentId: 'main', model, onDefaultModelUpdated: vi.fn() },
      {
        setDefaultModel: vi.fn(async () => {
          throw new Error('IPC disconnected');
        }),
        patchSessionModel: vi.fn(async () => ({
          success: true,
          modelRef: 'openai/gpt-5',
        })),
      },
    );

    await expect(update).rejects.toMatchObject({
      name: 'DefaultModelApplyError',
      message: 'IPC disconnected',
      sessionModelRef: 'openai/gpt-5',
    });
  });

  test('leaves the current session pinned when another session changes the default', async () => {
    let defaultModelRef = 'openai/gpt-4o';
    const sessionOverrides = new Map<string, string>();
    const services = {
      patchSessionModel: vi.fn(
        async ({ sessionId, model: modelRef }: { sessionId: string; model: string }) => {
          sessionOverrides.set(sessionId, modelRef);
          return { success: true, modelRef };
        },
      ),
      setDefaultModel: vi.fn(async ({ modelRef }: { modelRef?: string }) => {
        if (modelRef) defaultModelRef = modelRef;
        return { success: true };
      }),
    };

    await applyModelSelectionUpdate(
      { sessionId: 'session-a', agentId: 'main', model, onDefaultModelUpdated: vi.fn() },
      services,
    );
    await applyModelSelectionUpdate(
      {
        sessionId: 'session-b',
        agentId: 'main',
        model: { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', providerKey: 'anthropic' },
        onDefaultModelUpdated: vi.fn(),
      },
      services,
    );

    expect(defaultModelRef).toBe('anthropic/claude-sonnet-4');
    expect(sessionOverrides.get('session-a')).toBe('openai/gpt-5');
    expect(sessionOverrides.get('session-b')).toBe('anthropic/claude-sonnet-4');
  });

  test('keeps the preceding successful model as rollback state when the latest switch fails', async () => {
    const queue = new LatestSerialTaskQueue();
    let confirmedModelRef = 'openai/gpt-4o';
    let displayedModelRef = 'anthropic/claude-sonnet-4';

    const first = queue.enqueue(async () => 'openai/gpt-5');
    const second = queue.enqueue(async () => {
      throw new Error('latest switch failed');
    });

    await first.completion.then(modelRef => {
      confirmedModelRef = modelRef;
      if (queue.isLatest(first.taskId)) displayedModelRef = modelRef;
    });
    await second.completion.catch(() => {
      if (queue.isLatest(second.taskId)) displayedModelRef = confirmedModelRef;
    });

    expect(confirmedModelRef).toBe('openai/gpt-5');
    expect(displayedModelRef).toBe('openai/gpt-5');
  });

  test('uses the server-model Gateway reference for an existing session', async () => {
    const setDefaultModel = vi.fn(async () => ({ success: true }));
    const patchSessionModel = vi.fn(async () => ({
      success: true,
      modelRef: 'justdo/server-model',
    }));

    await applyModelSelectionUpdate(
      {
        sessionId: 'session-1',
        agentId: 'main',
        model: { id: 'server-model', name: 'Server model', isServerModel: true },
        onDefaultModelUpdated: vi.fn(),
      },
      {
        setDefaultModel,
        patchSessionModel,
      },
    );

    expect(setDefaultModel).toHaveBeenCalledWith({
      modelId: 'server-model',
      providerKey: undefined,
      modelRef: 'justdo/server-model',
      agentId: 'main',
    });
    expect(patchSessionModel).toHaveBeenCalledWith({
      sessionId: 'session-1',
      model: 'justdo/server-model',
      agentId: 'main',
    });
  });

  test('uses the custom provider display name as the canonical model reference', async () => {
    const setDefaultModel = vi.fn(async () => ({ success: true }));
    const patchSessionModel = vi.fn(async () => ({
      success: true,
      modelRef: 'acme/custom-model',
    }));

    await applyModelSelectionUpdate(
      {
        sessionId: 'session-1',
        agentId: 'main',
        model: {
          id: 'custom-model',
          name: 'Custom model',
          providerKey: 'custom_0',
          provider: 'Acme',
        },
        onDefaultModelUpdated: vi.fn(),
      },
      { setDefaultModel, patchSessionModel },
    );

    expect(setDefaultModel).toHaveBeenCalledWith(
      expect.objectContaining({ modelRef: 'acme/custom-model' }),
    );
    expect(patchSessionModel).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'acme/custom-model' }),
    );
  });
});
