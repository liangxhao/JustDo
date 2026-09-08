/** Admission and cancellation share a session-scoped operation until both settle. */
export const createSessionSubmission = () => {
  let finish!: () => void;
  const settled = new Promise<void>(resolve => {
    finish = resolve;
  });
  return {
    cancelled: false,
    stopping: false,
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
  operation.stopping = true;
  try {
    await stop().catch(() => false);
    // An ACK may arrive after the first abort. Keep new submissions blocked until
    // admission settles and cancel again against the now-admitted operation.
    await operation.settled;
    const finallyStopped = await stop();
    return finallyStopped && !operation.unknown;
  } finally {
    operation.stopping = false;
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
