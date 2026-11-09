import fs from 'node:fs';
import path from 'node:path';

import { CoworkPlanHandoffState } from '../../../shared/cowork/interactions/planHandoff';
import {
  SessionWorkspaceFailure,
  type SetSessionWorkspaceInput,
  type SetSessionWorkspaceResult,
} from '../../../shared/cowork/sessionWorkspace';
import type { CoworkSession, CoworkStore } from '../../data/coworkStore';
import type { CoworkEngineRouter } from './coworkEngineRouter';

export type SessionWorkspaceUpdater = (
  input: SetSessionWorkspaceInput,
  isAllowed: () => boolean,
) => Promise<SetSessionWorkspaceResult>;

export interface SessionWorkspaceDependencies {
  getCoworkStore: () => CoworkStore;
  getCoworkEngineRouter: () => CoworkEngineRouter;
  isBlocked: (sessionId: string) => boolean;
  isManaged: (sessionId: string) => boolean;
  onSessionsChanged?: () => void;
}

const identity = (session: CoworkSession) =>
  JSON.stringify([
    session.source,
    session.agentId,
    session.cwd,
    session.permissionMode,
    session.modelRef,
    session.nativeSessionKey,
    session.historyBinding,
    session.branchCreationPending,
    session.external,
    session.nativeParentSessionId,
  ]);

export function createSessionWorkspaceUpdater(
  deps: SessionWorkspaceDependencies,
): SessionWorkspaceUpdater {
  return async (input, isAllowed) => {
    const fail = (reason: SessionWorkspaceFailure): SetSessionWorkspaceResult => ({
      success: false,
      reason,
    });
    if (!isAllowed()) return fail(SessionWorkspaceFailure.Unsupported);
    if (
      !input ||
      typeof input.sessionId !== 'string' ||
      !input.sessionId.trim() ||
      input.sessionId.length > 512 ||
      typeof input.expectedCwd !== 'string' ||
      input.expectedCwd.length > 32768 ||
      typeof input.cwd !== 'string' ||
      !input.cwd.trim() ||
      input.cwd.length > 32768 ||
      !path.isAbsolute(input.cwd.trim())
    )
      return fail(SessionWorkspaceFailure.Invalid);
    const store = deps.getCoworkStore();
    const session = store.getSession(input.sessionId);
    if (
      !session ||
      session.external ||
      deps.isManaged(session.id) ||
      session.branchCreationPending ||
      (session.nativeSessionKey && !session.historyBinding)
    )
      return fail(SessionWorkspaceFailure.Unsupported);
    if (session.cwd !== input.expectedCwd) return fail(SessionWorkspaceFailure.Changed);
    const router = deps.getCoworkEngineRouter();
    const blocked = () => {
      const handoffs = store.listPlanHandoffs(session.id);
      return (
        deps.isBlocked(session.id) ||
        router.isSessionActive(session.id) ||
        router.isSessionPreparing(session.id) ||
        !!store.getActiveSessionRun(session.id) ||
        handoffs.some(
          handoff =>
            handoff.state === CoworkPlanHandoffState.Presented ||
            handoff.state === CoworkPlanHandoffState.Dispatching ||
            handoff.state === CoworkPlanHandoffState.Admitted,
        ) ||
        handoffs.at(-1)?.state === CoworkPlanHandoffState.Failed
      );
    };
    try {
      if (router.hasUnconfirmedSessionPreparation(session.id))
        return fail(SessionWorkspaceFailure.PreparationUnknown);
      if (blocked()) return fail(SessionWorkspaceFailure.Busy);
      let cwd: string;
      try {
        cwd = fs.realpathSync.native(input.cwd.trim());
        if (
          !fs.statSync(cwd).isDirectory() ||
          (process.platform === 'win32' && path.parse(cwd).root === cwd)
        )
          return fail(SessionWorkspaceFailure.Invalid);
      } catch {
        return fail(SessionWorkspaceFailure.Invalid);
      }
      const originalIdentity = identity(session);
      const originalRun = JSON.stringify(store.getLatestSessionRun(session.id));
      const status = await router.getSessionRuntimeStatus(session.id, {
        targeted: true,
        includeSubagents: true,
        forceRefresh: true,
      });
      const current = store.getSession(session.id);
      if (
        !current ||
        identity(current) !== originalIdentity ||
        deps.getCoworkEngineRouter() !== router ||
        JSON.stringify(store.getLatestSessionRun(session.id)) !== originalRun
      )
        return fail(SessionWorkspaceFailure.Changed);
      if (deps.isManaged(session.id)) return fail(SessionWorkspaceFailure.Unsupported);
      if (!isAllowed()) return fail(SessionWorkspaceFailure.Unsupported);
      if (router.hasUnconfirmedSessionPreparation(session.id))
        return fail(SessionWorkspaceFailure.PreparationUnknown);
      if (blocked()) return fail(SessionWorkspaceFailure.Busy);
      if (!status.known) return fail(SessionWorkspaceFailure.Unknown);
      if (status.running || status.mainRunning || status.subagentRunning)
        return fail(SessionWorkspaceFailure.Busy);
      // Persist intent only. Existing preparation verifies native mode/root before
      // a subsequent message or new terminal; no uncertain native write is retried.
      store.updateSession(session.id, { cwd });
      deps.onSessionsChanged?.();
      return { success: true, cwd };
    } catch {
      return fail(SessionWorkspaceFailure.Unavailable);
    }
  };
}
