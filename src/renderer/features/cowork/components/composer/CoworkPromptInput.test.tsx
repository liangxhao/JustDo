// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { flushSync } from 'react-dom';
import { Provider, useSelector } from 'react-redux';
import { afterEach, expect, test, vi } from 'vitest';

import { setAvailableModels, setSelectedModel } from '@/features/models/modelSlice';
import type { AppMode } from '@/features/plugins/app/browserRegistry';
import { configService } from '@/services/config';
import { i18nService } from '@/services/i18n';
import { store } from '@/store';

import { readAppInput } from '../../../../../../plugins/extensions/runtime-services/contracts/app-input';
import CoworkPromptInput from './CoworkPromptInput';
import * as composerModelSelection from './selection/selectComposerModel';
const desktop = vi.hoisted(() => ({
  modes: [] as AppMode[],
  views: [],
  listeners: new Set<() => void>(),
}));
vi.mock('@/features/plugins/app/runtime', () => ({
  appBrowserRegistry: {
    subscribe: (listener: () => void) => {
      desktop.listeners.add(listener);
      return () => {
        desktop.listeners.delete(listener);
      };
    },
    getModes: () => desktop.modes,
    getViews: () => desktop.views,
  },
}));

vi.mock('@/app/shell/startup/routing/useEngineReadiness', () => ({
  getEngineReadinessSnapshot: () => ({ ready: true, pending: false, failed: false }),
  subscribeEngineReadiness: () => () => {},
}));

const originalModels = store.getState().model.availableModels;
const originalSelectedModel = store.getState().model.selectedModel;

afterEach(() => {
  cleanup();
  desktop.modes = [];
  store.dispatch(setAvailableModels(originalModels));
  store.dispatch(setSelectedModel(originalSelectedModel));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test.each(['normal', 'large'] as const)(
  'restores declared mode tokens and composer focus for size %s',
  async size => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      callback(0);
      return 1;
    });
    store.dispatch(setAvailableModels([{ id: 'visual-mode-model', name: 'Model' }]));
    desktop.modes = [
      {
        id: 'group',
        pluginId: 'grouped-plugin',
        epoch: 'visual',
        labelKey: 'Group',
        group: { id: 'team', labelKey: 'Team', order: 20, backLabelKey: 'Back to features' },
        removeLabelKey: 'Remove grouped mode',
        icon: <span data-testid="mode-icon">G</span>,
        prepare: async ({ prompt }) => ({ prompt }),
      },
      {
        id: 'workflow',
        pluginId: 'workflow-plugin',
        epoch: 'visual',
        labelKey: 'Workflow',
        order: 10,
        removeLabelKey: 'Remove workflow mode',
        selectionCaret: 'start',
        prepare: async ({ prompt }) => ({ prompt }),
      },
    ];
    vi.stubGlobal('electron', {
      extensions: {
        list: vi.fn().mockResolvedValue({ success: true, extensions: [] }),
        onChanged: () => () => {},
      },
      localAsr: { getStatus: vi.fn().mockResolvedValue({ available: false }) },
      localSpeechModels: { onChanged: () => () => {} },
    });
    const onSubmit = vi.fn();
    render(
      <Provider store={store}>
        <CoworkPromptInput size={size} onSubmit={onSubmit} />
      </Provider>,
    );
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'Keep this text' } });
    input.setSelectionRange(7, 7);
    const open = () =>
      fireEvent.click(screen.getByRole('button', { name: i18nService.t('composerFeatures') }));
    open();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Workflow' }));
    expect(screen.getByRole('button', { name: 'Remove workflow mode' })).toBeTruthy();
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    input.setSelectionRange(4, 4);
    open();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Team' }));
    expect(screen.getByRole('button', { name: 'Back to features' })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Group' }));
    const token = screen.getByRole('button', { name: 'Remove grouped mode' });
    expect(token.textContent).toContain('Team · Group');
    expect(token.querySelector('[data-testid="mode-icon"]')).not.toBeNull();
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(4);
    input.setSelectionRange(0, 0);
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(screen.queryByRole('button', { name: 'Remove grouped mode' })).toBeNull();
    expect(input.value).toBe('Keep this text');
    expect(onSubmit).not.toHaveBeenCalled();
  },
);

