// @vitest-environment jsdom
import type { OpenClawModelsListResult } from '@shared/openclaw/models';
import { ProviderName } from '@shared/providers/constants';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { flushSync } from 'react-dom';
import { Provider, useSelector } from 'react-redux';
import { afterEach, expect, test, vi } from 'vitest';

import { addDraftAttachment } from '@/features/cowork/coworkSlice';
import { setAvailableModels, setSelectedModel } from '@/features/models/modelSlice';
import type { AppMode } from '@/features/plugins/app/browserRegistry';
import type { RealtimeVoiceViewState } from '@/features/speech/realtime/realtimeVoiceController';
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
  readiness: { ready: true, pending: false, failed: false },
}));
interface VoiceFixture {
  start: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  setMicrophoneMuted: ReturnType<typeof vi.fn>;
  setSpeakerMuted: ReturnType<typeof vi.fn>;
}
const voice = vi.hoisted(() => ({ instances: [] as VoiceFixture[] }));
vi.mock('@/features/speech/realtime/realtimeVoiceController', () => ({
  RealtimeVoiceController: class {
    private state: RealtimeVoiceViewState = {
      phase: 'idle',
      activity: 'listening',
      microphoneMuted: false,
      speakerMuted: false,
      userCaption: 'native user caption',
      assistantCaption: 'native assistant caption',
    };
    constructor(
      _bridge: unknown,
      private changed: (state: RealtimeVoiceViewState) => void,
    ) {
      voice.instances.push(this);
    }
    private publish(patch: Partial<RealtimeVoiceViewState>) {
      this.state = { ...this.state, ...patch };
      this.changed(this.state);
    }
    start = vi.fn(async () => {
      this.publish({ phase: 'active' });
    });
    end = vi.fn(async () => {
      this.publish({ phase: 'idle' });
    });
    dispose = vi.fn();
    setMicrophoneMuted = vi.fn((muted: boolean) => this.publish({ microphoneMuted: muted }));
    setSpeakerMuted = vi.fn((muted: boolean) => this.publish({ speakerMuted: muted }));
  },
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
  useEngineReadiness: () => desktop.readiness,
  getEngineReadinessSnapshot: () => desktop.readiness,
  subscribeEngineReadiness: () => () => {},
}));

const originalModels = store.getState().model.availableModels;
const originalSelectedModel = store.getState().model.selectedModel;

