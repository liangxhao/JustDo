import { describe, expect, it, vi } from 'vitest';

import { downgradePersistedFullPermissionMode } from './permissionStartupPolicy';

describe('permission startup policy', () => {
  it('downgrades persisted full access before Gateway startup', () => {
    const setConfig = vi.fn();
    const store = {
      getConfig: () => ({ permissionMode: 'full' }),
      setConfig,
    };

    expect(downgradePersistedFullPermissionMode(store as never)).toBe(true);
    expect(setConfig).toHaveBeenCalledWith({ permissionMode: 'ask' });
  });
});
