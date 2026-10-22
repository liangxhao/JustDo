import type { CoworkSession } from '../../data/coworkStore';

type GatewayRequest = <T>(method: string, params?: unknown) => Promise<T>;

/** Single and batch deletion share the same exact native binding and ACK recovery. */
export async function deleteBoundNativeSession(
  session: Pick<CoworkSession, 'nativeSessionKey' | 'historyBinding'>,
  requestGateway?: GatewayRequest,
): Promise<void> {
  if (!session.nativeSessionKey) return;
  if (!requestGateway) throw new Error('Gateway is unavailable for native session deletion.');
  let worktreePreserved = false;
  try {
    const deleted = await requestGateway<{ worktreePreserved?: unknown }>('sessions.delete', {
      key: session.nativeSessionKey,
      ...(session.historyBinding
        ? { expectedSessionId: session.historyBinding.nativeSessionId }
        : {}),
      deleteTranscript: true,
    });
    worktreePreserved = !!deleted.worktreePreserved;
  } catch (error) {
    const described = await requestGateway<{ session?: unknown }>('sessions.describe', {
      key: session.nativeSessionKey,
    });
    // A failed/unknown delete is successful only after an explicit absence receipt.
    if (described.session !== null) throw error;
  }
  if (worktreePreserved)
    throw new Error(
      'The session was removed but its worktree was preserved. Inspect it in Settings → Worktrees.',
    );
}