afterEach(() => {
  cleanup();
  voice.instances.length = 0;
  desktop.modes = [];
  desktop.readiness = { ready: true, pending: false, failed: false };
  store.dispatch(setAvailableModels(originalModels));
  store.dispatch(setSelectedModel(originalSelectedModel));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('offers Stop during automatic retry before a native run starts, even with a draft', async () => {
  vi.stubGlobal('electron', {
    extensions: { list: vi.fn().mockResolvedValue({ success: true, extensions: [] }), onChanged: () => () => {} },
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
  const onQueue = vi.fn();
  const onStop = vi.fn().mockResolvedValue(true);
  const composer = (automaticRetryActive: boolean) => (
    <Provider store={store}>
      <CoworkPromptInput
        sessionId="automatic-retry-stop"
        automaticRetryActive={automaticRetryActive}
        onSubmit={onSubmit}
        onQueue={onQueue}
        onStop={onStop}
      />
    </Provider>
  );
  const view = render(composer(false));
  const draft = screen.getByRole('textbox');
  fireEvent.change(draft, { target: { value: 'Keep this draft' } });
  expect(screen.queryByRole('button', { name: i18nService.t('coworkStopTask') })).toBeNull();

  view.rerender(composer(true));
  expect(screen.queryByRole('button', { name: i18nService.t('coworkQueueMessage') })).toBeNull();
  const stop = screen.getByRole('button', { name: i18nService.t('coworkStopTask') });
  expect(stop).toHaveProperty('disabled', false);
  await act(async () => fireEvent.click(stop));
  expect(onStop).toHaveBeenCalledOnce();
  expect(onQueue).not.toHaveBeenCalled();
  expect(onSubmit).not.toHaveBeenCalled();
  expect(draft).toHaveProperty('value', 'Keep this draft');
});

test('keeps inline voice alive across task start and both composer layouts with text editing intact', async () => {
  const config = configService.getConfig();
  vi.spyOn(configService, 'getConfig').mockReturnValue({
    ...config,
    voice: { ...config.voice, inputEnabled: false, realtimeEnabled: true },
  });
  vi.stubGlobal('electron', {
    extensions: {
      list: vi.fn().mockResolvedValue({ success: true, extensions: [] }),
      onChanged: () => () => {},
    },
    realtimeVoice: { getStatus: vi.fn().mockResolvedValue({ available: true }) },
    cowork: {
      getSessionGoal: vi.fn().mockResolvedValue({ success: true, goal: null }),
      getGoalExecution: vi.fn().mockResolvedValue({ success: true }),
      onSessionGoalChanged: () => () => {},
      onGoalExecutionChanged: () => () => {},
    },
    localAsr: { getStatus: vi.fn().mockResolvedValue({ available: false }) },
    localSpeechModels: { onChanged: () => () => {} },
  });
  const composer = (size: 'normal' | 'large', isStreaming = false) => (
    <Provider store={store}>
      <CoworkPromptInput
        sessionId="voice-composer-session"
        size={size}
        isStreaming={isStreaming}
        onSubmit={vi.fn()}
      />
    </Provider>
  );
  const view = render(composer('normal'));
  const start = screen.getByRole('button', { name: i18nService.t('realtimeVoiceStart') });
  await waitFor(() => expect(start).toHaveProperty('disabled', false));
  fireEvent.click(start);
  expect(screen.getByText(i18nService.t('realtimeVoiceListening'))).toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByText('native user caption')).toBeNull();
  expect(screen.queryByText('native assistant caption')).toBeNull();
  view.rerender(composer('large', true));
  expect(voice.instances).toHaveLength(1);
  expect(voice.instances[0].end).not.toHaveBeenCalled();
  expect(voice.instances[0].dispose).not.toHaveBeenCalled();
  expect(screen.getAllByRole('region', { name: i18nService.t('realtimeVoiceTitle') })).toHaveLength(
    1,
  );
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  expect(input.disabled).toBe(false);
  fireEvent.change(input, { target: { value: 'Keep a normal draft while talking' } });
  fireEvent.click(screen.getByRole('button', { name: i18nService.t('realtimeVoiceMuteSpeaker') }));
  expect(voice.instances[0].setSpeakerMuted).toHaveBeenCalledWith(true);
  expect(voice.instances[0].end).not.toHaveBeenCalled();
  view.rerender(composer('normal', true));
  expect(
    screen.getByRole('button', { name: i18nService.t('realtimeVoiceUnmuteSpeaker') }),
  ).toHaveProperty('disabled', false);
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(
    'Keep a normal draft while talking',
  );
  expect(voice.instances[0].start).toHaveBeenCalledOnce();
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: i18nService.t('realtimeVoiceEnd') })),
  );
  expect(screen.queryByRole('region', { name: i18nService.t('realtimeVoiceTitle') })).toBeNull();
  view.unmount();
  expect(voice.instances[0].dispose).toHaveBeenCalledOnce();
});

