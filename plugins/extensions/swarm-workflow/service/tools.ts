import { randomUUID } from 'node:crypto';

import { blocksWorkflowStartDuringTeamLaunch } from '../../runtime-services/agent-team/launch/agent-team-launch-state';
import {
  captureFilesystemAdmission,
  type FilesystemAdmission,
} from '../../runtime-services/filesystem/admission';
import { registerBatchApi, RESULT_TOOL } from '../batch/api';
import { candidateItemResult } from '../batch/snapshot';
import { FLOW_LIMITS, FLOW_MANAGEMENT_TOOLS, FLOW_RPC, FLOW_TOOLS } from '../contracts/flow';
import { SUBMISSION_LIMITS, validateSubmission } from '../execution/submission';
import { parentPolicy } from '../execution/policy';
import { createManagementTools } from '../management/tools';
import { parseSwarmWorkflowRequest } from '../prompt/request';
import type { WorkflowContext } from './context';
import { entry, inPlanMode, managed, object } from './native-context';
import { readLatestWorkflowUser } from './source-request';

export function registerWorkflowSubmissionTools(context: WorkflowContext): void {
  const {
    api,
    state,
    submissionCalls,
    managementCalls,
    ensure,
    assertParent,
    assertParentIdentity,
    callKey,
  } = context;
  api.registerTool(
    {
      contextVersion: 2,
      create: ctx => {
        const node = state.store
          ?.all()
          .flatMap(flow => flow.nodes)
          .find(item => item.sessionKey === ctx.sessionKey);
        if (!node || !['work', 'verify'].includes(node.kind)) return null;
        return [
          node.kind === 'verify' ? FLOW_TOOLS.verify : FLOW_TOOLS.complete,
          FLOW_TOOLS.block,
        ].map(name => ({
          name,
          label:
            name === FLOW_TOOLS.verify
              ? 'Submit Swarm Workflow verification'
              : name === FLOW_TOOLS.block
                ? 'Report Swarm Workflow blocker'
                : 'Submit Swarm Workflow task result',
          description:
            name === FLOW_TOOLS.verify
              ? 'Submit your assigned verification verdict with concrete evidence. passed=true requires the original goal to be satisfied; report passed=false with exact missing work otherwise. On acceptance end the turn; prose or JSON in the final reply cannot replace this submission.'
              : name === FLOW_TOOLS.block
                ? 'Report a genuine unmet prerequisite or external blocker for your assigned node. Include what is needed and evidence. Do not report incomplete work as success. On acceptance end the turn.'
                : 'Submit the completed result of your assigned task, with deliverable/evidence references and limitations. On acceptance end the turn. If rejected, correct the fields and submit again while the run is active.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              summary: {
                type: 'string',
                minLength: 1,
                maxLength: SUBMISSION_LIMITS.summary,
                description:
                  'Optional concise summary; if omitted, derived from the submitted evidence.',
              },
              evidence: {
                description:
                  'Required concrete results, deliverable references or blocker details; text or a list of strings.',
                anyOf: [
                  { type: 'string', minLength: 1, maxLength: SUBMISSION_LIMITS.evidenceReport },
                  {
                    type: 'array',
                    minItems: 1,
                    maxItems: SUBMISSION_LIMITS.evidenceCount,
                    items: {
                      type: 'string',
                      minLength: 1,
                      maxLength: SUBMISSION_LIMITS.evidenceItem,
                    },
                  },
                ],
              },
              ...(name === FLOW_TOOLS.verify ? { passed: { type: 'boolean' } } : {}),
            },
            required: name === FLOW_TOOLS.verify ? ['evidence', 'passed'] : ['evidence'],
          },
          async execute(toolCallId: string, input: unknown, signal?: AbortSignal) {
            const key = callKey(ctx.sessionKey!, toolCallId, name);
            try {
              const bound = submissionCalls.get(key);
              if (
                !bound ||
                bound.expiresAt <= Date.now() ||
                bound.signal?.aborted ||
                signal?.aborted
              )
                throw new Error('Native submission authority is unavailable or expired.');
              ctx.assertInvocationCurrent();
              const submission = validateSubmission(
                name === FLOW_TOOLS.verify
                  ? 'verified'
                  : name === FLOW_TOOLS.block
                    ? 'blocked'
                    : 'complete',
                input,
              );
              const current = ensure().engine;
              const { flow, node } = current.submissionOwner(ctx.sessionKey!, bound.runId);
              assertParent(flow);
              const guard = () => {
                signal?.throwIfAborted();
                bound.signal?.throwIfAborted();
                ctx.assertInvocationCurrent();
                const latest = current.submissionOwner(ctx.sessionKey!, bound.runId);
                assertParent(latest.flow);
                if (
                  latest.flow.controlVersion !== flow.controlVersion ||
                  latest.node.attempt !== node.attempt
                )
                  throw new Error('Submission admission revoked.');
              };
              const artifacts =
                node.batchItem && submission.outcome === 'complete'
                  ? await candidateItemResult(flow, node, submission, guard)
                  : undefined;
              guard();
              ctx.assertInvocationCurrent();
              current.submit(ctx.sessionKey!, bound.runId, submission, artifacts);
              const result = {
                accepted: true,
                message:
                  'Submission persisted. End this turn now; dependent tasks wait for native execution to settle.',
              };
              return {
                details: result,
                content: [{ type: 'text' as const, text: JSON.stringify(result) }],
              };
            } catch (error) {
              const result = {
                accepted: false,
                error: String(error),
                message:
                  'No new terminal submission was recorded. Correct invalid fields and submit again if this run remains active; do not claim acceptance.',
              };
              return {
                isError: true,
                details: result,
                content: [{ type: 'text' as const, text: JSON.stringify(result) }],
              };
            } finally {
              submissionCalls.delete(key);
            }
          },
        }));
      },
    },
    { names: Object.values(FLOW_TOOLS) },
  );
  api.registerTool(
    {
      contextVersion: 2,
      create: ctx => {
        if (!managed(ctx.sessionKey) || !state.store) return null;
        const parentKey = ctx.sessionKey;
        return createManagementTools(parentKey, {
          current: ensure,
          assertParent,
          assertParentIdentity,
          invocation: (toolCallId, name) => {
            const bound = managementCalls.get(callKey(parentKey, toolCallId, name));
            return {
              runId: bound?.runId ?? '',
              assertCurrent: () => {
                if (!bound || bound.expiresAt <= Date.now() || bound.signal?.aborted)
                  throw new Error('Native management authority is unavailable or expired.');
                ctx.assertInvocationCurrent();
                ensure();
              },
            };
          },
        });
      },
    },
    { names: Object.values(FLOW_MANAGEMENT_TOOLS) },
  );
}

