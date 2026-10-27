// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';

import { MessageMedia } from './message-media';

afterEach(async () => {
  document.body.replaceChildren();
  await Promise.resolve();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const source =
  '/api/chat/media/outgoing/agent%3Amain%3Asession/11111111-1111-4111-8111-111111111111/full';

test('plays through the workspace-only bridge without exposing the application bridge', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  const prepareAssistantMediaPlayback = vi
    .fn()
    .mockResolvedValue({ success: true, url: 'localmedia://gateway/workspace' });
  const releaseAssistantMediaPlayback = vi.fn().mockResolvedValue({ success: true });
  vi.stubGlobal('electron', undefined);
  vi.stubGlobal('mediaPlayback', { prepareAssistantMediaPlayback, releaseAssistantMediaPlayback });
  const reader = new MessageMedia();
  reader.src = source;
  reader.sessionKey = 'agent:main:session';
  document.body.append(reader);
  await vi.waitFor(() =>
    expect(reader.querySelector('audio')?.getAttribute('src')).toBe(
      'localmedia://gateway/workspace',
    ),
  );
  expect(window.electron).toBeUndefined();
  reader.remove();
  await Promise.resolve();
  expect(releaseAssistantMediaPlayback).toHaveBeenCalledWith({
    url: 'localmedia://gateway/workspace',
  });
});

test.each(['src', 'sessionKey', 'kind'] as const)(
  'stops the previous native player when %s changes',
  async field => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    const prepareAssistantMediaPlayback = vi
      .fn()
      .mockResolvedValueOnce({ success: true, url: 'localmedia://gateway/previous' })
      .mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal('mediaPlayback', {
      prepareAssistantMediaPlayback,
      releaseAssistantMediaPlayback: vi.fn().mockResolvedValue({ success: true }),
    });
    const reader = new MessageMedia();
    reader.src = source;
    reader.sessionKey = 'agent:main:session';
    document.body.append(reader);
    await vi.waitFor(() =>
      expect(reader.querySelector('audio')?.getAttribute('src')).toBe(
        'localmedia://gateway/previous',
      ),
    );
    const previous = reader.querySelector('audio')!;
    pause.mockClear();
    load.mockClear();
    if (field === 'src') reader.src = source.replace('11111111-1111', '22222222-2222');
    else if (field === 'sessionKey') reader.sessionKey = 'agent:main:other';
    else reader.kind = 'video';
    await reader.updateComplete;
    expect(previous.getAttribute('src')).toBeNull();
    expect(pause.mock.contexts).toContain(previous);
    expect(load.mock.contexts).toContain(previous);
    expect(previous.isConnected).toBe(false);
  },
);

test('uses a session-bound playback grant, preserves it across moves, and releases on removal', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  const prepareAssistantMediaPlayback = vi
    .fn()
    .mockResolvedValue({ success: true, url: 'localmedia://gateway/one' });
  const releaseAssistantMediaPlayback = vi.fn().mockResolvedValue({ success: true });
  vi.stubGlobal('electron', {
    openclaw: { engine: { prepareAssistantMediaPlayback, releaseAssistantMediaPlayback } },
  });
  const reader = new MessageMedia();
  reader.src = source;
  reader.label = 'voice.wav';
  reader.sessionKey = 'agent:main:session';
  document.body.append(reader);
  await vi.waitFor(() =>
    expect(reader.querySelector('audio')?.getAttribute('src')).toBe('localmedia://gateway/one'),
  );
  expect(prepareAssistantMediaPlayback).toHaveBeenCalledWith({
    source,
    sessionKey: 'agent:main:session',
    kind: 'audio',
  });
  expect(reader.querySelector('audio')?.autoplay).toBe(false);
  reader.remove();
  document.body.append(reader);
  await reader.updateComplete;
  expect(releaseAssistantMediaPlayback).not.toHaveBeenCalled();
  reader.remove();
  await Promise.resolve();
  await reader.updateComplete;
  expect(releaseAssistantMediaPlayback).toHaveBeenCalledWith({ url: 'localmedia://gateway/one' });
  expect(prepareAssistantMediaPlayback).toHaveBeenCalledTimes(1);
});

test('releases a late grant after changing source and rejects a mismatched session', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  let finish!: (result: { success: true; url: string }) => void;
  const prepareAssistantMediaPlayback = vi.fn(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const releaseAssistantMediaPlayback = vi.fn().mockResolvedValue({ success: true });
  vi.stubGlobal('electron', {
    openclaw: { engine: { prepareAssistantMediaPlayback, releaseAssistantMediaPlayback } },
  });
  const reader = new MessageMedia();
  reader.src = source;
  reader.sessionKey = 'agent:main:session';
  document.body.append(reader);
  await reader.updateComplete;
  reader.src = 'data:audio/wav;base64,YQ==';
  await reader.updateComplete;
  finish({ success: true, url: 'localmedia://gateway/late' });
  await vi.waitFor(() =>
    expect(releaseAssistantMediaPlayback).toHaveBeenCalledWith({
      url: 'localmedia://gateway/late',
    }),
  );
  expect(reader.querySelector('audio')?.getAttribute('src')).toBe(reader.src);
  reader.sessionKey = 'agent:main:other';
  reader.src = source;
  await reader.updateComplete;
  expect(prepareAssistantMediaPlayback).toHaveBeenCalledTimes(1);
  expect(reader.querySelector('audio')).toBeNull();
  expect(reader.querySelector('[role="status"]')).not.toBeNull();
});

test('plays only on demand, reports failure, and resets for a different source', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  const reader = new MessageMedia();
  reader.kind = 'video';
  reader.src = 'localfile:///E:/example.mp4';
  reader.label = 'example.mp4';
  document.body.append(reader);
  await reader.updateComplete;
  const video = reader.querySelector('video')!;
  expect(video.controls).toBe(true);
  expect(video.autoplay).toBe(false);
  video.dispatchEvent(new Event('error'));
  await reader.updateComplete;
  expect(reader.querySelector('[role="status"]')).not.toBeNull();
  reader.src = 'localfile:///E:/other.mp4';
  await reader.updateComplete;
  expect(reader.querySelector('video')?.src).toContain('other.mp4');
  reader.remove();
  await Promise.resolve();
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  vi.restoreAllMocks();
});