test.each(['granted', 'rejected'] as const)(
  'keeps voice admission locked across a layout change until a pending permission is %s',
  async outcome => {
    const config = configService.getConfig();
    vi.spyOn(configService, 'getConfig').mockReturnValue({
      ...config,
      voice: {
        ...config.voice,
        inputEnabled: true,
        realtimeEnabled: true,
        recognitionMode: 'local',
        inputSource: 'microphone',
      },
    });
    let resolvePermission!: (stream: MediaStream) => void;
    let rejectPermission!: (error: Error) => void;
    const getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((resolve, reject) => {
          resolvePermission = resolve;
          rejectPermission = reject;
        }),
    );
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    vi.stubGlobal('electron', {
      extensions: {
        list: vi.fn().mockResolvedValue({ success: true, extensions: [] }),
        onChanged: () => () => {},
      },
      realtimeVoice: { getStatus: vi.fn().mockResolvedValue({ available: true }) },
      cowork: {
        getSessionGoal: vi.fn().mockResolvedValue({ success: true, goal: null }),
        getGoalExecution: vi.fn().mockResolvedValue({ success: true }),
        onSessionGoalChanged: () => () => {},
        onGoalExecutionChanged: () => () => {},
      },
      localAsr: { getStatus: vi.fn().mockResolvedValue({ available: true }) },
      localSpeechModels: { onChanged: () => () => {} },
    });
    const composer = (size: 'normal' | 'large') => (
      <Provider store={store}>
        <CoworkPromptInput sessionId="voice-layout-pending" size={size} onSubmit={vi.fn()} />
      </Provider>
    );
    const view = render(composer('normal'));
    const microphone = await screen.findByRole('button', { name: i18nService.t('localAsrStart') });
    await waitFor(() => expect(microphone).toHaveProperty('disabled', false));
    fireEvent.click(microphone);
    const phone = () => screen.getByRole('button', { name: i18nService.t('realtimeVoiceStart') });
    expect(phone()).toHaveProperty('disabled', true);
    view.rerender(composer('large'));
    expect(phone()).toHaveProperty('disabled', true);
    expect(
      await screen.findByRole('button', { name: i18nService.t('localAsrStart') }),
    ).toHaveProperty('disabled', true);
    fireEvent.click(phone());
    expect(voice.instances[0].start).not.toHaveBeenCalled();
    const stop = vi.fn();
    await act(async () => {
      if (outcome === 'granted')
        resolvePermission({ getTracks: () => [{ stop }] } as unknown as MediaStream);
      else rejectPermission(new DOMException('Denied', 'NotAllowedError'));
    });
    if (outcome === 'granted') expect(stop).toHaveBeenCalledOnce();
    await waitFor(() => expect(phone()).toHaveProperty('disabled', false));
    expect(getUserMedia).toHaveBeenCalledOnce();
    fireEvent.click(phone());
    expect(voice.instances[0].start).toHaveBeenCalledOnce();
  },
);

test('keeps a running conversation draft growing, capped and shrinkable across idle transition', () => {
  vi.stubGlobal('electron', {
    extensions: {
      list: vi.fn().mockResolvedValue({ success: true, extensions: [] }),
      onChanged: () => () => {},
    },
    localAsr: { getStatus: vi.fn().mockResolvedValue({ available: false }) },
    localSpeechModels: { onChanged: () => () => {} },
  });
  const onSubmit = vi.fn();
  const renderComposer = (isStreaming: boolean) => (
    <Provider store={store}>
      <CoworkPromptInput size="large" isStreaming={isStreaming} onSubmit={onSubmit} />
    </Provider>
  );
  const view = render(renderComposer(true));
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  Object.defineProperty(input, 'scrollHeight', {
    configurable: true,
    get: () => input.value.split('\n').length * 24 + 16,
  });

  fireEvent.change(input, { target: { value: 'one\ntwo\nthree\nfour' } });
  expect(input.disabled).toBe(false);
  expect(input.style.height).toBe('112px');
  fireEvent.change(input, { target: { value: Array(20).fill('line').join('\n') } });
  expect(input.style.height).toBe('200px');
  view.rerender(renderComposer(false));
  expect(input.style.height).toBe('200px');
  fireEvent.change(input, { target: { value: '' } });
  expect(input.style.height).toBe('40px');
  expect(onSubmit).not.toHaveBeenCalled();
});

test('pastes multiline clipboard text from the context menu while a conversation is running', async () => {
  vi.stubGlobal('electron', {
    extensions: {
      list: vi.fn().mockResolvedValue({ success: true, extensions: [] }),
      onChanged: () => () => {},
    },
    localAsr: { getStatus: vi.fn().mockResolvedValue({ available: false }) },
    localSpeechModels: { onChanged: () => () => {} },
  });
  const text = 'pasted line one\npasted line two\npasted line three\npasted line four';
  const readText = vi.fn().mockResolvedValue(text);
  vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { clipboard: { readText } }));
  const onSubmit = vi.fn();
  render(
    <Provider store={store}>
      <CoworkPromptInput size="large" isStreaming onSubmit={onSubmit} />
    </Provider>,
  );
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  Object.defineProperty(input, 'scrollHeight', {
    configurable: true,
    get: () => input.value.split('\n').length * 24 + 16,
  });
  fireEvent.contextMenu(input, { clientX: 20, clientY: 20 });
  const paste = screen.getByRole('menuitem', {
    name: i18nService.t('contextMenuPaste'),
  }) as HTMLButtonElement;
  expect(paste.disabled).toBe(false);
  fireEvent.click(paste);

  await waitFor(() => expect(input.value).toBe(text));
  expect(readText).toHaveBeenCalledOnce();
  expect(input.style.height).toBe('112px');
  expect(onSubmit).not.toHaveBeenCalled();
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

