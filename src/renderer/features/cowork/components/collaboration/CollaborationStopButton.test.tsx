// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import CollaborationStopButton from './CollaborationStopButton';

afterEach(cleanup);
describe('collaboration Stop admission', () => {
  it('prevents duplicate requests while cancellation is pending', async () => {
    let finish!: (value: { success: true; value: undefined }) => void;
    const stop = vi.fn(
      () => new Promise<{ success: true; value: undefined }>(resolve => (finish = resolve)),
    );
    render(<CollaborationStopButton label="Stop" stop={stop} />);
    const button = screen.getByRole('button', { name: 'Stop' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
    await act(async () => finish({ success: true, value: undefined }));
    expect(button.hasAttribute('disabled')).toBe(false);
  });

  it.each(['rejected', 'unconfirmed'] as const)(
    'reports %s cancellation and permits retry',
    async failure => {
      const stop = vi.fn(() =>
        failure === 'rejected'
          ? Promise.reject(new Error('private native failure'))
          : Promise.resolve({ success: false as const, error: 'private native failure' }),
      );
      const toast = vi.fn();
      window.addEventListener('app:showToast', toast);
      try {
        render(<CollaborationStopButton label="Stop" stop={stop} />);
        const button = screen.getByRole('button', { name: 'Stop' });
        fireEvent.click(button);
        await act(async () => {});
        expect(toast).toHaveBeenCalledWith(
          expect.objectContaining({
            detail: { message: i18nService.t('collaborationStopFailed'), tone: 'error' },
          }),
        );
        expect(button.hasAttribute('disabled')).toBe(false);
        fireEvent.click(button);
        await act(async () => {});
        expect(stop).toHaveBeenCalledTimes(2);
      } finally {
        window.removeEventListener('app:showToast', toast);
      }
    },
  );

  it('ignores late failure feedback after the selected detail is closed', async () => {
    let reject!: (error: Error) => void;
    const stop = () => new Promise<never>((_resolve, fail) => (reject = fail));
    const toast = vi.fn();
    window.addEventListener('app:showToast', toast);
    try {
      const view = render(<CollaborationStopButton label="Stop" stop={stop} />);
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      view.unmount();
      await act(async () => reject(new Error('late failure')));
      expect(toast).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('app:showToast', toast);
    }
  });
});
