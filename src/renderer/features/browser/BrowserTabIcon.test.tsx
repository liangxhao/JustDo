// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';

import BrowserTabIcon from './BrowserTabIcon';

afterEach(cleanup);

it('falls back to a globe when icon decoding fails and accepts a later icon', () => {
  const faviconUrl = 'data:image/png;base64,aWNvbg==';
  const { container, rerender } = render(<BrowserTabIcon faviconUrl={faviconUrl} />);
  expect(container.querySelector('img')?.getAttribute('src')).toBe(faviconUrl);
  fireEvent.error(container.querySelector('img')!);
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('svg')).not.toBeNull();
  rerender(<BrowserTabIcon faviconUrl="data:image/png;base64,bmV3" />);
  expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,bmV3');
});

it.each([undefined, 'https://example.com/favicon.ico', 'file:///private/icon.png'])(
  'shows a globe without requesting an icon outside the browser session: %s',
  faviconUrl => {
    const { container } = render(<BrowserTabIcon faviconUrl={faviconUrl} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
  },
);
