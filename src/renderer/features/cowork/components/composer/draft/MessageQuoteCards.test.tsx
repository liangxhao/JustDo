// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  labels: { exampleReference: 'Example reference' } as Record<string, string>,
}));
vi.mock('@/services/i18n', () => ({
  i18nService: {
    t: (key: string) =>
      fixture.labels[key] ??
      (
        { messageQuoteLabel: 'Quote', messageQuoteRemove: 'Remove quote' } as Record<string, string>
      )[key] ??
      key,
  },
}));

import type { MessageQuote } from './messageQuote';
import MessageQuoteCards from './MessageQuoteCards';

afterEach(cleanup);

it('uses a contributed quote label and falls back when its dictionary is no longer installed', () => {
  const quotes: MessageQuote[] = [
    {
      kind: 'extension',
      pluginId: 'example',
      labelKey: 'exampleReference',
      id: 'quote',
      text: 'The selected conclusion',
      context: 'Historical locator',
    },
  ];
  const remove = vi.fn();
  const view = render(<MessageQuoteCards quotes={quotes} onRemove={remove} />);
  expect(screen.getByText('Example reference')).toBeTruthy();
  expect(screen.getByText('The selected conclusion')).toBeTruthy();
  delete fixture.labels.exampleReference;
  view.rerender(<MessageQuoteCards quotes={quotes} onRemove={remove} />);
  expect(screen.getByText('Quote')).toBeTruthy();
  expect(screen.queryByText('exampleReference')).toBeNull();
  expect(screen.getByText('The selected conclusion')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Remove quote' }));
  expect(remove).toHaveBeenCalledExactlyOnceWith('quote');
});
