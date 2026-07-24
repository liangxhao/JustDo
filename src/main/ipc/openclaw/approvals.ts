import { ipcMain } from 'electron';

import {
  type ApprovalDecision,
  ApprovalKind,
  type ApprovalRequest,
  isApprovalDecision,
  OpenClawApprovalIpc,
} from '../../../shared/openclaw/approvals';
import type { OpenClawRuntimeAdapter } from '../../engine/openclaw/openclawRuntimeAdapter';

interface Dependencies {
  getRuntime: () => OpenClawRuntimeAdapter | null;
}

export const registerOpenClawApprovalHandlers = ({ getRuntime }: Dependencies): void => {
  ipcMain.handle(OpenClawApprovalIpc.List, async () => {
    try {
      const runtime = getRuntime();
      if (!runtime) return { success: true, requests: [] as ApprovalRequest[] };
      const requests = await runtime.listPendingApprovals();
      return { success: true, requests };
    } catch (error) {
      return {
        success: false,
        requests: [] as ApprovalRequest[],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle(
    OpenClawApprovalIpc.Resolve,
    async (_event, input: { id?: unknown; decision?: unknown; kind?: unknown }) => {
      const id = typeof input?.id === 'string' ? input.id.trim() : '';
      const decision = input?.decision;
      const kind = input?.kind;
      if (
        !id ||
        !isApprovalDecision(decision) ||
        (kind !== ApprovalKind.Exec && kind !== ApprovalKind.Plugin)
      ) {
        return { success: false, error: 'Invalid approval decision.' };
      }
      try {
        const runtime = getRuntime();
        if (!runtime) return { success: false, error: 'OpenClaw runtime is unavailable.' };
        await runtime.resolveApproval(id, decision as ApprovalDecision, kind);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );
};
