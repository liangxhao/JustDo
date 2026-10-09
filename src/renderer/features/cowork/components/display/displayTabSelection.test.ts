import { describe, expect, it } from 'vitest';

import { getAdjacentDisplayTabId } from './displayTabSelection';

describe('getAdjacentDisplayTabId', () => {
  it('selects the tab to the right, then falls back to the left', () => {
    expect(getAdjacentDisplayTabId(['browser', 'terminal', 'plan'], 'terminal')).toBe('plan');
    expect(getAdjacentDisplayTabId(['browser', 'terminal'], 'terminal')).toBe('browser');
  });

  it('returns null after the final tab closes or the tab is unknown', () => {
    expect(getAdjacentDisplayTabId(['terminal'], 'terminal')).toBeNull();
    expect(getAdjacentDisplayTabId(['terminal'], 'missing')).toBeNull();
  });
});
