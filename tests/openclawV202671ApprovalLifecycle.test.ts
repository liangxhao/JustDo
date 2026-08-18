import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const suspensionPatch =
  require('../scripts/patches/v2026.7.1-2/023-approval-run-suspension.cjs') as {
    transformGateway: (content: string, filePath: string) => string;
  };
const resumePatch =
  require('../scripts/patches/v2026.7.1-2/024-approval-resolution-resume.cjs') as {
    transform: (content: string, filePath: string) => string;
  };
const stopPatch = require('../scripts/patches/v2026.7.1-2/025-approval-stop-and-failure.cjs') as {
  transformExec: (content: string, filePath: string) => string;
  transformShared: (content: string, filePath: string) => string;
};

describe('OpenClaw v2026.7.1-2 approval lifecycle patches', () => {
  test('preserves explicit null gateway timeout without changing native defaults', () => {
    const source = `function resolveGatewayOptions(opts) {
  const timeoutMs = typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) ? Math.max(1, Math.floor(opts.timeoutMs)) : 3e4;
  return timeoutMs;
}`;
    const pristineResolveGatewayOptions = new Function(
      `${source}; return resolveGatewayOptions;`,
    )() as (options?: { timeoutMs?: number | null }) => number;
    expect(pristineResolveGatewayOptions({ timeoutMs: null })).toBe(30_000);

    const transformed = suspensionPatch.transformGateway(source, 'gateway.js');
    const resolveGatewayOptions = new Function(
      `${transformed}; return resolveGatewayOptions;`,
    )() as (options?: { timeoutMs?: number | null }) => number | null;

    expect(resolveGatewayOptions({ timeoutMs: null })).toBeNull();
    expect(resolveGatewayOptions({ timeoutMs: 0 })).toBe(1);
    expect(resolveGatewayOptions()).toBe(30_000);
  });

  test('routes only managed webchat approvals to a hidden follow-up turn', () => {
    const source = `function normalizeMessageChannel(value) { return value; }
function isNativeApprovalChannel(value) { return value === "webchat" || value === "slack"; }
function isJustDoManagedApprovalSessionKey(sessionKey) { return sessionKey.startsWith("agent:main:justdo:"); }
function stringifyRouteThreadId(value) { return value; }
function buildExecApprovalFollowupPrompt(value) { return value; }
function buildExecApprovalFollowupIdempotencyKey() { return "approval-key"; }
function buildAgentFollowupArgs(params) {
\tconst { deliveryTarget, sessionOnlyOriginChannel } = params;
\tconst fallbackChannel = sessionOnlyOriginChannel ?? params.turnSourceChannel;
\treturn {
\t\tsessionKey: params.sessionKey,
\t\tmessage: buildExecApprovalFollowupPrompt(params.resultText),
\t\tdeliver: deliveryTarget.deliver,
\t\t...deliveryTarget.deliver ? { bestEffortDeliver: true } : {},
\t\tchannel: deliveryTarget.deliver ? deliveryTarget.channel : fallbackChannel,
\t\tto: deliveryTarget.deliver ? deliveryTarget.to : params.turnSourceTo,
\t\taccountId: deliveryTarget.deliver ? deliveryTarget.accountId : params.turnSourceAccountId,
\t\tthreadId: deliveryTarget.deliver ? deliveryTarget.threadId : stringifyRouteThreadId(params.turnSourceThreadId),
\t\tidempotencyKey: params.idempotencyKey ?? buildExecApprovalFollowupIdempotencyKey({ approvalId: params.approvalId }),
\t\t...params.expectedSessionId ? { execApprovalFollowupExpectedSessionId: params.expectedSessionId } : {},
\t\t...params.internalRuntimeHandoffId ? { internalRuntimeHandoffId: params.internalRuntimeHandoffId } : {}
\t};
}
function shouldAwaitGatewayApprovalInline(params) {
\tif (params.approvalFollowupMode !== void 0) return false;
\treturn isNativeApprovalChannel(normalizeMessageChannel(params.turnSourceChannel));
}`;
    const pristineRuntime = new Function(
      `${source}; return { buildAgentFollowupArgs, shouldAwaitGatewayApprovalInline };`,
    )() as {
      buildAgentFollowupArgs: (params: Record<string, unknown>) => Record<string, unknown>;
      shouldAwaitGatewayApprovalInline: (params: Record<string, unknown>) => boolean;
    };
    const transformed = resumePatch.transform(source, 'bash-tools.js');
    const runtime = new Function(
      `${transformed}; return { buildAgentFollowupArgs, shouldAwaitGatewayApprovalInline };`,
    )() as {
      buildAgentFollowupArgs: (params: Record<string, unknown>) => Record<string, unknown>;
      shouldAwaitGatewayApprovalInline: (params: Record<string, unknown>) => boolean;
    };
    const managed = { sessionKey: 'agent:main:justdo:task', turnSourceChannel: 'webchat' };

    expect(pristineRuntime.shouldAwaitGatewayApprovalInline(managed)).toBe(true);
    expect(
      pristineRuntime.buildAgentFollowupArgs({
        ...managed,
        resultText: 'approved',
        approvalId: 'approval-1',
        deliveryTarget: { deliver: false },
      }).suppressPromptPersistence,
    ).toBeUndefined();
    expect(runtime.shouldAwaitGatewayApprovalInline(managed)).toBe(false);
    expect(
      runtime.shouldAwaitGatewayApprovalInline({
        sessionKey: 'agent:main:ordinary',
        turnSourceChannel: 'webchat',
      }),
    ).toBe(true);
    expect(
      runtime.shouldAwaitGatewayApprovalInline({
        sessionKey: 'agent:main:justdo:task',
        turnSourceChannel: 'slack',
      }),
    ).toBe(true);
    expect(
      runtime.buildAgentFollowupArgs({
        ...managed,
        resultText: 'approved',
        approvalId: 'approval-1',
        deliveryTarget: { deliver: false },
      }).suppressPromptPersistence,
    ).toBe(true);
  });

  test('accepts the explicit JustDo stop decision and maps it to a terminal denial', () => {
    const pristineShared = `const APPROVAL_ALREADY_RESOLVED_DETAILS = {};
function isApprovalDecision(value) {
\treturn value === "allow-once" || value === "allow-always" || value === "deny";
}`;
    const pristineIsApprovalDecision = new Function(
      `${pristineShared}; return isApprovalDecision;`,
    )() as (value: string) => boolean;
    expect(pristineIsApprovalDecision('deny-justdo-stop')).toBe(false);

    const shared = stopPatch.transformShared(pristineShared, 'approval-shared.js');
    const isApprovalDecision = new Function(`${shared}; return isApprovalDecision;`)() as (
      value: string,
    ) => boolean;
    expect(isApprovalDecision('deny-justdo-stop')).toBe(true);
    expect(isApprovalDecision('unknown')).toBe(false);

    const execSource = `function isJustDoManagedApprovalSessionKey(sessionKey) { return sessionKey === "managed"; }
function resolveBaseExecApprovalDecision(params) {
\tif (params.decision === "deny") return {
\t\tapprovedByAsk: false,
\t\tdeniedReason: "user-denied",
\t\ttimedOut: false
\t};
\treturn { approvedByAsk: false, deniedReason: null, timedOut: false };
}
async function gatewayCase(params, approvalId, followupTarget) {
\tconst approvalDecision = await resolveApprovalForExecution(() => void sendExecApprovalFollowupResult(followupTarget, \`Exec denied (gateway id=\${approvalId}, approval-request-failed): \${params.command}\`));
\tif (approvalDecision.deniedReason) {
\t\t\t\tawait sendExecApprovalFollowupResult(followupTarget, \`Exec denied (gateway id=\${approvalId}, \${approvalDecision.deniedReason}): \${params.command}\`);
\t\t\t\treturn;
\t\t\t}
}
async function nodeCase(params, target, approvalId, followupTarget) {
\tresolveApprovalDecisionOrUndefined({
\t\t\t\t\t\tonFailure: () => void sendExecApprovalFollowupResult(followupTarget, \`Exec denied (node=\${target.nodeId} id=\${approvalId}, approval-request-failed): \${params.command}\`)
\t\t\t\t\t});
\tif (deniedReason) {
\t\t\t\t\t\tawait sendExecApprovalFollowupResult(followupTarget, \`Exec denied (node=\${target.nodeId} id=\${approvalId}, \${deniedReason}): \${params.command}\`);
\t\t\t\t\t\treturn;
\t\t\t\t\t}
}`;
    const transformedExec = stopPatch.transformExec(execSource, 'bash-tools.js');
    const resolveBaseExecApprovalDecision = new Function(
      `${transformedExec}; return resolveBaseExecApprovalDecision;`,
    )() as (params: { decision: string }) => {
      approvedByAsk: boolean;
      deniedReason: string | null;
      timedOut: boolean;
    };

    expect(resolveBaseExecApprovalDecision({ decision: 'deny-justdo-stop' })).toEqual({
      approvedByAsk: false,
      deniedReason: 'justdo-stop',
      timedOut: false,
    });
    expect(transformedExec).toContain('approvalDecision.deniedReason === "justdo-stop"');
    expect(transformedExec).toContain('if (!isJustDoManagedApprovalSessionKey(params.sessionKey))');
  });

  test('all approval patch files carry the auditable capability header', () => {
    for (const name of [
      '023-approval-run-suspension.cjs',
      '024-approval-resolution-resume.cjs',
      '025-approval-stop-and-failure.cjs',
    ]) {
      const content = fs.readFileSync(
        path.join(process.cwd(), 'scripts', 'patches', 'v2026.7.1-2', name),
        'utf8',
      );
      for (const label of ['Capability:', 'Target:', 'Scope:', 'Safety:', 'Remove when:']) {
        expect(content).toContain(label);
      }
    }
  });
});
