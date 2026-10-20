// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';

import { McpAppIcon } from './McpAppIcon';

afterEach(cleanup);

const inline = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E';

test('renders plugin-provided inline icons with separate theme variants', () => {
  const dark = 'data:image/png;base64,aWNvbg==';
  const { container } = render(
    <McpAppIcon
      label="Editor"
      icons={[
        { src: inline, theme: 'light' },
        { src: dark, theme: 'dark' },
      ]}
    />,
  );
  const images = [...container.querySelectorAll('img')];
  expect(images.map(image => image.getAttribute('src'))).toEqual([inline, dark]);
  expect(images[0].parentElement?.className).toContain('dark:hidden');
  expect(images[1].parentElement?.className).toContain('dark:inline-flex');
});

test('uses distinct name fallbacks without fetching remote or local file icons', () => {
  const { container, rerender } = render(
    <McpAppIcon
      label="Reports"
      icons={[
        { src: 'https://public.example/icon.svg' },
        { src: 'file:///secret.png' },
        { src: 'javascript:alert(1)' },
      ]}
    />,
  );
  expect(container.querySelector('img')).toBeNull();
  expect(container.textContent).toContain('RE');
  rerender(<McpAppIcon label="Calendar" />);
  expect(container.textContent).toContain('CA');
});

test('falls back when an icon fails and accepts a later replacement', () => {
  const { container, rerender } = render(<McpAppIcon label="Diagram" icons={[{ src: inline }]} />);
  fireEvent.error(container.querySelector('img')!);
  expect(container.querySelector('img')).toBeNull();
  expect(container.textContent).toContain('DI');
  const replacement = 'data:image/webp;base64,aWNvbg==';
  rerender(<McpAppIcon label="Diagram" icons={[{ src: replacement }]} />);
  expect(container.querySelector('img')?.getAttribute('src')).toBe(replacement);
});
