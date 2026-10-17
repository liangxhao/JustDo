// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

import { forwardWidgetScroll } from './scroll';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it('uses the actual workspace window and crosses only its own shadow boundaries', () => {
  const workspace = document.createElement('iframe');
  document.body.append(workspace);
  const doc = workspace.contentDocument!;
  const owner = workspace.contentWindow! as Window & typeof globalThis;
  vi.spyOn(doc, 'visibilityState', 'get').mockReturnValue('visible');
  const chat = doc.createElement('justdo-chat');
  doc.body.append(chat);
  const root = chat.attachShadow({ mode: 'open' });
  const container = doc.createElement('section');
  root.append(container);
  const widget = doc.createElement('div');
  container.attachShadow({ mode: 'open' }).append(widget);
  const scrollBy = vi.fn();
  chat.scrollBy = scrollBy;
  const intent = vi.fn();
  chat.addEventListener('wheel', intent);
  forwardWidgetScroll(widget, 45);
  expect(intent.mock.calls[0][0]).toBeInstanceOf(owner.WheelEvent);
  expect(scrollBy).toHaveBeenCalledWith({ top: 45, behavior: 'instant' });
  document.body.append(widget);
  forwardWidgetScroll(widget, 100);
  expect(scrollBy).toHaveBeenCalledOnce();
});
