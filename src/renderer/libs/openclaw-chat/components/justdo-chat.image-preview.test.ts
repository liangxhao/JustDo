/** @vitest-environment jsdom */

import './justdo-chat';

import { afterEach, describe, expect, test, vi } from 'vitest';

import type { JustDoChatElement } from './justdo-chat';

afterEach(() => {
  document.body.replaceChildren();
  Reflect.deleteProperty(window, 'electron');
});

describe('justdo-chat image preview', () => {
  test('opens a separate preview window when a message image is double-clicked', async () => {
    const open = vi.fn().mockResolvedValue({ success: true });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: { imagePreview: { open } },
    });
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    document.body.append(chat);
    await chat.updateComplete;

    const thumbnail = document.createElement('img');
    thumbnail.className = 'chat-bubble__image';
    thumbnail.src = 'data:image/png;base64,AA==';
    thumbnail.alt = 'detail';
    chat.shadowRoot?.append(thumbnail);

    thumbnail.dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true, cancelable: true, composed: true }),
    );
    await Promise.resolve();

    expect(open).toHaveBeenCalledWith({
      src: 'data:image/png;base64,AA==',
      alt: 'detail',
    });
    expect(chat.shadowRoot?.querySelector('.image-preview')).toBeNull();
  });
});