test('retains a selected plugin draft when its mode retires during model preparation', async () => {
  const model = { id: 'current', name: 'Current', provider: 'Acme', providerKey: 'custom_0' };
  store.dispatch(setAvailableModels([model]));
  store.dispatch(setSelectedModel(model));
  let finishModel!: (ready: boolean) => void;
  const pendingModel = new Promise<boolean>(resolve => {
    finishModel = resolve;
  });
  const waitForModel = vi
    .spyOn(composerModelSelection, 'waitForComposerModelSelection')
    .mockReturnValue(pendingModel);
  desktop.modes = [
    {
      id: 'fixture-mode',
      pluginId: 'fixture-plugin',
      epoch: 'current',
      labelKey: 'fixtureMode',
      prepare: async ({ prompt }) => ({ prompt: prompt + ' plugin instruction' }),
    },
  ];
  vi.stubGlobal('electron', {
    extensions: {
      list: vi.fn().mockResolvedValue({ success: true, extensions: [] }),
      onChanged: () => () => {},
    },
    cowork: {
      getSessionGoal: vi.fn().mockResolvedValue({ success: true, goal: null }),
      getGoalExecution: vi.fn().mockResolvedValue({ success: true }),
      onSessionGoalChanged: () => () => {},
      onGoalExecutionChanged: () => () => {},
    },
    localAsr: { getStatus: vi.fn().mockResolvedValue({ available: false }) },
    localSpeechModels: { onChanged: () => () => {} },
  });
  const onSubmit = vi.fn();
  render(
    <Provider store={store}>
      <CoworkPromptInput
        sessionId="plugin-model-wait"
        modelAgentId="main"
        sessionModelRef="acme/current"
        onSubmit={onSubmit}
      />
    </Provider>,
  );
  fireEvent.click(screen.getByRole('button', { name: i18nService.t('composerFeatures') }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'fixtureMode' }));
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: 'Keep this plugin draft' } });
  const send = screen.getByRole('button', {
    name: i18nService.t('coworkSendMessage'),
  }) as HTMLButtonElement;
  await waitFor(() => expect(send.disabled).toBe(false));
  fireEvent.click(send);
  await waitFor(() => expect(waitForModel).toHaveBeenCalledOnce());
  act(() => {
    desktop.modes = [];
    desktop.listeners.forEach(listener => listener());
  });
  await act(async () => {
    finishModel(true);
  });
  expect(onSubmit).not.toHaveBeenCalled();
  expect(input.value).toBe('Keep this plugin draft');
});

test('the home composer keeps Apps out of the + menu', async () => {
  vi.stubGlobal('electron', {
    extensions: {
      list: vi.fn().mockResolvedValue({ success: true, extensions: [] }),
      onChanged: () => () => {},
    },
    localAsr: { getStatus: vi.fn().mockResolvedValue({ available: false }) },
    localSpeechModels: { onChanged: () => () => {} },
  });
  render(
    <Provider store={store}>
      <CoworkPromptInput size="large" onSubmit={vi.fn()} />
    </Provider>,
  );
  fireEvent.click(screen.getByRole('button', { name: i18nService.t('composerFeatures') }));
  expect(screen.queryByText(i18nService.t('mcpAppsTitle'))).toBeNull();
  expect(screen.queryByRole('menuitem', { name: 'draw.io' })).toBeNull();
});

