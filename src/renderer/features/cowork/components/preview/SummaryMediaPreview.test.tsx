// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { SummaryMediaPreview } from './SummaryMediaPreview';

afterEach(async () => {
  cleanup();
  await Promise.resolve();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('previews the existing audio with the shared reader and releases playback when closed', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  const prepareAssistantMediaPlayback = vi
    .fn()
    .mockResolvedValue({ success: true, url: 'localmedia://gateway/preview' });
  const releaseAssistantMediaPlayback = vi.fn().mockResolvedValue({ success: true });
  vi.stubGlobal('electron', {
    openclaw: { engine: { prepareAssistantMediaPlayback, releaseAssistantMediaPlayback } },
  });
  const onClose = vi.fn();
  const view = render(
    <SummaryMediaPreview
      source={{
        url: '/api/chat/media/outgoing/agent%3Amain%3Asession/11111111-1111-4111-8111-111111111111/full',
        label: 'voice.wav',
        kind: 'audio',
        sessionKey: 'agent:main:session',
      }}
      onClose={onClose}
    />,
  );
  const dialog = screen.getByRole('dialog', { name: 'voice.wav' });
  await waitFor(() =>
    expect(dialog.querySelector('audio')?.getAttribute('src')).toBe('localmedia://gateway/preview'),
  );
  expect(dialog.querySelector('audio')?.autoplay).toBe(false);
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledOnce();
  view.unmount();
  await waitFor(() =>
    expect(releaseAssistantMediaPlayback).toHaveBeenCalledWith({
      url: 'localmedia://gateway/preview',
    }),
  );
});
