// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { flushSync } from 'react-dom';
import { Provider, useSelector } from 'react-redux';
import { afterEach, expect, test, vi } from 'vitest';

import { setAvailableModels, setSelectedModel } from '@/features/models/modelSlice';
import { configService } from '@/services/config';
import { i18nService } from '@/services/i18n';
import { store } from '@/store';

import CoworkPromptInput from './CoworkPromptInput';

const originalModels = store.getState().model.availableModels;
const originalSelectedModel = store.getState().model.selectedModel;

afterEach(() => {
  cleanup();
  store.dispatch(setAvailableModels(originalModels));
  store.dispatch(setSelectedModel(originalSelectedModel));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('keeps model clicks immediate and skips intermediate choices while native confirmation is pending', async () => {
  const models = ['Current', 'First', 'Intermediate', 'Latest'].map(name => ({
    id: name.toLowerCase(),
    name,
    provider: 'Acme',
    providerKey: 'custom_0',
  }));
  store.dispatch(setAvailableModels(models));
  store.dispatch(setSelectedModel(models[0]));
  vi.spyOn(configService, 'acceptDefaultModelSelection').mockImplementation(() => undefined);
  const sessionId = 'responsive-model-selection';
  const contextKey = `${sessionId}\0main`;
  let finishFirst!: (result: { success: true; modelRef: string }) => void;
  let finishDefaults!: (result: { success: true }) => void;
  const firstPatch = new Promise<{ success: true; modelRef: string }>(resolve => {
    finishFirst = resolve;
  });
  const defaults = new Promise<{ success: true }>(resolve => {
    finishDefaults = resolve;
  });
  const patchSessionModel = vi
    .fn(async ({ model }: { model: string }) => ({
      success: true,
      modelRef: model,
    }))
    .mockImplementationOnce(() => firstPatch);
  const setDefaultModel = vi.fn(() => defaults);
  // Even a pending catalog read must never hold the configured menu open or block selection.
  const listModels = vi.fn(() => new Promise(() => {}));
  const getSessionModel = vi.fn(async () => ({
    success: true,
    source: 'gateway',
    modelRef: 'acme/current',
  }));
  vi.stubGlobal('electron', {
    extensions: {
      list: vi.fn().mockResolvedValue({ success: true, extensions: [] }),
      onChanged: vi.fn().mockReturnValue(() => undefined),
    },
    cowork: {
      patchSessionModel,
      setDefaultModel,
      getSessionModel,
      getSessionGoal: vi.fn().mockResolvedValue({ success: true, goal: null }),
      getGoalExecution: vi.fn().mockResolvedValue({ success: true }),
      onSessionGoalChanged: vi.fn().mockReturnValue(() => undefined),
      onGoalExecutionChanged: vi.fn().mockReturnValue(() => undefined),
    },
    openclaw: { models: { list: listModels } },
    localAsr: { getStatus: vi.fn().mockResolvedValue({ available: false }) },
    localSpeechModels: { onChanged: vi.fn().mockReturnValue(() => undefined) },
  });
  const onSubmit = vi.fn();
  const Composer = () => {
    const modelRef = useSelector(
      (state: ReturnType<typeof store.getState>) =>
        state.cowork.userConfirmedSessionModelRefs[sessionId],
    );
    return (
      <CoworkPromptInput
        size="large"
        sessionId={sessionId}
        sessionModelRef={modelRef ?? 'acme/current'}
        modelAgentId="main"
        showModelSelector
        onSubmit={onSubmit}
      />
    );
  };
  render(
    <Provider store={store}>
      <Composer />
    </Provider>,
  );
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: 'Keep this draft' } });
  const send = screen.getByRole('button', {
    name: i18nService.t('coworkSendMessage'),
  }) as HTMLButtonElement;
  await waitFor(() => expect(send.disabled).toBe(false));
  const select = (current: string, next: string) => {
    fireEvent.click(screen.getByRole('button', { name: current }));
    fireEvent.click(screen.getByText(next));
    const selector = screen.getByRole('button', { name: next }) as HTMLButtonElement;
    expect(selector.disabled).toBe(false);
    expect(selector.getAttribute('aria-busy')).toBe('false');
    expect(selector.getAttribute('aria-expanded')).toBe('false');
  };

  select('Current', 'First');
  await waitFor(() => expect(patchSessionModel).toHaveBeenCalledTimes(1));
  select('First', 'Intermediate');
  select('Intermediate', 'Latest');
  expect(send.disabled).toBe(true);
  expect(input.value).toBe('Keep this draft');
  expect(listModels).toHaveBeenCalledTimes(1);
  expect(getSessionModel).toHaveBeenCalledTimes(1);
  expect(patchSessionModel).toHaveBeenCalledTimes(1);

  await act(async () => {
    finishFirst({ success: true, modelRef: 'acme/first' });
  });

  await waitFor(() => expect(send.disabled).toBe(false));
  expect(patchSessionModel.mock.calls.map(([options]) => options.model)).toEqual([
    'acme/first',
    'acme/latest',
  ]);
  expect(store.getState().cowork.pendingModelSelectionTaskIds[contextKey]).toBeUndefined();
  expect(store.getState().cowork.userConfirmedSessionModelRefs[sessionId]).toBe('acme/latest');
  expect(screen.getByRole('button', { name: 'Latest' })).toBeTruthy();
  expect(setDefaultModel).toHaveBeenCalledTimes(2);
  expect(input.value).toBe('Keep this draft');
  expect(onSubmit).not.toHaveBeenCalled();

  await act(async () => {
    finishDefaults({ success: true });
  });
  await waitFor(() =>
    expect(store.getState().cowork.pendingModelSelectionTaskIds['__home__\0main']).toBeUndefined(),
  );
});