test('keeps a startup draft editable without submitting or discovering slash commands until explicitly sent', async () => {
  const models = [{ id: 'draft-model', name: 'Draft model', providerKey: 'draft-provider' }];
  store.dispatch(setAvailableModels(models));
  store.dispatch(setSelectedModel(models[0]));
  const onSubmit = vi.fn(() => false);
  const listSlashCommands = vi.fn().mockResolvedValue({ success: true, commands: [] });
  vi.stubGlobal('electron', {
    extensions: {
      list: vi.fn().mockResolvedValue({ success: true, extensions: [] }),
      onChanged: () => () => {},
    },
    localAsr: { getStatus: vi.fn().mockResolvedValue({ available: false }) },
    localSpeechModels: { onChanged: () => () => {} },
    slashCommands: { list: listSlashCommands },
  });
  const composer = (disabled: boolean) => (
    <Provider store={store}>
      <CoworkPromptInput
        onSubmit={onSubmit}
        disabled={disabled}
        allowDraftWhileDisabled
        disabledMessage="Engine preparing"
      />
    </Provider>
  );
  const view = render(composer(true));
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  expect(input.disabled).toBe(false);
  fireEvent.change(input, { target: { value: '/help my draft' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onSubmit).not.toHaveBeenCalled();
  expect(listSlashCommands).not.toHaveBeenCalled();
  expect(
    (screen.getByRole('button', { name: i18nService.t('coworkSendMessage') }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  view.rerender(composer(false));
  await act(async () => {});
  expect(input.value).toBe('/help my draft');
  expect(onSubmit).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: 'my draft' } });
  fireEvent.click(screen.getByRole('button', { name: i18nService.t('coworkSendMessage') }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
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
  const onSubmit = vi.fn(() => false);
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
  expect(send.disabled).toBe(false);
  fireEvent.click(send);
  fireEvent.click(send);
  expect(onSubmit).not.toHaveBeenCalled();
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
  expect(setDefaultModel).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ modelId: 'latest' }),
  );
  expect(input.value).toBe('Keep this draft');
  await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());

  await act(async () => {
    finishDefaults({ success: true });
  });
  await waitFor(() =>
    expect(store.getState().cowork.pendingModelSelectionTaskIds['__home__\0main']).toBeUndefined(),
  );
});

