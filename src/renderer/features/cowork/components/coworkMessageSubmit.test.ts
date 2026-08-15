import { describe, expect, it, vi } from 'vitest';

import { submitCoworkMessage } from './coworkMessageSubmit';

describe('submitCoworkMessage', () => {
  it('returns true after the renderer chat send is accepted', async () => {
    await expect(submitCoworkMessage(vi.fn().mockResolvedValue(undefined), vi.fn())).resolves.toBe(
      true,
    );
  });

  it('returns false and reports a renderer chat send failure', async () => {
    const error = new Error('socket closed');
    const onFailure = vi.fn();

    await expect(submitCoworkMessage(vi.fn().mockRejectedValue(error), onFailure)).resolves.toBe(
      false,
    );
    expect(onFailure).toHaveBeenCalledWith(error);
  });
});
