// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import { QueuedInputCards } from './QueuedInputCards';

afterEach(cleanup);

test('renders ordered compact rows, attachment fallback and withdrawal without sending', async () => {
  let finish!: () => void;
  const withdraw = vi.fn(
    () =>
      new Promise<void>(resolve => {
        finish = resolve;
      }),
  );
  const { rerender } = render(
    <QueuedInputCards
      items={[
        { id: 'one', text: 'First queued message', canWithdraw: true },
        { id: 'two', text: '', canWithdraw: false },
      ]}
      onWithdraw={withdraw}
    />,
  );
  expect(screen.getAllByRole('listitem')).toHaveLength(2);
  expect(screen.getByText('First queued message').className).toContain('truncate');
  expect(screen.getByText(i18nService.t('coworkQueuedAttachment'))).toBeTruthy();
  const button = screen.getByRole('button', {
    name: i18nService.t('coworkQueueWithdraw'),
  }) as HTMLButtonElement;
  fireEvent.click(button);
  expect(withdraw).toHaveBeenCalledWith('one');
  expect(button.disabled).toBe(true);
  finish();
  await waitFor(() => expect(button.disabled).toBe(false));
  rerender(<QueuedInputCards items={[]} onWithdraw={withdraw} />);
  expect(screen.queryByRole('region')).toBeNull();
});

test('keeps the row and reports a failed withdrawal', async () => {
  const toast = vi.fn();
  window.addEventListener('app:showToast', toast);
  render(
    <QueuedInputCards
      items={[{ id: 'one', text: 'Keep this', canWithdraw: true }]}
      onWithdraw={async () => {
        throw new Error('Already consumed');
      }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: i18nService.t('coworkQueueWithdraw') }));
  await waitFor(() => expect(toast).toHaveBeenCalledOnce());
  expect(screen.getByText('Keep this')).toBeTruthy();
  window.removeEventListener('app:showToast', toast);
});

test('opens full multiline text and attachment information without sending or withdrawing', () => {
  const withdraw = vi.fn();
  const fullText = `${'Long message '.repeat(40)}\nSecond paragraph <script>literal</script>`;
  const getDetail = vi.fn(() => ({
    message: { role: 'user', content: fullText, __openclaw: { media: [{ path: '/tmp/requirements.pdf', fileName: 'requirements.pdf', contentType: 'application/pdf' }] } }, truncated: false,
  }));
  const { rerender } = render(<QueuedInputCards
    items={[{ id: 'one', text: 'Summary', canWithdraw: true }]}
    onWithdraw={withdraw} getDetail={getDetail}
  />);
  expect(getDetail).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: i18nService.t('coworkQueueView') }));
  const region = screen.getByRole('region', { name: i18nService.t('coworkQueueView') });
  const shadow = region.querySelector('[data-queued-message] [data-user-message]')!.shadowRoot!;
  expect(shadow.querySelector('.chat-group')?.textContent).toContain('Long message '.repeat(40).trim());
  expect(shadow.querySelector('script')).toBeNull();
  expect(shadow.querySelector('.chat-group')?.textContent).toContain('requirements.pdf');
  expect(withdraw).not.toHaveBeenCalled();
  fireEvent.keyDown(region, { key: 'Escape' });
  expect(screen.queryByRole('region', { name: i18nService.t('coworkQueueView') })).toBeNull();
  fireEvent.click(screen.getByText('Summary'));
  rerender(<QueuedInputCards items={[]} onWithdraw={withdraw} getDetail={getDetail} />);
  expect(screen.queryByText('requirements.pdf')).toBeNull();
});

test('labels incomplete and unavailable details without presenting them as complete', () => {
  const props = { items: [{ id: 'one', text: 'Summary', canWithdraw: true }], onWithdraw: vi.fn() };
  const { rerender } = render(<QueuedInputCards {...props} getDetail={() => ({ message: { role: 'user', content: 'Partial' }, truncated: true })} />);
  fireEvent.click(screen.getByText('Summary'));
  expect(screen.getByText(i18nService.t('coworkQueueDetailTruncated'))).toBeTruthy();
  rerender(<QueuedInputCards {...props} getDetail={() => null} />);
  expect(screen.getByText(i18nService.t('coworkQueueDetailUnavailable'))).toBeTruthy();
  expect(screen.queryByText('Partial')).toBeNull();
});
