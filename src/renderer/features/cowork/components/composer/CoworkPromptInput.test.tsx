// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, expect, test, vi } from 'vitest';

import { configService } from '@/services/config';
import { i18nService } from '@/services/i18n';
import { store } from '@/store';

import CoworkPromptInput from './CoworkPromptInput';

afterEach(() => {
  cleanup();
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
