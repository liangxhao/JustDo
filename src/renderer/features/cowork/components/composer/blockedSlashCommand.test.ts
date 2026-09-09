// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest';

import { rejectBlockedSlashCommand } from './blockedSlashCommand';

describe('rejectBlockedSlashCommand', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test.each(['/openclaw', '/openclaw: rescue', '/config set gateway.port 1234'])(
    'rejects %s before it reaches a submit callback',
    command => {
      const listener = vi.fn();
      window.addEventListener('app:showToast', listener);

      expect(rejectBlockedSlashCommand(command)).toBe(true);
      expect(listener).toHaveBeenCalledOnce();
      expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({
        title: 'Command unavailable',
        message: expect.stringContaining(command.split(/[\s:]/u)[0]),
        tone: 'warning',
        duration: 5000,
      });

      window.removeEventListener('app:showToast', listener);
    },
  );

  test.each(['/help', '/status', '/models'])('allows read-only command %s', command => {
    const listener = vi.fn();
    window.addEventListener('app:showToast', listener);

    expect(rejectBlockedSlashCommand(command)).toBe(false);
    expect(listener).not.toHaveBeenCalled();

    window.removeEventListener('app:showToast', listener);
  });
});