test.each(['home', 'session'] as const)(
  'allows sending in another chat while a %s model selection is still pending',
  async pendingContext => {
    const models = ['Current', 'First', 'Intermediate', 'Latest'].map(name => ({
      id: name.toLowerCase(),
      name,
      provider: 'Acme',
      providerKey: 'custom_0',
    }));
    store.dispatch(setAvailableModels(models));
    store.dispatch(setSelectedModel(models[0]));
    vi.spyOn(configService, 'acceptDefaultModelSelection').mockImplementation(() => undefined);
    let finishFirst!: (result: { success: true; modelRef: string }) => void;
    let finishDefaults!: (result: { success: true }) => void;
    const firstPatch = new Promise<{ success: true; modelRef: string }>(resolve => {
      finishFirst = resolve;
    });
    const defaults = new Promise<{ success: true }>(resolve => {
      finishDefaults = resolve;
    });
    const patchSessionModel = vi.fn(({ model }: { model: string }) =>
      model === 'acme/first'
        ? firstPatch
        : Promise.resolve({ success: true as const, modelRef: model }),
    );
    const setDefaultModel = vi.fn(() => defaults);
    vi.stubGlobal('electron', {
      extensions: {
        list: vi.fn().mockResolvedValue({ success: true, extensions: [] }),
        onChanged: () => () => {},
      },
      cowork: {
        patchSessionModel,
        setDefaultModel,
        getSessionModel: vi
          .fn()
          .mockResolvedValue({ success: true, source: 'gateway', modelRef: 'acme/current' }),
        getSessionGoal: vi.fn().mockResolvedValue({ success: true, goal: null }),
        getGoalExecution: vi.fn().mockResolvedValue({ success: true }),
        onSessionGoalChanged: () => () => {},
        onGoalExecutionChanged: () => () => {},
      },
      localAsr: { getStatus: vi.fn().mockResolvedValue({ available: false }) },
      localSpeechModels: { onChanged: () => () => {} },
    });
    const onSubmit = vi.fn(() => false);
    const composer = (sessionId?: string) => (
      <Provider store={store}>
        <CoworkPromptInput
          size="large"
          sessionId={sessionId}
          sessionModelRef={sessionId ? 'acme/current' : undefined}
          modelAgentId="main"
          showModelSelector
          onSubmit={onSubmit}
        />
      </Provider>
    );
    const view = render(
      composer(pendingContext === 'session' ? 'pending-model-session' : undefined),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Current' }));
    fireEvent.click(screen.getByText('First'));
    await waitFor(() =>
      expect(
        pendingContext === 'home' ? setDefaultModel : patchSessionModel,
      ).toHaveBeenCalledOnce(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'First' }));
    fireEvent.click(screen.getByText('Intermediate'));

    try {
      const targetSessionId = `independent-model-${pendingContext}`;
      view.rerender(composer(targetSessionId));
      const input = screen.getByRole('textbox') as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: 'Send with the latest model' } });
      fireEvent.click(screen.getByRole('button', { name: 'Current' }));
      fireEvent.click(screen.getByText('Latest'));
      const send = screen.getByRole('button', {
        name: i18nService.t('coworkSendMessage'),
      }) as HTMLButtonElement;

      await waitFor(() => expect(send.disabled).toBe(false));
      expect(store.getState().cowork.userConfirmedSessionModelRefs[targetSessionId]).toBe(
        'acme/latest',
      );
      fireEvent.click(send);
      await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
      expect(input.value).toBe('Send with the latest model');
    } finally {
      await act(async () => {
        finishFirst({ success: true, modelRef: 'acme/first' });
        finishDefaults({ success: true });
      });
    }
    await waitFor(() =>
      expect(
        store.getState().cowork.pendingModelSelectionTaskIds['__home__\0main'],
      ).toBeUndefined(),
    );
    expect(store.getState().model.selectedModel?.id).toBe('latest');
    expect(setDefaultModel.mock.calls.flat()).not.toContainEqual(
      expect.objectContaining({ modelId: 'intermediate' }),
    );
  },
);

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
    const prepare = vi.fn(async (input: { prompt: string }) => {
      const result = await preparation;
      return {
        prompt: input.prompt + '\n\n' + result.instruction,
        input: { mode: 'auto', verify: true },
      };
    });
    desktop.modes = [
      {
        id: 'workflow',
        pluginId: 'example-workflow',
        epoch: 'test-epoch',
        labelKey: 'exampleWorkflow',
        ordinaryTurnOnly: true,
        prepare,
      },
    ];
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
    const onSubmit = vi.fn(
      (..._args: [string, unknown?, string?, boolean?, unknown?, unknown?]) => true,
    );
    const draftKey = `temp-workflow-${context}`;
    const composer = (sessionId = draftKey) => (
      <Provider store={store}>
        <CoworkPromptInput sessionId={sessionId} onSubmit={onSubmit} />
      </Provider>
    );
    const view = render(composer());
    fireEvent.click(screen.getByRole('button', { name: i18nService.t('composerFeatures') }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'exampleWorkflow' }));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Review this project' } });
    fireEvent.click(screen.getByRole('button', { name: i18nService.t('coworkSendMessage') }));
    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'Review this project', sessionId: draftKey }),
    );

    await act(async () => {
      resolvePreparation({ success: true, instruction: '<swarm-workflow/>' });
      // Retire after the plugin validates the result, before its awaiting caller resumes.
      queueMicrotask(() => {
        if (context === 'draft') flushSync(() => view.rerender(composer(`${draftKey}-next`)));
        if (context === 'selection') {
          flushSync(() => {
            fireEvent.click(
              screen.getByRole('button', { name: i18nService.t('appPluginRemoveMode') }),
            );
          });
        }
      });
    });

    if (context === 'current') {
      expect(onSubmit).toHaveBeenCalledTimes(1);
      const args = onSubmit.mock.calls[0];
      expect(args[0]).toBe('Review this project');
      expect(readAppInput(args[2]!)?.input).toMatchObject({
        pluginId: 'example-workflow',
        mode: 'workflow',
        epoch: 'test-epoch',
        input: { mode: 'auto', verify: true },
      });
      expect(args[5]).toEqual({ startedAt: expect.any(Number) });
    } else {
      expect(onSubmit).not.toHaveBeenCalled();
      if (context === 'draft') view.rerender(composer());
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(
        'Review this project',
      );
    }
  },
);
