import type { CoworkSubagentConversationIdentity } from '../../../shared/cowork/subagentDetails';
import type { CoworkSession } from '../../data/coworkStore';

type GatewayRequest = <T>(method: string, params?: unknown) => Promise<T>;
type NativeSession = { key?: unknown; sessionId?: unknown; lifecycleRevision?: unknown; worktree?: unknown };

const describeNativeSession = async (requestGateway: GatewayRequest, key: string) =>
  (await requestGateway<{ session?: NativeSession | null }>('sessions.describe', { key })).session;

const assertDeletionIdentity = (
  native: NativeSession | null | undefined,
  expected: CoworkSubagentConversationIdentity,
): void => {
  if (native?.key !== expected.sessionKey || native.sessionId !== expected.sessionId ||
    (expected.lifecycleRevision !== undefined && native.lifecycleRevision !== expected.lifecycleRevision)) {
    throw new Error('The conversation changed before deletion.');
  }
};

/** Single and batch deletion share the same exact native binding and ACK recovery. */
export async function deleteBoundNativeSession(
  session: Pick<CoworkSession, 'nativeSessionKey' | 'historyBinding'>,
  requestGateway?: GatewayRequest,
  assertWorktreeUnused?: () => void,
  expected?: CoworkSubagentConversationIdentity,
): Promise<void> {
  if (!session.nativeSessionKey) return;
  if (!requestGateway) throw new Error('Gateway is unavailable for native session deletion.');
  let expectedSessionId = session.historyBinding?.nativeSessionId;
  let expectedLifecycleRevision: string | undefined;
  if (assertWorktreeUnused && !session.historyBinding) {
    const native = await describeNativeSession(requestGateway, session.nativeSessionKey);
    if (native === null) return;
    if (expected) assertDeletionIdentity(native, expected);
    if (typeof native?.sessionId !== 'string' || !native.sessionId.trim()) {
      throw new Error('Could not confirm the native session identity for deletion.');
    }
    expectedSessionId = native.sessionId;
    if (typeof native.lifecycleRevision === 'string') expectedLifecycleRevision = native.lifecycleRevision;
    if (native.worktree != null) assertWorktreeUnused();
  }
  let worktreePreserved = false;
  try {
    const deleted = await requestGateway<{ deleted?: unknown; worktreePreserved?: unknown }>('sessions.delete', {
      key: session.nativeSessionKey,
      ...(expectedSessionId ? { expectedSessionId } : {}),
      ...(expectedLifecycleRevision ? { expectedLifecycleRevision } : {}),
      deleteTranscript: true,
    });
    // An exact child deletion can succeed while retaining its Worktree.
    if (expected && deleted.deleted === true) return;
    worktreePreserved = !!deleted.worktreePreserved;
  } catch (error) {
    const described = await requestGateway<{ session?: unknown }>('sessions.describe', {
      key: session.nativeSessionKey,
    });
    // A failed/unknown delete is successful only after an explicit absence receipt.
    if (described.session !== null) throw error;
  }
  if (worktreePreserved) {
    throw new Error(
      'The session was removed but its worktree was preserved. Inspect it in Settings → Worktrees.',
    );
  }
}