export function registerWorkflowResultTools(context: WorkflowContext): void {
  const { api, state, submissionCalls, ensure, assertParent, callKey, resultBudgets } = context;
  registerBatchApi(api, {
    current: ensure,
    assertParent,
    bound: (sessionKey, callId) => {
      const key = callKey(sessionKey, callId, RESULT_TOOL);
      const bound = submissionCalls.get(key);
      const generation = state.generation;
      submissionCalls.delete(key);
      if (!bound || bound.expiresAt <= Date.now() || bound.signal?.aborted)
        throw new Error('Native result query authority is unavailable or expired.');
      return {
        runId: bound.runId,
        resultBudget: resultBudgets.read(sessionKey, bound.runId, bound.budgetAttempt),
        assertCurrent: () => {
          if (bound.signal?.aborted || generation !== state.generation)
            throw new Error('Native result query cancelled or service replaced.');
          ensure();
        },
      };
    },
  });
}

export function registerWorkflowStartTool(context: WorkflowContext): void {
  const { api, state, rpc } = context;
  api.registerTool(
    {
      contextVersion: 2,
      create: ctx => {
        if (!managed(ctx.sessionKey)) return null;
        const competingTeamLaunch = () =>
          blocksWorkflowStartDuringTeamLaunch(api.runtime.state.resolveStateDir(), {
            sessionKey: ctx.sessionKey!,
            sessionId: ctx.sessionId,
          });
        if (competingTeamLaunch()) return null;
        return {
          name: 'swarm_workflow_start',
          label: 'Start Swarm Workflow task flow',
          description:
            'Start a durable task flow ONLY when the user requests Swarm Workflow/task-flow execution. Supply a self-contained goal resolving conversation references and attachment content; workers do not inherit chat history or images. Preserve exact user agent assignments and constraints. The service independently plans, executes, verifies and delivers here. After acceptance end the turn without duplicating work. One unfinished flow per conversation. No Workboard dependency.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              goal: { type: 'string', minLength: 1, maxLength: FLOW_LIMITS.goal },
              mode: { type: 'string', enum: ['auto', 'research', 'review'] },
              concurrency: {
                type: 'integer',
                minimum: 1,
                maximum: 16,
                description:
                  'Optional lower per-flow ceiling at the user request. Never raises the global Swarm Workflow or native capacity limits.',
              },
              sourceRequestId: { type: 'string', minLength: 1, maxLength: 256 },
            },
            required: ['goal', 'mode'],
          },
          async execute(_toolCallId: string, input: unknown, signal?: AbortSignal) {
            if (signal?.aborted) throw new Error('Flow request cancelled.');
            if (!object(input)) throw new Error('Invalid flow request.');
            const generation = state.generation;
            const parent = entry(ctx.sessionKey!);
            if (!parent || parent.sessionId !== ctx.sessionId)
              throw new Error('Native parent identity changed.');
            const snapshot = {
              sessionId: parent.sessionId,
              cwd: parent.sessionRoot,
              permissionMode: parent.permissionMode,
              policy: parentPolicy(parent),
            };
            const intakeFor = (requestId: unknown) =>
              [...state.startTurns.entries()].find(
                ([key, turn]) =>
                  key.startsWith(ctx.sessionKey + '\n') && turn.requestId === requestId,
              );
            let intake = intakeFor(input.sourceRequestId);
            const assertCurrent = () => {
              signal?.throwIfAborted();
              ctx.assertInvocationCurrent();
              if (competingTeamLaunch())
                throw new Error('Agent Team is the selected execution mode for this request.');
              const current = entry(ctx.sessionKey!);
              if (
                generation !== state.generation ||
                !current ||
                current.sessionId !== snapshot.sessionId ||
                current.sessionRoot !== snapshot.cwd ||
                current.permissionMode !== snapshot.permissionMode ||
                parentPolicy(current) !== snapshot.policy ||
                inPlanMode(current) ||
                (intake &&
                  (state.startTurns.get(intake[0]) !== intake[1] ||
                    intake[1].generation !== generation ||
                    intake[1].expiresAt <= Date.now() ||
                    intake[1].parentId !== snapshot.sessionId ||
                    intake[1].cwd !== snapshot.cwd ||
                    intake[1].permissionMode !== snapshot.permissionMode ||
                    intake[1].policy !== snapshot.policy ||
                    intake[1].mode !== input.mode))
              )
                throw new Error('Swarm Workflow source changed before flow creation.');
            };
            const latestUser = await readLatestWorkflowUser({
              sessionKey: ctx.sessionKey!,
              rpc,
              assertCurrent,
            });
            const content =
              typeof latestUser?.content === 'string'
                ? latestUser.content
                : Array.isArray(latestUser?.content)
                  ? latestUser.content
                      .filter(part => part.type === 'text' && typeof part.text === 'string')
                      .map(part => part.text)
                      .join('\n')
                  : '';
            const sourceRequestId = latestUser?.idempotencyKey;
            if (
              typeof sourceRequestId !== 'string' ||
              !sourceRequestId ||
              sourceRequestId.length > 256 ||
              (input.sourceRequestId !== undefined && input.sourceRequestId !== sourceRequestId)
            )
              throw new Error('The source Swarm Workflow request is no longer current.');
            const sourceMarker = parseSwarmWorkflowRequest(content);
            if (sourceMarker && sourceMarker.mode !== input.mode)
              throw new Error('The source Swarm Workflow mode does not match.');
            const assignmentRequest = sourceMarker ? sourceMarker.request : content;
            intake = intakeFor(sourceRequestId);
            assertCurrent();
            let filesystem: FilesystemAdmission | undefined;
            if (ctx.fsPolicy && !ctx.sandboxed && parent.permissionMode !== 'read-only')
              filesystem = captureFilesystemAdmission(
                ctx,
                String(parent.sessionRoot),
                String(parent.permissionMode),
                api.runtime.config.current(),
              );
            for (const [key, value] of state.startAdmissions)
              if (value.expiresAt <= Date.now()) state.startAdmissions.delete(key);
            if (state.startAdmissions.size >= 128)
              throw new Error('Too many pending flow admissions.');
            const token = randomUUID();
            state.startAdmissions.set(token, {
              parentKey: ctx.sessionKey!,
              parentId: String(parent.sessionId),
              requestId: sourceRequestId,
              goal: String(input.goal),
              mode: String(input.mode),
              concurrency: input.concurrency as number | undefined,
              generation,
              expiresAt: Date.now() + 30000,
              assertCurrent,
              filesystem,
            });
            const flow = await rpc(FLOW_RPC.start, {
              parentKey: ctx.sessionKey,
              requestId: sourceRequestId,
              assignmentRequest,
              goal: input.goal,
              mode: input.mode,
              concurrency: input.concurrency,
              admission: token,
            });
            // Keep this run's selected-mode fence after acceptance. Only its
            // exact native whole-run terminal (or expiry/stop) retires it.
            return {
              details: { flow },
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    flow,
                    message:
                      'Flow accepted. The Gateway service now owns execution. Report the flow started, then end this turn; do not duplicate the task. Final delivery will be injected into this conversation.',
                  }),
                },
              ],
            };
          },
        };
      },
    },
    { name: 'swarm_workflow_start' },
  );
}
