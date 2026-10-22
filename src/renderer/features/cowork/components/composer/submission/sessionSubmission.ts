/** Admission and cancellation share a session-scoped operation until both settle. */
export const createSessionSubmission = () => {
  let finish!: () => void;
  const settled = new Promise<void>(resolve => {
    finish = resolve;
  });
  return {
    cancelled: false,
    stopping: false,
    stopCompletion: undefined as Promise<boolean> | undefined,
    stopAttempt: undefined as Promise<boolean> | undefined,
    unknown: false,
    unknownMarked: false,
    receiptId: undefined as string | undefined,
    sessionKey: undefined as string | undefined,
    runId: undefined as string | undefined,
    settled,
    finish,
  };
};
export type SessionSubmission = ReturnType<typeof createSessionSubmission>;

/** Preserve canonical identity before receipt persistence can yield or fail. */
export const bindSessionSubmissionRun = async (
  operation: SessionSubmission,
  runId: string,
  persist: () => Promise<unknown>,
): Promise<void> => {
  operation.runId = runId;
  await persist();
};

export const SESSION_STOP_WAIT_MS = 30_000;

export const getSessionStopOperationKey = (
  sessionId: string,
  pendingStart: { temporarySessionId?: string; canonicalSessionId?: string } | null,
): string =>
  pendingStart?.temporarySessionId &&
  (sessionId === pendingStart.temporarySessionId || sessionId === pendingStart.canonicalSessionId)
    ? pendingStart.temporarySessionId
    : sessionId;

export const stopSessionSubmission = async (
  operation: SessionSubmission | undefined,
  stop: () => Promise<boolean>,
): Promise<boolean> => {
  if (!operation) return stop();
  operation.cancelled = true;
  const requestStop = (): Promise<boolean> => {
    if (operation.stopAttempt) return operation.stopAttempt;
    const attempt = Promise.resolve()
      .then(stop)
      .catch(() => false)
      .finally(() => {
        if (operation.stopAttempt === attempt) operation.stopAttempt = undefined;
      });
    operation.stopAttempt = attempt;
    return attempt;
  };
  if (!operation.stopCompletion) {
    operation.stopping = true;
    operation.stopCompletion = (async () => {
      try {
        await requestStop();
        // Keep admission fenced even when the UI stops waiting. A late ACK must
        // still be cancelled before another submission can use this session.
        await operation.settled;
        // An explicit retry may still be cancelling pre-admission work. Wait
        // for it before issuing the required post-admission cancellation.
        await operation.stopAttempt;
        const finallyStopped = await requestStop();
        return finallyStopped && !operation.unknown;
      } finally {
        operation.stopping = false;
        operation.stopCompletion = undefined;
      }
    })();
  } else {
    // A timed-out UI wait must allow a real cancellation retry, while sharing
    // any RPC that has not returned yet.
    void requestStop();
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.stopCompletion,
      new Promise<boolean>(resolve => {
        timeout = setTimeout(() => resolve(false), SESSION_STOP_WAIT_MS);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
};

/** Compare the source draft even after navigation or home-session promotion. */
export const canClearSubmittedDraft = <T>(input: {
  submittedText: string;
  submittedAttachments: T;
  sourceText: string;
  sourceAttachments: T;
  visible: boolean;
  visibleText: string;
  visibleAttachments: T;
}): boolean =>
  input.sourceText === input.submittedText &&
  input.sourceAttachments === input.submittedAttachments &&
  (!input.visible ||
    (input.visibleText === input.submittedText &&
      input.visibleAttachments === input.submittedAttachments));
