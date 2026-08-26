import os from 'os';
import { describe, expect, it, vi } from 'vitest';

import {
  lowerGatewayProcessPriority,
  restoreGatewayProcessPriority,
} from './gatewayProcessPriority';

describe('lowerGatewayProcessPriority', () => {
  it('moves a valid gateway process below foreground priority', () => {
    const setPriority = vi.fn();

    expect(lowerGatewayProcessPriority(1234, 'win32', setPriority)).toBe(true);
    expect(setPriority).toHaveBeenCalledWith(
      1234,
      os.constants.priority.PRIORITY_BELOW_NORMAL,
    );
  });

  it.each([undefined, null, 0, -1, 1.5])('ignores an invalid process id: %s', pid => {
    const setPriority = vi.fn();

    expect(lowerGatewayProcessPriority(pid, 'win32', setPriority)).toBe(false);
    expect(setPriority).not.toHaveBeenCalled();
  });

  it('does not change process priority outside Windows', () => {
    const setPriority = vi.fn();

    expect(lowerGatewayProcessPriority(1234, 'darwin', setPriority)).toBe(false);
    expect(setPriority).not.toHaveBeenCalled();
  });

  it('restores normal priority after startup', () => {
    const setPriority = vi.fn();

    expect(restoreGatewayProcessPriority(1234, 'win32', setPriority)).toBe(true);
    expect(setPriority).toHaveBeenCalledWith(1234, os.constants.priority.PRIORITY_NORMAL);
  });

  it('keeps startup running when the operating system rejects the priority change', () => {
    const setPriority = vi.fn(() => {
      throw new Error('access denied');
    });

    expect(lowerGatewayProcessPriority(1234, 'win32', setPriority)).toBe(false);
  });
});
