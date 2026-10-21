// @vitest-environment jsdom
import { expect, test, vi } from 'vitest';

import { RichMessageControls } from './rich-message-controls';

test('keeps selection actions inside a smaller workspace document', () => {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  const child = frame.contentDocument!;
  const realm = frame.contentWindow! as Window & typeof globalThis;
  Object.defineProperties(realm, {
    innerWidth: { configurable: true, value: 500 },
    innerHeight: { configurable: true, value: 300 },
  });
  Object.defineProperties(realm.HTMLElement.prototype, {
    offsetWidth: { configurable: true, get: () => 180 },
    offsetHeight: { configurable: true, get: () => 80 },
  });
  const root = child.createElement('div');
  root.innerHTML =
    '<div data-assistant-entry="entry"><div class="chat-bubble__text">quoted text</div></div>';
  child.body.append(root);
  const controls = new RichMessageControls(root, vi.fn());
  try {
    controls.reset('session');
    controls.onQuote = vi.fn();
    const range = child.createRange();
    const text = root.querySelector('.chat-bubble__text')!;
    range.selectNodeContents(text);
    realm.getSelection()!.addRange(range);
    text.dispatchEvent(
      new realm.MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 450,
        clientY: 270,
      }),
    );
    const menu = root.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu).not.toBeNull();
    expect(parseFloat(menu.style.left) + menu.offsetWidth).toBeLessThanOrEqual(492);
    expect(parseFloat(menu.style.top) + menu.offsetHeight).toBeLessThanOrEqual(292);
  } finally {
    controls.dispose();
    frame.remove();
  }
});
