import { describe, expect, it, vi } from 'vitest';

import {
  canClearSubmittedDraft,
  createSessionSubmission,
  stopSessionSubmission,
} from './sessionSubmission';

describe('session submission cancellation', () => {
  it('keeps cancellation pending until late admission is settled and aborted again', async () => {
    const operation = createSessionSubmission();
    const stop = vi.fn().mockResolvedValue(true);
    let completed = false;
    const stopping = stopSessionSubmission(operation, stop).then(result => {
      completed = true;
      return result;
    });
    await Promise.resolve();
    expect(operation.cancelled).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(completed).toBe(false);
    operation.finish();
    expect(await stopping).toBe(true);
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('does not claim cancellation when admission acknowledgement was lost', async () => {
    const operation = createSessionSubmission();
    operation.unknown = true;
    operation.finish();
    expect(await stopSessionSubmission(operation, vi.fn().mockResolvedValue(true))).toBe(false);
  });

  it('reports failure if the late admitted operation cannot be stopped', async () => {
    const operation = createSessionSubmission();
    operation.finish();
    const stop = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await stopSessionSubmission(operation, stop)).toBe(false);
  });

  it('does not add a second broad abort when there is no admission in flight', async () => {
    const stop = vi.fn().mockResolvedValue(true);
    expect(await stopSessionSubmission(undefined, stop)).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe('submitted draft cleanup', () => {
  const attachments: string[] = [];
  const original = {
    submittedText: 'sent',
    submittedAttachments: attachments,
    sourceText: 'sent',
    sourceAttachments: attachments,
    visible: false,
    visibleText: 'new session draft',
    visibleAttachments: [] as string[],
  };
  it.each(['home promoted to a persisted session', 'A switched to B'])(
    'clears the unchanged source after %s without clearing visible input',
    () => {
      expect(canClearSubmittedDraft(original)).toBe(true);
    },
  );
  it('preserves a source edited while admission was pending', () => {
    expect(canClearSubmittedDraft({ ...original, sourceText: 'new draft' })).toBe(false);
  });
  it('preserves visible edits before they reach persisted draft state', () => {
    expect(canClearSubmittedDraft({ ...original, visible: true })).toBe(false);
  });
  it('preserves attachments added after submission', () => {
    expect(canClearSubmittedDraft({ ...original, sourceAttachments: ['new'] })).toBe(false);
  });
});

it('keeps admission locked while the final cancellation acknowledgement is pending', async () => {
  const operation = createSessionSubmission();
  let finishAbort!: (result: boolean) => void;
  const stop = vi
    .fn()
    .mockResolvedValueOnce(true)
    .mockImplementationOnce(
      () =>
        new Promise<boolean>(resolve => {
          finishAbort = resolve;
        }),
    );
  const stopping = stopSessionSubmission(operation, stop);
  operation.finish();
  await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(2));
  expect(operation.stopping).toBe(true);
  finishAbort(true);
  expect(await stopping).toBe(true);
  expect(operation.stopping).toBe(false);
});

it('still cancels late admission after the first abort request throws', async () => {
  const operation = createSessionSubmission();
  operation.finish();
  const stop = vi
    .fn()
    .mockRejectedValueOnce(new Error('lost connection'))
    .mockResolvedValueOnce(true);
  expect(await stopSessionSubmission(operation, stop)).toBe(true);
  expect(stop).toHaveBeenCalledTimes(2);
});