test('explains an unavailable session state and retries without submitting or changing the draft', async () => {
  store.dispatch(setAvailableModels([{ id: 'state-retry-model', name: 'Model' }]));
  const retry = deferredSessionState();
  const getSessionGoal = vi
    .fn()
    .mockResolvedValueOnce({ success: false })
    .mockImplementationOnce(() => retry.promise);
  const getGoalExecution = vi.fn().mockResolvedValue({ success: true });
  vi.stubGlobal('electron', {
    extensions: {
      list: vi.fn().mockResolvedValue({ success: true, extensions: [] }),
      onChanged: () => () => {},
    },
    cowork: {
      getSessionGoal,
      getGoalExecution,
      onSessionGoalChanged: () => () => {},
      onGoalExecutionChanged: () => () => {},
    },
    localAsr: { getStatus: vi.fn().mockResolvedValue({ available: false }) },
    localSpeechModels: { onChanged: () => () => {} },
  });
  const onSubmit = vi.fn();
  render(
    <Provider store={store}>
      <CoworkPromptInput sessionId="state-retry" onSubmit={onSubmit} />
    </Provider>,
  );
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: 'Keep this draft during recovery' } });
  const notice = await screen.findByText(i18nService.t('coworkSessionStateReadFailed'));
  expect(notice).toBeTruthy();
  const send = screen.getByRole('button', {
    name: i18nService.t('coworkSendMessage'),
  }) as HTMLButtonElement;
  expect(send.disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: i18nService.t('coworkSessionStateRetry') }));
  const checking = (await screen.findByRole('button', {
    name: i18nService.t('coworkSessionStateChecking'),
  })) as HTMLButtonElement;
  expect(checking.disabled).toBe(true);
  expect(send.disabled).toBe(true);
  expect(input.value).toBe('Keep this draft during recovery');
  expect(onSubmit).not.toHaveBeenCalled();
  await act(async () => {
    retry.resolve({ success: true, goal: null });
  });
  await waitFor(() => expect(send.disabled).toBe(false));
  expect(screen.queryByText(i18nService.t('coworkSessionStateReadFailed'))).toBeNull();
  expect(getSessionGoal).toHaveBeenCalledTimes(2);
  expect(getGoalExecution).toHaveBeenCalledTimes(2);
  expect(onSubmit).not.toHaveBeenCalled();
  expect(input.value).toBe('Keep this draft during recovery');
});

function deferredSessionState() {
  let resolve!: (value: { success: boolean; goal: null }) => void;
  const promise = new Promise<{ success: boolean; goal: null }>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

test('keeps a retyped draft when the cleared submission is accepted late', async () => {
  store.dispatch(setAvailableModels([{ id: 'draft-lifetime-model', name: 'Model' }]));
  vi.stubGlobal('electron', {
    extensions: { list: vi.fn().mockResolvedValue({ success: true, extensions: [] }), onChanged: () => () => {} },
    localAsr: { getStatus: vi.fn().mockResolvedValue({ available: false }) },
    localSpeechModels: { onChanged: () => () => {} },
  });
  let accept!: (accepted: boolean) => void;
  const pending = new Promise<boolean>(resolve => { accept = resolve; });
  const onSubmit = vi.fn().mockReturnValueOnce(pending).mockResolvedValueOnce(true);
  render(
    <Provider store={store}>
      <CoworkPromptInput sessionId="temp-draft-lifetime" onSubmit={onSubmit} />
    </Provider>,
  );
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  const send = screen.getByRole('button', { name: i18nService.t('coworkSendMessage') }) as HTMLButtonElement;
  fireEvent.change(input, { target: { value: 'Send this' } });
  fireEvent.click(send);
  await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());

  fireEvent.change(input, { target: { value: '' } });
  fireEvent.change(input, { target: { value: 'Send this' } });
  await act(async () => { accept(true); });

  expect(input.value).toBe('Send this');
  await waitFor(() => expect(send.disabled).toBe(false));
  fireEvent.click(send);
  await waitFor(() => expect(input.value).toBe(''));
  expect(onSubmit).toHaveBeenCalledTimes(2);
});

