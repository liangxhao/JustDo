// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

import {
  installNativeWidgetMessaging,
  NATIVE_WIDGET_OWNER_MESSENGER,
  postNativeWidgetMessage,
} from './messaging';

const origin = 'http://127.0.0.1:18790';
const message = { type: 'openclaw:widget-chat-host' };

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function mountFrame() {
  const widget = document.createElement('justdo-native-widget');
  const frame = document.createElement('iframe');
  frame.src = `${origin}/mcp-app-sandbox`;
  widget.attachShadow({ mode: 'open' }).append(frame);
  document.body.append(widget);
  return { widget, frame };
}

it('sends only admitted messages to the connected native sandbox with its exact origin', () => {
  const { widget, frame } = mountFrame();
  const post = vi.spyOn(frame.contentWindow!, 'postMessage');
  expect(postNativeWidgetMessage(frame, message, origin)).toBe(true);
  for (const type of ['openclaw:widget-theme', 'openclaw:scenario-draft-policy'])
    expect(postNativeWidgetMessage(frame, { type }, origin)).toBe(true);
  expect(
    postNativeWidgetMessage(frame, { method: 'ui/notifications/sandbox-resource-ready' }, origin),
  ).toBe(true);
  post.mockClear();
  for (const rejected of [
    null,
    'text',
    { type: 'tools/call' },
    { method: 'tools/call' },
    { type: message.type, method: 'chat.send' },
  ])
    expect(postNativeWidgetMessage(frame, rejected, origin)).toBe(false);
  expect(postNativeWidgetMessage(frame, message, '*')).toBe(false);
  expect(postNativeWidgetMessage(frame, message, 'https://evil.test')).toBe(false);
  expect(post).not.toHaveBeenCalled();
  frame.src = `${origin}/other`;
  expect(postNativeWidgetMessage(frame, message, origin)).toBe(false);
  frame.src = `${origin}/mcp-app-sandbox`;
  document.body.append(frame);
  expect(postNativeWidgetMessage(frame, message, origin)).toBe(false);
  widget.shadowRoot!.append(frame);
  widget.remove();
  expect(postNativeWidgetMessage(frame, message, origin)).toBe(false);
});

it('uses the workspace sender and fails closed when that sender is absent or revoked', () => {
  const workspace = document.createElement('iframe');
  document.body.append(workspace);
  const owner = workspace.contentWindow!;
  const { widget, frame } = mountFrame();
  workspace.contentDocument!.body.append(widget);
  const direct = vi.spyOn(frame.contentWindow!, 'postMessage');
  expect(postNativeWidgetMessage(frame, message, origin)).toBe(false);
  expect(direct).not.toHaveBeenCalled();
  const send = vi.fn().mockReturnValue(true);
  Object.defineProperty(owner, NATIVE_WIDGET_OWNER_MESSENGER, { value: send, configurable: true });
  expect(postNativeWidgetMessage(frame, message, origin)).toBe(true);
  expect(send).toHaveBeenCalledWith(frame, message, origin);
  expect(direct).not.toHaveBeenCalled();
  send.mockReturnValue(false);
  expect(postNativeWidgetMessage(frame, message, origin)).toBe(false);
  send.mockImplementation(() => {
    throw new Error('closed workspace');
  });
  expect(postNativeWidgetMessage(frame, message, origin)).toBe(false);
});

it('installs a read-only current-realm sender that cannot send a frame owned by another document', () => {
  installNativeWidgetMessaging();
  const descriptor = Object.getOwnPropertyDescriptor(window, NATIVE_WIDGET_OWNER_MESSENGER)!;
  expect(descriptor).toMatchObject({ writable: false, configurable: false });
  const { frame } = mountFrame();
  const post = vi.spyOn(frame.contentWindow!, 'postMessage');
  expect(descriptor.value(frame, message, origin)).toBe(true);
  expect(post).toHaveBeenCalledOnce();
  const workspace = document.createElement('iframe');
  document.body.append(workspace);
  workspace.contentDocument!.body.append(frame);
  expect(descriptor.value(frame, message, origin)).toBe(false);
});
