// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { flushSync } from 'react-dom';
import { Provider } from 'react-redux';
import { afterEach, expect, test, vi } from 'vitest';

import { setAvailableModels } from '@/features/models/modelSlice';
import { configService } from '@/services/config';
import { i18nService } from '@/services/i18n';
import { store } from '@/store';

import CoworkPromptInput from './CoworkPromptInput';

const originalModels = store.getState().model.availableModels;

afterEach(() => {
  cleanup();
  store.dispatch(setAvailableModels(originalModels));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
