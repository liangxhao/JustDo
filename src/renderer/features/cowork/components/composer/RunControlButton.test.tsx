// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import { RunControlButton } from './RunControlButton';

afterEach(cleanup);

describe.each(['large', 'normal'] as const)('RunControlButton (%s)', size => {
  it('switches the same control from stop to queue and back as draft availability changes', () => {
    const onSend = vi.fn();
    const onStop = vi.fn();
    const props = {
      isRunning: true,
      isStopping: false,
      canQueue: true,
      size,
      sendTitle: 'Enter',
      onSend,
      onStop,
    };
    const { rerender } = render(<RunControlButton {...props} canSubmit={false} />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: i18nService.t('coworkStopTask') })).toBeTruthy();
    rerender(<RunControlButton {...props} canSubmit />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: i18nService.t('coworkQueueMessage') }));
    expect(onSend).toHaveBeenCalledOnce();
    expect(onStop).not.toHaveBeenCalled();
    rerender(<RunControlButton {...props} canSubmit={false} />);
    fireEvent.click(screen.getByRole('button', { name: i18nService.t('coworkStopTask') }));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it('keeps the stop control when Goal mode disallows queueing even with a draft', () => {
    const onStop = vi.fn();
    const onSend = vi.fn();
    render(
      <RunControlButton
        isRunning
        isStopping={false}
        canSubmit
        canQueue={false}
        size={size}
        sendTitle="Enter"
        onStop={onStop}
        onSend={onSend}
      />,
    );
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: i18nService.t('coworkQueueMessage') })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: i18nService.t('coworkStopTask') }));
    expect(onStop).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('keeps stop enabled when editing and sending are blocked', () => {
    const onStop = vi.fn();
    const onSend = vi.fn();
    render(
      <RunControlButton
        isRunning
        isStopping={false}
        canSubmit={false}
        size={size}
        sendTitle="Enter"
        onStop={onStop}
        onSend={onSend}
      />,
    );

    const button = screen.getByRole('button', { name: i18nService.t('coworkStopTask') });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    expect(onStop).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('does not offer another send while stop is awaiting acknowledgement', () => {
    const onStop = vi.fn();
    const onSend = vi.fn();
    render(
      <RunControlButton
        isRunning={false}
        isStopping
        canSubmit
        size={size}
        sendTitle="Enter"
        onStop={onStop}
        onSend={onSend}
      />,
    );

    const button = screen.getByRole('button', { name: i18nService.t('coworkStopping') });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(button);
    expect(onStop).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('only sends when idle and the input can be submitted', () => {
    const onSend = vi.fn();
    const { rerender } = render(
      <RunControlButton
        isRunning={false}
        isStopping={false}
        canSubmit={false}
        size={size}
        sendTitle="Enter"
        onSend={onSend}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onSend).not.toHaveBeenCalled();

    rerender(
      <RunControlButton
        isRunning={false}
        isStopping={false}
        canSubmit
        size={size}
        sendTitle="Enter"
        onSend={onSend}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: i18nService.t('coworkSendMessage') }));
    expect(onSend).toHaveBeenCalledOnce();
  });
});
