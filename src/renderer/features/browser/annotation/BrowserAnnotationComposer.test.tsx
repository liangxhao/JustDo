// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import BrowserAnnotationComposer from './BrowserAnnotationComposer';

vi.mock('@/features/cowork/components/composer/LocalSpeechInputButton', () => ({
  LocalSpeechInputButton: ({ onTranscript }: { onTranscript: (text: string) => void }) => (
    <button type="button" aria-label="mock voice" onClick={() => onTranscript('voice comment')}>
      voice
    </button>
  ),
}));

const element = {
  tag: 'button',
  id: 'checkout',
  classes: ['primary'],
  role: 'button',
  name: 'Checkout',
  rect: { x: 12, y: 18, width: 120, height: 36 },
  focusable: true,
  cssPath: 'main > button#checkout',
  computedStyle: {
    color: 'rgb(255, 255, 255)',
    backgroundColor: 'rgb(0, 0, 0)',
    opacity: '1',
    fontFamily: 'sans-serif',
    fontSize: '14px',
    fontWeight: '600',
    lineHeight: '20px',
    display: 'block',
    position: 'static',
    zIndex: 'auto',
    borderRadius: '8px',
  },
};

describe('BrowserAnnotationComposer', () => {
  afterEach(cleanup);

  it('expands the selected HTML element and submits an editable comment', () => {
    i18nService.setLanguage('en', { persist: false });
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    render(
      <BrowserAnnotationComposer
        element={element}
        value="Make this clearer"
        disabled={false}
        position={{ left: 20, top: 64, width: 420 }}
        placement="below"
        anchorOffset={80}
        onChange={onChange}
        onSubmit={onSubmit}
        onDismiss={vi.fn()}
      />,
    );

    const details = screen.getByRole('button', { name: 'Expand HTML element details' });
    expect(screen.queryByText('button#checkout.primary')).toBeNull();
    expect(details.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(details);
    expect(details.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('main > button#checkout')).toBeTruthy();

    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Add a comment…' }), {
      key: 'Enter',
    });
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('appends voice transcription and keeps submit disabled for an empty comment', () => {
    i18nService.setLanguage('en', { persist: false });
    const onChange = vi.fn();
    render(
      <BrowserAnnotationComposer
        element={null}
        value=""
        disabled={false}
        position={{ left: 20, top: 64, width: 420 }}
        placement="above"
        anchorOffset={80}
        onChange={onChange}
        onSubmit={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(
      (
        screen.getByRole('button', {
          name: 'Add annotation and comment to chat',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'mock voice' }));
    expect(onChange).toHaveBeenCalledWith('voice comment');
  });
});
