// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import { RunControlButton } from './RunControlButton';

afterEach(cleanup);

describe.each(['large', 'normal'] as const)('RunControlButton (%s)', size => {
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
