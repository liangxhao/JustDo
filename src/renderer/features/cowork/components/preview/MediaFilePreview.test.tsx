// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import MediaFilePreview, { localMediaPreviewUrl } from './MediaFilePreview';

beforeEach(() => {
  i18nService.setLanguage('en', { persist: false });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
});
afterEach(async () => {
  cleanup();
  await Promise.resolve();
  vi.restoreAllMocks();
});

it.each(['audio', 'video'] as const)(
  'uses native %s controls and releases playback when hidden or closed',
  async kind => {
    const url = 'file:///C:/media/%E5%A3%B0%E9%9F%B3%20%23100%25.webm';
    const { rerender, unmount } = render(<MediaFilePreview url={url} kind={kind} isVisible />);
    const media = document.querySelector(kind) as HTMLMediaElement;
    expect(media.getAttribute('src')).toBe(
      'localmedia://local/C:/media/%E5%A3%B0%E9%9F%B3%20%23100%25.webm',
    );
    expect(media.controls).toBe(true);
    expect(media.autoplay).toBe(false);
    expect(media.preload).toBe('metadata');
    rerender(<MediaFilePreview url={url} kind={kind} isVisible={false} />);
    expect(document.querySelector(kind)).toBe(media);
    expect(media.pause).toHaveBeenCalledOnce();
    await act(async () => unmount());
    expect(media.getAttribute('src')).toBeNull();
    expect(media.load).toHaveBeenCalledOnce();
  },
);

it('retains the media source across StrictMode effect cleanup', async () => {
  render(
    <StrictMode>
      <MediaFilePreview url="file:///C:/media/sound.mp3" kind="audio" isVisible />
    </StrictMode>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(document.querySelector('audio')?.getAttribute('src')).toBe(
    'localmedia://local/C:/media/sound.mp3',
  );
  expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled();
});

it('keeps unsupported codecs recoverable and retries only on a user click', () => {
  render(<MediaFilePreview url="file:///C:/media/movie.mov" kind="video" isVisible />);
  const media = document.querySelector('video')!;
  fireEvent.error(media);
  expect(screen.getByRole('alert').textContent).toContain('unsupported codec');
  expect(document.querySelector('video')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: i18nService.t('messageMediaRetry') }));
  expect(document.querySelector('video')).not.toBe(media);
  expect(document.querySelector('video')?.getAttribute('src')).toBe(
    'localmedia://local/C:/media/movie.mov',
  );
});

it('preserves UNC host and escaped path characters without admitting other protocols', () => {
  expect(localMediaPreviewUrl('file://server/share/a%20%23.wav')).toBe(
    'localmedia://local//server/share/a%20%23.wav',
  );
  expect(localMediaPreviewUrl('javascript:alert(1)')).toBeNull();
  expect(localMediaPreviewUrl('https://example.com/movie.webm')).toBeNull();
});