test.each(['normal', 'large'] as const)(
  '%s composer keeps one feature menu and resets its open state when switching chats',
  async size => {
    const config = configService.getConfig();
    vi.spyOn(configService, 'getConfig').mockReturnValue({
      ...config,
      voice: { ...config.voice, inputEnabled: true, recognitionMode: 'local' },
    });
    vi.stubGlobal('electron', {
      extensions: {
        list: vi.fn().mockResolvedValue({ success: true, extensions: [] }),
        onChanged: vi.fn().mockReturnValue(() => undefined),
      },
      localAsr: { getStatus: vi.fn().mockResolvedValue({ available: true }) },
      localSpeechModels: { onChanged: vi.fn().mockReturnValue(() => undefined) },
    });
    const onSubmit = vi.fn();
    const composer = (sessionId?: string) => (
      <Provider store={store}>
        <CoworkPromptInput size={size} sessionId={sessionId} onSubmit={onSubmit} />
      </Provider>
    );
    const view = render(composer());
    const featureLabel = i18nService.t('composerFeatures');
    const microphoneLabel = i18nService.t('localAsrStart');
    await screen.findByRole('button', { name: microphoneLabel });

    for (const sessionId of ['temp-first', 'temp-second', undefined, 'temp-first']) {
      fireEvent.click(screen.getByRole('button', { name: featureLabel }));
      expect(screen.getByRole('menu', { name: featureLabel })).toBeTruthy();

      view.rerender(composer(sessionId));

      expect(screen.getAllByRole('button', { name: featureLabel })).toHaveLength(1);
      expect(screen.queryByRole('menu', { name: featureLabel })).toBeNull();
      await screen.findByRole('button', { name: microphoneLabel });
      expect(screen.getAllByRole('button', { name: microphoneLabel })).toHaveLength(1);
    }
  },
);

test.each(['current', 'draft', 'selection'] as const)(
  'rechecks the %s Workflow draft after preparation resolves and before sending',
  async context => {
    const config = configService.getConfig();
    vi.spyOn(configService, 'getConfig').mockReturnValue({
      ...config,
      voice: { ...config.voice, inputEnabled: false },
    });
    store.dispatch(setAvailableModels([{ id: 'test-model', name: 'Test model' }]));
    let resolvePreparation!: (value: { success: true; instruction: string }) => void;
    const preparation = new Promise<{ success: true; instruction: string }>(resolve => {
      resolvePreparation = resolve;
    });
    const prepare = vi.fn(() => preparation);
    vi.stubGlobal('electron', {
      extensions: {
        list: vi.fn().mockResolvedValue({
          success: true,
          extensions: [{ id: 'swarm-workflow', enabled: true }],
        }),
        onChanged: vi.fn().mockReturnValue(() => undefined),
      },
      cowork: { prepareSwarmWorkflow: prepare },
      localAsr: { getStatus: vi.fn().mockResolvedValue({ available: false }) },
      localSpeechModels: { onChanged: vi.fn().mockReturnValue(() => undefined) },
    });
    const onSubmit = vi.fn(() => true);
    const draftKey = `temp-workflow-${context}`;
    const composer = (sessionId = draftKey) => (
      <Provider store={store}>
        <CoworkPromptInput sessionId={sessionId} onSubmit={onSubmit} />
      </Provider>
    );
    const view = render(composer());
    fireEvent.click(screen.getByRole('button', { name: i18nService.t('composerFeatures') }));
    fireEvent.click(
      await screen.findByRole('menuitem', { name: i18nService.t('swarmWorkflowTitle') }),
    );
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Review this project' } });
    fireEvent.click(screen.getByRole('button', { name: i18nService.t('coworkSendMessage') }));
    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    expect(prepare).toHaveBeenCalledWith({ mode: 'auto', verify: true }, draftKey);

    await act(async () => {
      resolvePreparation({ success: true, instruction: '<swarm-workflow/>' });
      // Retire after the plugin validates the result, before its awaiting caller resumes.
      queueMicrotask(() => {
        if (context === 'draft') flushSync(() => view.rerender(composer(`${draftKey}-next`)));
        if (context === 'selection') {
          flushSync(() => {
            fireEvent.click(
              screen.getByRole('button', { name: i18nService.t('swarmWorkflowRemoveToken') }),
            );
          });
        }
      });
    });

    if (context === 'current') {
      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(onSubmit).toHaveBeenCalledWith(
        'Review this project',
        undefined,
        'Review this project\n\n<swarm-workflow/>',
        false,
        { mode: 'auto', verify: true },
      );
    } else {
      expect(onSubmit).not.toHaveBeenCalled();
      if (context === 'draft') view.rerender(composer());
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(
        'Review this project',
      );
    }
  },
);
