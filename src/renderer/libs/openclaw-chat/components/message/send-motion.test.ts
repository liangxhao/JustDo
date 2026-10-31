/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { captureSendMotionOrigin, playSendMotion, registerSendMotion, sendMotionRef } from './send-motion';

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) });

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => window.setTimeout(() => callback(0), 16));
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => window.clearTimeout(id));
});

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup() {
  const source = document.createElement('textarea');
  const row = document.createElement('div');
  row.innerHTML = '<div><div class="chat-bubble--user" style="width: 75%; margin: 2px">hello</div><footer>time</footer></div>';
  document.body.append(source, row);
  const bubble = row.querySelector<HTMLElement>('.chat-bubble--user')!;
  const parent = bubble.parentElement!;
  vi.spyOn(source, 'getBoundingClientRect').mockReturnValue(rect(100, 600, 500, 40));
  vi.spyOn(bubble, 'getBoundingClientRect').mockReturnValue(rect(400, 200, 200, 40));
  vi.spyOn(parent, 'getBoundingClientRect').mockReturnValue(rect(100, 200, 500, 60));
  const cancel = vi.fn();
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const animate = vi.fn().mockReturnValue({ cancel, finished });
  Object.defineProperty(bubble, 'animate', { configurable: true, value: animate });
  return { source, row, bubble, parent, cancel, animate, finish };
}

test('binds one flight to the exact message object, preserving live content and restoring layout', async () => {
  const { source, row, bubble, parent, animate, finish } = setup();
  const message = { role: 'user', content: 'hello' };
  registerSendMotion(message, captureSendMotionOrigin(source));
  playSendMotion(row, { ...message });
  await vi.advanceTimersByTimeAsync(32);
  expect(animate).not.toHaveBeenCalled();
  sendMotionRef(message)(row);
  await vi.advanceTimersByTimeAsync(32);
  expect(animate).toHaveBeenCalledOnce();
  expect(animate.mock.calls[0][1]).toMatchObject({ duration: 520 });
  expect(animate.mock.calls[0][0][0].transform).toContain('400px');
  expect(bubble.style.position).toBe('fixed');
  expect(parent.style.minHeight).toBe('60px');
  expect(row.querySelectorAll('.chat-bubble--user')).toHaveLength(1);
  expect(sendMotionRef(message)).toBe(sendMotionRef(message));
  finish();
  await Promise.resolve();
  expect(bubble.style.position).toBe('');
  expect(bubble.style.width).toBe('75%');
  expect(bubble.style.margin).toBe('2px');
  expect(parent.style.minHeight).toBe('');
  playSendMotion(row, message);
  await vi.advanceTimersByTimeAsync(32);
  expect(animate).toHaveBeenCalledOnce();
});

test.each(['scroll', 'resize', 'ref-disconnect'])('settles immediately on %s without leaving fixed elements', async action => {
  const { source, row, bubble, parent, cancel } = setup();
  const message = {};
  registerSendMotion(message, captureSendMotionOrigin(source));
  playSendMotion(row, message);
  await vi.advanceTimersByTimeAsync(32);
  if (action === 'scroll') document.dispatchEvent(new Event('scroll'));
  else if (action === 'resize') window.dispatchEvent(new Event('resize'));
  else playSendMotion(undefined, message);
  expect(cancel).toHaveBeenCalledOnce();
  expect(bubble.style.position).toBe('');
  expect(parent.style.minHeight).toBe('');
});

test('unmount before deferred layout cancels animation and origin cannot replay', async () => {
  const { source, row, animate } = setup();
  const message = {};
  registerSendMotion(message, captureSendMotionOrigin(source));
  playSendMotion(row, message);
  playSendMotion(undefined, message);
  await vi.advanceTimersByTimeAsync(32);
  playSendMotion(row, message);
  await vi.advanceTimersByTimeAsync(32);
  expect(animate).not.toHaveBeenCalled();
});

test('capture ignores disconnected and invisible composers', () => {
  const source = document.createElement('textarea');
  expect(captureSendMotionOrigin(source)).toBeUndefined();
  document.body.append(source);
  expect(captureSendMotionOrigin(source)).toBeUndefined();
});

test('a message first revealed after the admission window does not fly from a stale composer', async () => {
  const { source, row, animate } = setup();
  const message = {};
  registerSendMotion(message, captureSendMotionOrigin(source));
  await vi.advanceTimersByTimeAsync(2_001);
  playSendMotion(row, message);
  await vi.advanceTimersByTimeAsync(32);
  expect(animate).not.toHaveBeenCalled();
});
