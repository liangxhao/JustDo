import { ApprovalKind, ExecApprovalDecision } from '../../shared/security/approvals';
import { t } from '../core/i18n';
import { canGrantPersistentAppApproval, type ExternalPermissionPresenter } from '../openclaw/permissions/externalApprovalRouting';
import { buildSessionExecApprovalFingerprint } from '../openclaw/permissions/sessionExecApprovalGrants';
import {
  type AppServerConnectionContext,
  AppServerRequestMethod,
  isAppServerRecord,
} from './appServerProtocol';

const MAX_REQUEST_TIMEOUT_MS = 2_147_483_647;
const PERMISSION_QUESTION_ID = 'permission';
const CommandDecision = { Accept: 'accept', Decline: 'decline', Cancel: 'cancel' } as const;

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;

/** Advertise only real native decisions; the router retains permission authority. */
export function createAppServerApprovalPresenter(
  context: AppServerConnectionContext,
  threadId: string,
  turnId: string,
  signal: AbortSignal,
  cancel: () => void | Promise<void>,
  options: { nativeRunId?: string | (() => string | undefined); allowSession?: boolean } = {},
): ExternalPermissionPresenter {
  return async (request, approvalSignal) => {
    const authority = AbortSignal.any([signal, approvalSignal]);
    const allowed = request.request.allowedDecisions;
    const allowOnce = allowed == null || Array.isArray(allowed) && allowed.includes(ExecApprovalDecision.AllowOnce);
    if (
      context.isClosed() || authority.aborted || !context.request ||
      request.request.runId !== (typeof options.nativeRunId === 'function'
        ? options.nativeRunId() : options.nativeRunId ?? turnId) || !text(request.id) ||
      !Number.isSafeInteger(request.createdAtMs) || request.createdAtMs < 0 ||
      !Number.isSafeInteger(request.expiresAtMs) || request.expiresAtMs <= Date.now() ||
      (!allowOnce && !canGrantPersistentAppApproval(request))
    ) return ExecApprovalDecision.Deny;
    const requestOptions = {
      signal: authority,
      timeoutMs: Math.min(MAX_REQUEST_TIMEOUT_MS, request.expiresAtMs - Date.now()),
    };
    const itemId = text(request.request.toolCallId) ?? request.id;
    try {
      if (request.kind === ApprovalKind.Exec) {
        const allowSession = options.allowSession === true && context.isExperimentalApiEnabled?.() === true &&
          buildSessionExecApprovalFingerprint(request) !== null;
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
          reason: [request.request.warningText, request.request.commandAnalysis?.summary, request.request.commandAnalysis?.risk]
            .filter(value => text(value)).join('\n\n') || null,
          commandActions: null,
          networkApprovalContext: null,
          proposedExecpolicyAmendment: null,
          proposedNetworkPolicyAmendments: null,
          ...(context.isExperimentalApiEnabled?.() ? { availableDecisions: [
            CommandDecision.Accept, ...(allowSession ? ['acceptForSession'] : []), CommandDecision.Decline, CommandDecision.Cancel,
          ] } : {}),
        }, requestOptions);
        if (context.isClosed() || authority.aborted || request.expiresAtMs <= Date.now())
          return ExecApprovalDecision.Deny;
        if (!isAppServerRecord(response)) return ExecApprovalDecision.Deny;
        if (response.decision === CommandDecision.Cancel) {
          // Denial must not wait for an uncertain native Stop response.
          void Promise.resolve(cancel()).catch(() => {});
          return ExecApprovalDecision.Deny;
        }
        if (response.decision === 'acceptForSession' && allowSession) return 'allow-session';
        return response.decision === CommandDecision.Accept
          ? ExecApprovalDecision.AllowOnce : ExecApprovalDecision.Deny;
      }
      if (request.kind !== ApprovalKind.Plugin || !context.isExperimentalApiEnabled?.())
        return ExecApprovalDecision.Deny;
      const description = [request.request.title, request.request.description, request.request.detail]
        .filter(value => text(value)).join('\n\n');
      if (!description) return ExecApprovalDecision.Deny;
      const allowLabel = t('externalAgentAllowOnce');
      const appLabel = t('appServerAllowApp');
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
            ...(allowOnce ? [{ label: allowLabel, description: allowLabel }] : []),
            ...(canGrantPersistentAppApproval(request)
              ? [{ label: appLabel, description: t('appServerAllowAppDescription') }] : []),
            { label: denyLabel, description: denyLabel },
          ],
        }],
      }, requestOptions);
      if (context.isClosed() || authority.aborted || request.expiresAtMs <= Date.now() ||
        !isAppServerRecord(response) || !isAppServerRecord(response.answers))
        return ExecApprovalDecision.Deny;
      const answers = response.answers;
      const answer = answers[PERMISSION_QUESTION_ID];
      if (Object.keys(answers).length !== 1 || !isAppServerRecord(answer) ||
        !Array.isArray(answer.answers) || answer.answers.length !== 1) return ExecApprovalDecision.Deny;
      if (answer.answers[0] === appLabel && canGrantPersistentAppApproval(request)) return ExecApprovalDecision.AllowAlways;
      return answer.answers[0] === allowLabel && allowOnce ? ExecApprovalDecision.AllowOnce : ExecApprovalDecision.Deny;
    } catch {
      // Errors, timeouts, unsupported decisions and cancellation can never grant permission.
      return ExecApprovalDecision.Deny;
    }
  };
}
