import os from 'os';
import { describe, expect, it, vi } from 'vitest';

import { ensureGatewayStartupPriority } from './gatewayProcessPriority';

describe('ensureGatewayStartupPriority', () => {
  it('keeps a valid gateway process at normal priority during startup', () => {
    const setPriority = vi.fn();

    expect(ensureGatewayStartupPriority(1234, 'win32', setPriority)).toBe(true);
    expect(setPriority).toHaveBeenCalledWith(
      1234,
      os.constants.priority.PRIORITY_NORMAL,
    );
  });

  it.each([undefined, null, 0, -1, 1.5])('ignores an invalid process id: %s', pid => {
    const setPriority = vi.fn();

    expect(ensureGatewayStartupPriority(pid, 'win32', setPriority)).toBe(false);
    expect(setPriority).not.toHaveBeenCalled();
  });

  it('does not change process priority outside Windows', () => {
    const setPriority = vi.fn();

    expect(ensureGatewayStartupPriority(1234, 'darwin', setPriority)).toBe(false);
    expect(setPriority).not.toHaveBeenCalled();
  });

  it('keeps startup running when the operating system rejects the priority change', () => {
    const setPriority = vi.fn(() => {
      throw new Error('access denied');
    });

    expect(ensureGatewayStartupPriority(1234, 'win32', setPriority)).toBe(false);
  });
});