test('keeps a new draft when audio staging finishes for a discarded one', async () => {
  store.dispatch(setAvailableModels([{ id: 'audio-draft-model', name: 'Model' }]));
  const sessionId = 'temp-discarded-audio';
  store.dispatch(addDraftAttachment({
    draftKey: sessionId, attachment: { path: 'E:/外部/录音.wav', name: '录音.wav' },
  }));
  let finishStaging!: (result: { success: true; path: string }) => void;
  const staging = new Promise<{ success: true; path: string }>(resolve => { finishStaging = resolve; });
  const stageAttachment = vi.fn().mockReturnValue(staging);
  vi.stubGlobal('electron', {
    extensions: { list: vi.fn().mockResolvedValue({ success: true, extensions: [] }), onChanged: () => () => {} },
    localAsr: { getStatus: vi.fn().mockResolvedValue({ available: false }), stageAttachment },
    localSpeechModels: { onChanged: () => () => {} },
  });
  const onSubmit = vi.fn().mockResolvedValue(true);
  render(
    <Provider store={store}>
      <CoworkPromptInput sessionId={sessionId} workingDirectory="E:/项目" onSubmit={onSubmit} />
    </Provider>,
  );
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  const send = screen.getByRole('button', { name: i18nService.t('coworkSendMessage') }) as HTMLButtonElement;
  fireEvent.change(input, { target: { value: 'Transcribe' } });
  fireEvent.click(send);
  await waitFor(() => expect(stageAttachment).toHaveBeenCalledWith('E:/外部/录音.wav', 'E:/项目'));

  act(() => { window.dispatchEvent(new CustomEvent('cowork:focus-input')); });
  fireEvent.change(input, { target: { value: 'New message' } });
  await act(async () => { finishStaging({ success: true, path: 'E:/项目/.audio-attachments/录音.wav' }); });

  expect(onSubmit).not.toHaveBeenCalled();
  expect(input.value).toBe('New message');
  fireEvent.click(send);
  await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
});

test('waits for engine readiness and retires previous state failures while restarting', async () => {
  store.dispatch(setAvailableModels([{ id: 'state-startup-model', name: 'Model' }]));
  desktop.readiness = { ready: false, pending: true, failed: false };
  const resumed = deferredSessionState();
  const getSessionGoal = vi
    .fn()
    .mockResolvedValueOnce({ success: false })
    .mockImplementationOnce(() => resumed.promise);
  const getGoalExecution = vi.fn().mockResolvedValue({ success: true });
  vi.stubGlobal('electron', {
    extensions: {
      list: vi.fn().mockResolvedValue({ success: true, extensions: [] }),
      onChanged: () => () => {},
    },
    cowork: {
      getSessionGoal,
      getGoalExecution,
      onSessionGoalChanged: () => () => {},
      onGoalExecutionChanged: () => () => {},
    },
    localAsr: { getStatus: vi.fn().mockResolvedValue({ available: false }) },
    localSpeechModels: { onChanged: () => () => {} },
  });
  const onSubmit = vi.fn();
  const composer = () => (
    <Provider store={store}>
      <CoworkPromptInput sessionId="state-startup" onSubmit={onSubmit} />
    </Provider>
  );
  const view = render(composer());
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: 'Keep this draft while starting' } });
  const send = screen.getByRole('button', {
    name: i18nService.t('coworkSendMessage'),
  }) as HTMLButtonElement;
  expect(getSessionGoal).not.toHaveBeenCalled();
  expect(getGoalExecution).not.toHaveBeenCalled();
  expect(screen.queryByText(i18nService.t('coworkSessionStateReadFailed'))).toBeNull();
  expect(send.disabled).toBe(true);

  desktop.readiness = { ready: true, pending: false, failed: false };
  view.rerender(composer());
  await screen.findByText(i18nService.t('coworkSessionStateReadFailed'));
  expect(getSessionGoal).toHaveBeenCalledOnce();
  desktop.readiness = { ready: false, pending: true, failed: false };
  view.rerender(composer());
  expect(screen.queryByText(i18nService.t('coworkSessionStateReadFailed'))).toBeNull();
  expect(getSessionGoal).toHaveBeenCalledOnce();
  expect(send.disabled).toBe(true);

  desktop.readiness = { ready: true, pending: false, failed: false };
  view.rerender(composer());
  await waitFor(() => expect(getSessionGoal).toHaveBeenCalledTimes(2));
  expect(screen.queryByText(i18nService.t('coworkSessionStateReadFailed'))).toBeNull();
  expect(send.disabled).toBe(true);
  await act(async () => {
    resumed.resolve({ success: true, goal: null });
  });
  await waitFor(() => expect(send.disabled).toBe(false));
  expect(input.value).toBe('Keep this draft while starting');
  expect(onSubmit).not.toHaveBeenCalled();
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

