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

  it('waits for a closed sender cleanup before returning failure to the composer', async () => {
    let release!: () => void;
    let cleaned = false;
    const pending = submitCoworkMessage(
      async () => {
        throw new Error('pre-send');
      },
      async () => {
        await new Promise<void>(resolve => {
          release = resolve;
        });
        cleaned = true;
      },
    );
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(cleaned).toBe(false);
    release();
    await expect(pending).resolves.toBe(false);
    expect(cleaned).toBe(true);
  });
});
