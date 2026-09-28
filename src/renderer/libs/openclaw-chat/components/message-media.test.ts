// @vitest-environment jsdom
import { expect, test, vi } from 'vitest';

import { MessageMedia } from './message-media';

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
