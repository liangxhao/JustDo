import { ApprovalKind, ExecApprovalDecision } from '../../../shared/security/approvals';
import {
  type AppServerConnectionContext,
  AppServerRequestMethod,
  isAppServerRecord,
} from '../../appServer/appServerProtocol';
import { t } from '../../core/i18n';
import type { ExternalPermissionPresenter } from '../../openclaw/permissions/externalApprovalRouting';

const MAX_REQUEST_TIMEOUT_MS = 2_147_483_647;
const PERMISSION_QUESTION_ID = 'permission';
const CommandDecision = { Accept: 'accept', Decline: 'decline', Cancel: 'cancel' } as const;

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;

/** Present only one-shot native decisions; the native router retains permission authority. */
export function createCodexApprovalPresenter(
  context: AppServerConnectionContext,
  threadId: string,
  turnId: string,
  signal: AbortSignal,
  cancel: () => void,
): ExternalPermissionPresenter {
  return async (request, approvalSignal) => {
    const authority = AbortSignal.any([signal, approvalSignal]);
    const allowed = request.request.allowedDecisions;
    if (
      context.isClosed() || authority.aborted || !context.request ||
      request.request.runId !== turnId || !text(request.id) ||
      !Number.isSafeInteger(request.createdAtMs) || request.createdAtMs < 0 ||
      !Number.isSafeInteger(request.expiresAtMs) || request.expiresAtMs <= Date.now() ||
      (allowed != null && !allowed.includes(ExecApprovalDecision.AllowOnce))
    ) return ExecApprovalDecision.Deny;
    const options = {
      signal: authority,
      timeoutMs: Math.min(MAX_REQUEST_TIMEOUT_MS, request.expiresAtMs - Date.now()),
    };
    const itemId = text(request.request.toolCallId) ?? request.id;
    try {
      if (request.kind === ApprovalKind.Exec) {
        const command = text(request.request.command);
        const argv = request.request.commandArgv;
        // Preserve an argv-only command as JSON, rather than inventing shell quoting.
        const commandDisplay = command ?? (Array.isArray(argv) && argv.length > 0 &&
          argv.every(value => typeof value === 'string') ? JSON.stringify(argv) : undefined);
        if (!commandDisplay) return ExecApprovalDecision.Deny;
        const response = await context.request(AppServerRequestMethod.CommandExecutionApproval, {
          threadId,
          turnId,
          itemId,
          approvalId: request.id,
          startedAtMs: request.createdAtMs,
          kind: 'command',
          command: commandDisplay,
          cwd: text(request.request.cwd) ?? null,
          reason: text(request.request.warningText) ?? null,
          commandActions: null,
          networkApprovalContext: null,
          proposedExecpolicyAmendment: null,
          proposedNetworkPolicyAmendments: null,
        }, options);
        if (context.isClosed() || authority.aborted || request.expiresAtMs <= Date.now())
          return ExecApprovalDecision.Deny;
        if (!isAppServerRecord(response)) return ExecApprovalDecision.Deny;
        if (response.decision === CommandDecision.Cancel) {
          cancel();
          return ExecApprovalDecision.Deny;
        }
        return response.decision === CommandDecision.Accept
          ? ExecApprovalDecision.AllowOnce : ExecApprovalDecision.Deny;
      }
      if (request.kind !== ApprovalKind.Plugin || !context.isExperimentalApiEnabled?.())
        return ExecApprovalDecision.Deny;
      const description = [request.request.title, request.request.description, request.request.detail]
        .filter(value => text(value)).join('\n\n');
      if (!description) return ExecApprovalDecision.Deny;
      const allowLabel = t('externalAgentAllowOnce');
      const denyLabel = t('externalAgentReject');
      const response = await context.request(AppServerRequestMethod.ToolUserInput, {
        threadId,
        turnId,
        itemId,
        isBlocking: true,
        questions: [{
          id: PERMISSION_QUESTION_ID,
          header: t('externalAgentToolPermission'),
          question: description,
          isOther: false,
          isSecret: false,
          options: [
            { label: allowLabel, description: allowLabel },
            { label: denyLabel, description: denyLabel },
          ],
        }],
      }, options);
      if (context.isClosed() || authority.aborted || request.expiresAtMs <= Date.now() ||
        !isAppServerRecord(response) || !isAppServerRecord(response.answers))
        return ExecApprovalDecision.Deny;
      const answers = response.answers;
      const answer = answers[PERMISSION_QUESTION_ID];
      return Object.keys(answers).length === 1 && isAppServerRecord(answer) &&
        Array.isArray(answer.answers) && answer.answers.length === 1 && answer.answers[0] === allowLabel
        ? ExecApprovalDecision.AllowOnce : ExecApprovalDecision.Deny;
    } catch {
      // Errors, timeouts, unsupported decisions and cancellation can never grant permission.
      return ExecApprovalDecision.Deny;
    }
  };
}
