import type { SessionRunTiming } from '@shared/cowork/sessionRun';
import { describe, expect, it, vi } from 'vitest';

import {
  canClearSubmittedDraft,
  createSessionSubmission,
  hasAcceptedSubmissionSuccessor,
  SESSION_STOP_WAIT_MS,
  stopSessionSubmission,
} from './sessionSubmission';

describe('superseded unknown submission', () => {
  const previous: SessionRunTiming = {
    id: 'receipt-a', sessionId: 'session', clientTurnId: 'run-a', rootRunId: 'run-b',
    state: 'running', startedAt: 100, acceptedAt: 110,
  };
  const latest: SessionRunTiming = {
    ...previous, id: 'receipt-c', clientTurnId: 'recovered-run-c', rootRunId: 'run-c',
    startedAt: 120, acceptedAt: 125,
  };
  const pending = () => Object.assign(createSessionSubmission(), {
    receiptId: previous.id, runId: previous.clientTurnId, unknown: true, unknownMarked: true,
  });

  it('allows retiring an accepted input guard when Main has admitted a distinct later receipt', () => {
    const operation = pending();
    expect(hasAcceptedSubmissionSuccessor(operation, previous, latest)).toBe(true);
    expect(operation.unknown).toBe(true);
  });

  it('preserves the guard if the previous input or newer receipt is still unconfirmed', () => {
    const operation = pending();
    expect(hasAcceptedSubmissionSuccessor(operation, { ...previous, acceptedAt: undefined }, latest)).toBe(false);
    expect(hasAcceptedSubmissionSuccessor(operation, previous, { ...latest, acceptedAt: undefined })).toBe(false);
    expect(hasAcceptedSubmissionSuccessor(operation, previous, { ...latest, startedAt: previous.startedAt })).toBe(false);
  });

  it('preserves the older cancellation fence even with a later accepted receipt', () => {
    const operation = pending();
    operation.cancelled = true;
    expect(hasAcceptedSubmissionSuccessor(operation, previous, latest)).toBe(false);
  });
});

describe('session submission cancellation', () => {
  it('releases the stop control for hung admission while fencing and cancelling a late ACK', async () => {
    vi.useFakeTimers();
    try {
      const operation = createSessionSubmission();
      const stop = vi.fn().mockResolvedValue(true);
      const stopping = stopSessionSubmission(operation, stop);
      await vi.advanceTimersByTimeAsync(SESSION_STOP_WAIT_MS);
      expect(await stopping).toBe(false);
      expect(operation.cancelled).toBe(true);
      expect(operation.stopping).toBe(true);
      const completion = operation.stopCompletion;
      const retry = stopSessionSubmission(operation, stop);
      expect(stop).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(stop).toHaveBeenCalledTimes(2);
      operation.finish();
      expect(await completion).toBe(true);
      expect(await retry).toBe(true);
      expect(stop).toHaveBeenCalledTimes(3);
      expect(operation.stopping).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows retry after cancellation failure without an unhandled background rejection', async () => {
    const operation = createSessionSubmission();
    operation.finish();
    const stop = vi.fn().mockRejectedValue(new Error('disconnected'));
    expect(await stopSessionSubmission(operation, stop)).toBe(false);
    expect(operation.stopping).toBe(false);
    stop.mockResolvedValue(true);
    expect(await stopSessionSubmission(operation, stop)).toBe(true);
  });

  it('shares an unresolved cancellation request across retries and cancels again after admission', async () => {
    vi.useFakeTimers();
    try {
      const operation = createSessionSubmission();
      let finishAbort!: (value: boolean) => void;
      const stop = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<boolean>(resolve => {
              finishAbort = resolve;
            }),
        )
        .mockResolvedValue(true);
      const first = stopSessionSubmission(operation, stop);
      await vi.advanceTimersByTimeAsync(SESSION_STOP_WAIT_MS);
      expect(await first).toBe(false);
      const retry = stopSessionSubmission(operation, stop);
      operation.finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(operation.stopping).toBe(true);
      finishAbort(true);
      expect(await retry).toBe(true);
      expect(stop).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

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

  it('preserves a failed Stop result even for a distinct successor with known native custody', async () => {
    const operation = createSessionSubmission();
    operation.unknown = true;
    operation.runId = 'unknown-predecessor';
    operation.finish();
    const stop = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await stopSessionSubmission(operation, stop, { nativeTargetRunId: 'successor' })).toBe(false);
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