test.each([
  { scenario: 'selecting another folder', saved: true, reset: false },
  { scenario: 'a failed switch', saved: false, reset: false },
  { scenario: 'resetting to the default', saved: true, reset: true },
])('responds immediately and waits to send when $scenario', async ({ saved, reset }) => {
  const oldDirectory = 'C:/old-project';
  const nextDirectory = reset ? 'C:/default-project' : 'C:/next-project';
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('electron', {
    platform: 'win32',
    getRecentCwds: vi.fn().mockResolvedValue(['c:\\OLD-PROJECT\\', nextDirectory]),
    extensions: {
      list: vi.fn().mockResolvedValue({ success: true, extensions: [] }),
      onChanged: () => () => {},
    },
    localAsr: { getStatus: vi.fn().mockResolvedValue({ available: false }) },
    localSpeechModels: { onChanged: () => () => {} },
  });
  const models = [{ id: 'draft-model', name: 'Draft model', providerKey: 'draft-provider' }];
  store.dispatch(setAvailableModels(models));
  store.dispatch(setSelectedModel(models[0]));
  const onSubmit = vi.fn(() => false);
  const applyDirectory = Promise.withResolvers<boolean>();
  const onWorkingDirectoryChange = vi.fn(() => applyDirectory.promise);
  const composer = (cwd: string) => (
    <Provider store={store}>
      <CoworkPromptInput
        size="large"
        showFolderSelector
        workingDirectory={cwd}
        onWorkingDirectoryChange={onWorkingDirectoryChange}
        onSubmit={onSubmit}
      />
    </Provider>
  );
  const view = render(composer(oldDirectory));
  const folderButton = screen.getByRole('button', { name: i18nService.t('workspacePickerTitle') });
  await act(async () => fireEvent.click(folderButton));
  fireEvent.click(screen.getByRole('button', { current: true }));
  expect(onWorkingDirectoryChange).not.toHaveBeenCalled();

  if (reset) {
    fireEvent.click(folderButton.querySelector('[role="button"]')!);
  } else {
    fireEvent.click(folderButton);
    fireEvent.click(screen.getByTitle(nextDirectory));
    expect(folderButton.textContent).toContain('next-project');
  }
  expect(onWorkingDirectoryChange).toHaveBeenCalledExactlyOnceWith(reset ? '' : nextDirectory);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(folderButton).toHaveProperty(
    'title',
    reset ? i18nService.t('workspacePickerApplying') : nextDirectory,
  );
  expect(folderButton.getAttribute('aria-busy')).toBe('true');

  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'Keep this draft' } });
  const send = screen.getByRole('button', { name: i18nService.t('coworkSendMessage') });
  expect(send).toHaveProperty('disabled', true);
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onSubmit).not.toHaveBeenCalled();
  expect(input).toHaveProperty('value', 'Keep this draft');

  if (saved) view.rerender(composer(nextDirectory));
  const toast = vi.fn();
  window.addEventListener('app:showToast', toast, { once: true });
  try {
    await act(async () => applyDirectory.resolve(saved));
    if (saved) {
      expect(toast).not.toHaveBeenCalled();
    } else {
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ detail: i18nService.t('sessionWorkspaceUnavailable') }),
      );
    }
  } finally {
    window.removeEventListener('app:showToast', toast);
  }
  expect(folderButton).toHaveProperty('title', saved ? nextDirectory : oldDirectory);
  expect(folderButton.getAttribute('aria-busy')).toBe('false');
  fireEvent.click(send);
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

