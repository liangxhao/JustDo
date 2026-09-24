// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';

import PluginMarkdownDescription from './PluginMarkdownDescription';

afterEach(cleanup);

test('renders plugin descriptions as sanitized Markdown', () => {
  const { container } = render(
    <PluginMarkdownDescription content={'**Useful** plugin\n\n- first\n- second\n\n<script>alert(1)</script>'} />,
  );

  expect(screen.getByText('Useful').tagName).toBe('STRONG');
  expect(screen.getByText('first').tagName).toBe('LI');
  expect(container.querySelector('script')).toBeNull();
});
