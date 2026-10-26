// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, expect, test, vi } from 'vitest';

import { setAvailableModels, setSelectedModel } from '@/features/models/modelSlice';
import { configService } from '@/services/config';
import { i18nService } from '@/services/i18n';
import { store } from '@/store';

import CoworkPromptInput from './CoworkPromptInput';
import { captureHomeComposerModelRef } from './selection/homeModelSelection';

const originalModels = store.getState().model.availableModels;
const originalSelectedModel = store.getState().model.selectedModel;

afterEach(() => {
  cleanup();
  store.dispatch(setAvailableModels(originalModels));
  store.dispatch(setSelectedModel(originalSelectedModel));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function modelSendFixture() {
  const models = ['Current', 'Next'].map(name => ({
    id: name.toLowerCase(), name, provider: 'Acme', providerKey: 'custom_0',
  }));
  store.dispatch(setAvailableModels(models));
  store.dispatch(setSelectedModel(models[0]));
  vi.spyOn(configService, 'acceptDefaultModelSelection').mockImplementation(() => undefined);
  let finishPatch!: (result: { success: boolean; modelRef?: string; error?: string }) => void;
  let finishDefaults!: (result: { success: boolean; error?: string }) => void;
  const patch = new Promise<{ success: boolean; modelRef?: string; error?: string }>(resolve => { finishPatch = resolve; });
  const defaults = new Promise<{ success: boolean; error?: string }>(resolve => { finishDefaults = resolve; });
  const patchSessionModel = vi.fn(() => patch);
  const setDefaultModel = vi.fn(() => defaults);
  vi.stubGlobal('electron', {
    extensions: { list: vi.fn().mockResolvedValue({ success: true, extensions: [] }), onChanged: () => () => {} },
    cowork: {
      patchSessionModel, setDefaultModel,
      getSessionModel: vi.fn().mockResolvedValue({ success: true, source: 'gateway', modelRef: 'acme/current' }),
      getSessionGoal: vi.fn().mockResolvedValue({ success: true, goal: null }),
      getGoalExecution: vi.fn().mockResolvedValue({ success: true }),
      onSessionGoalChanged: () => () => {}, onGoalExecutionChanged: () => () => {},
    },
    localAsr: { getStatus: vi.fn().mockResolvedValue({ available: false }) },
    localSpeechModels: { onChanged: () => () => {} },
  });
  return { finishPatch, finishDefaults, patchSessionModel, setDefaultModel };
}

test.each(['send', 'queue', 'rejected', 'unconfirmed', 'navigate', 'return', 'disabled'] as const)(
  'accepts an immediate %s click once and waits for the exact model receipt',
  async outcome => {
    const fixture = modelSendFixture();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sessionId = `immediate-model-${outcome}`;
    const onSubmit = vi.fn((_prompt: string, ..._rest: unknown[]) => false);
    const onQueue = vi.fn((_prompt: string) => false);
    const composer = (id: string, disabled = false) => (
      <Provider store={store}>
        <CoworkPromptInput
          size="large" sessionId={id} sessionModelRef="acme/current" modelAgentId="main"
          showModelSelector onSubmit={onSubmit} onQueue={outcome === 'queue' ? onQueue : undefined}
          isStreaming={outcome === 'queue'} disabled={disabled}
        />
      </Provider>
    );
    const view = render(composer(sessionId));
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'Captured draft' } });
    const sendLabel = i18nService.t(outcome === 'queue' ? 'coworkQueueMessage' : 'coworkSendMessage');
    await waitFor(() => expect((screen.getByRole('button', {
      name: sendLabel,
    }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Current' }));
    const send = screen.getByRole('button', { name: sendLabel });
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    act(() => {
      fireEvent.click(screen.getByText('Next'));
      fireEvent.click(send);
      fireEvent.click(send);
    });
    await waitFor(() => expect(fixture.patchSessionModel).toHaveBeenCalledOnce());
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onQueue).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
    expect(input.value).toBe('Captured draft');
    if (outcome === 'navigate') view.rerender(composer('new-destination'));
    if (outcome === 'return') {
      view.rerender(composer('other-destination'));
      view.rerender(composer(sessionId));
    }
    if (outcome === 'disabled') view.rerender(composer(sessionId, true));
    now.mockReturnValue(20_000);
    await act(async () => {
      fixture.finishPatch(outcome === 'rejected'
        ? { success: false, error: 'Unknown model update outcome' }
        : { success: true, modelRef: outcome === 'unconfirmed' ? undefined : 'acme/next' });
    });
    if (outcome === 'send' || outcome === 'queue') {
      await waitFor(() => expect(outcome === 'queue' ? onQueue : onSubmit).toHaveBeenCalledOnce());
      expect((outcome === 'queue' ? onQueue : onSubmit).mock.calls[0][0]).toBe('Captured draft');
      if (outcome === 'send') expect(onSubmit.mock.calls[0][5]).toEqual({ startedAt: 10_000 });
    } else {
      const contextKey = `${sessionId}${String.fromCharCode(0)}main`;
      await waitFor(() => expect(store.getState().cowork.pendingModelSelectionTaskIds[contextKey])[
        outcome === 'rejected' || outcome === 'unconfirmed' ? 'toBeDefined' : 'toBeUndefined'
      ]());
      expect(onSubmit).not.toHaveBeenCalled();
      expect(onQueue).not.toHaveBeenCalled();
    }
    if (outcome !== 'navigate') expect(input.value).toBe('Captured draft');
    await act(async () => { fixture.finishDefaults({ success: true }); });
  },
);

test('keeps a failed prewarm choice across navigation, reports only on Send, and replaces its receipt on the next choice', async () => {
  const fixture = modelSendFixture();
  const toast = vi.fn();
  window.addEventListener('app:showToast', toast);
  try {
    const sessionId = 'deferred-model-failure';
    const contextKey = `${sessionId}\0main`;
    const onSubmit = vi.fn(() => false);
    const composer = (id: string) => <Provider store={store}>
      <CoworkPromptInput size="large" sessionId={id} sessionModelRef="acme/current"
        modelAgentId="main" showModelSelector onSubmit={onSubmit} />
    </Provider>;
    const view = render(composer(sessionId));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Preserve this draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Current' }));
    fireEvent.click(screen.getByText('Next'));
    await waitFor(() => expect(fixture.patchSessionModel).toHaveBeenCalledOnce());
    await act(async () => { fixture.finishPatch({ success: false, error: 'Model confirmation unavailable' }); });
    expect(toast).not.toHaveBeenCalled();
    expect(store.getState().cowork.manualModelSelections[contextKey]?.id).toBe('next');
    expect(store.getState().cowork.userConfirmedSessionModelRefs[sessionId]).toBeUndefined();
    view.rerender(composer('another-model-context'));
    view.rerender(composer(sessionId));
    expect(screen.getByRole('button', { name: 'Next' })).toBeTruthy();
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'Preserve this draft' } });
    await waitFor(() => expect((screen.getByRole('button', {
      name: i18nService.t('coworkSendMessage'),
    }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: i18nService.t('coworkSendMessage') }));
    await waitFor(() => expect(toast).toHaveBeenCalledOnce());
    expect((toast.mock.calls[0][0] as CustomEvent).detail).toBe(
      i18nService.t('coworkModelPreparationFailed').replace('{error}', 'Model confirmation unavailable'),
    );
    expect(input.value).toBe('Preserve this draft');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(fixture.patchSessionModel).toHaveBeenCalledOnce();
    fixture.patchSessionModel.mockResolvedValueOnce({ success: true, modelRef: 'acme/current' });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByText('Current'));
    await waitFor(() => expect(store.getState().cowork.pendingModelSelectionTaskIds[contextKey]).toBeUndefined());
    fireEvent.click(screen.getByRole('button', { name: i18nService.t('coworkSendMessage') }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(toast).toHaveBeenCalledOnce();
    await act(async () => { fixture.finishDefaults({ success: true }); });
  } finally {
    window.removeEventListener('app:showToast', toast);
  }
});

test('a default-save failure never reports a model switch error or blocks its confirmed session send', async () => {
  const fixture = modelSendFixture();
  const toast = vi.fn();
  window.addEventListener('app:showToast', toast);
  try {
    const onSubmit = vi.fn(() => false);
    render(<Provider store={store}>
      <CoworkPromptInput size="large" sessionId="default-failure-confirmed-model" sessionModelRef="acme/next"
        modelAgentId="main" showModelSelector onSubmit={onSubmit} />
    </Provider>);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Send with desired model' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByText('Current'));
    await act(async () => { fixture.finishPatch({ success: true, modelRef: 'acme/current' }); });
    await waitFor(() => expect(fixture.setDefaultModel).toHaveBeenCalledOnce());
    await act(async () => { fixture.finishDefaults({ success: false, error: 'Preference storage unavailable' }); });
    expect(toast).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: i18nService.t('coworkSendMessage') }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(store.getState().cowork.userConfirmedSessionModelRefs['default-failure-confirmed-model']).toBe('acme/current');
    expect(toast).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener('app:showToast', toast);
  }
});

test('home sends the mounted manual choice immediately while its default save remains pending', async () => {
  const fixture = modelSendFixture();
  const captured: (string | undefined)[] = [];
  const onSubmit = vi.fn(() => {
    captured.push(captureHomeComposerModelRef(store.getState(), 'main'));
    return false;
  });
  render(<Provider store={store}>
    <CoworkPromptInput size="large" modelAgentId="main" showModelSelector onSubmit={onSubmit} />
  </Provider>);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Send immediately' } });
  fireEvent.click(screen.getByRole('button', { name: 'Current' }));
  act(() => {
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByRole('button', { name: i18nService.t('coworkSendMessage') }));
  });
  await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
  expect(captured).toEqual(['acme/next']);
  expect(fixture.patchSessionModel).not.toHaveBeenCalled();
  expect(store.getState().model.selectedModel?.id).toBe('current');
  expect(store.getState().cowork.pendingModelSelectionTaskIds[`__home__${String.fromCharCode(0)}main`]).toBeDefined();
  await act(async () => { fixture.finishDefaults({ success: true }); });
});