test('shows configured built-in models immediately and refreshes their Gateway capabilities', async () => {
  const customModel = { id: 'custom', name: 'Custom Model', provider: 'Acme', providerKey: 'acme' };
  const builtinModel = {
    id: 'managed',
    name: 'Managed Model',
    provider: 'Built-in',
    providerKey: ProviderName.BuiltinModels,
  };
  const early = Promise.withResolvers<OpenClawModelsListResult>();
  const sessionModel = Promise.withResolvers<{ success: false }>();
  const getSessionModel = vi.fn(() => sessionModel.promise);
  const list = vi.fn<() => Promise<OpenClawModelsListResult>>()
    .mockResolvedValue({ success: true, models: [] });
  const listeners = new Set<() => void>();
  const onChanged = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const notifyRuntimeChange = () => {
    act(() => listeners.forEach(listener => listener()));
  };
  vi.stubGlobal('electron', {
    extensions: {
      list: vi.fn().mockResolvedValue({ success: true, extensions: [] }),
      onChanged: () => () => {},
    },
    cowork: {
      getSessionModel,
      getSessionGoal: vi.fn().mockResolvedValue({ success: true, goal: null }),
      getGoalExecution: vi.fn().mockResolvedValue({ success: true }),
      onSessionGoalChanged: () => () => {},
      onGoalExecutionChanged: () => () => {},
    },
    openclaw: { models: { list, onChanged } },
    localAsr: { getStatus: vi.fn().mockResolvedValue({ available: false }) },
    localSpeechModels: { onChanged: () => () => {} },
  });
  store.dispatch(setAvailableModels([customModel]));
  store.dispatch(setSelectedModel(customModel));
  const view = render(
    <Provider store={store}>
      <CoworkPromptInput
        size="large"
        sessionId="managed-model-refresh"
        sessionModelRef="acme/custom"
        modelAgentId="main"
        showModelSelector
        onSubmit={() => false}
      />
    </Provider>,
  );
  fireEvent.click(screen.getByRole('button', { name: customModel.name }));

  list.mockReturnValueOnce(early.promise);
  act(() => {
    store.dispatch(setAvailableModels([customModel, builtinModel]));
  });
  expect(screen.getByText(builtinModel.name)).toBeTruthy();
  const imageInput = i18nService.t('imageInput');
  expect(screen.queryByTitle(imageInput)).toBeNull();

  const appliedCatalog: OpenClawModelsListResult = {
    success: true,
    models: [{
      id: builtinModel.id,
      name: builtinModel.name,
      provider: ProviderName.BuiltinModels,
      input: ['text', 'image'],
    }],
  };
  list.mockResolvedValueOnce(appliedCatalog);
  notifyRuntimeChange();
  await screen.findByTitle(imageInput);
  expect(getSessionModel).toHaveBeenCalled();

  await act(async () => {
    early.resolve({ success: true, models: [] });
  });
  expect(screen.getByTitle(imageInput)).toBeTruthy();

  const sessionReads = getSessionModel.mock.calls.length;
  list.mockResolvedValueOnce({ success: false, models: [] });
  notifyRuntimeChange();
  await waitFor(() => expect(screen.queryByTitle(imageInput)).toBeNull());
  expect(screen.getByText(builtinModel.name)).toBeTruthy();
  expect(getSessionModel).toHaveBeenCalledTimes(sessionReads);

  list.mockResolvedValueOnce(appliedCatalog);
  notifyRuntimeChange();
  await screen.findByTitle(imageInput);
  act(() => {
    store.dispatch(setAvailableModels([customModel]));
  });
  expect(screen.queryByText(builtinModel.name)).toBeNull();

  view.unmount();
  expect(listeners.size).toBe(0);
  await act(async () => {
    sessionModel.resolve({ success: false });
  });
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
      expect(args[5]).toMatchObject({ startedAt: expect.any(Number) });
    } else {
      expect(onSubmit).not.toHaveBeenCalled();
      if (context === 'draft') view.rerender(composer());
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(
        'Review this project',
      );
    }
  },
);
