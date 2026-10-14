import { NativeLaunchNotInvokedError } from '../execution/launch-admission';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { FlowEngine } from '../execution/engine';
import { FlowStore } from '../data/store';
import { FlowNotifier } from '../management/notifications';
import { FLOW_RPC } from '../contracts/flow';
import { WorkflowEventName, type WorkflowNativeChange } from '../contracts/events';
import { freezeBatch, verifyItemResult, readBatchManifest } from '../batch/snapshot';
import { assertCrossAgentPolicy } from '../execution/policy';
import { lastSubmissionError, submissionCorrectionInstructions } from '../execution/submission';
import {
  managedSubagent,
  type ManagedSubagent,
} from '../../runtime-services/execution/managed-subagent';
import { swarmWorkflowCapacity, swarmWorkflowSettings } from '../settings';
import type { WorkflowContext } from './context';

export function registerWorkflowLifecycle(context: WorkflowContext): void {
  const {
    api,
    state,
    resultBudgets,
    submissionCalls,
    managementCalls,
    assertParent,
    assertParentIdentity,
    ensure,
    rpc,
    prepare,
  } = context;
  let ownedGeneration: number | undefined;
  api.registerService({
    id: 'swarm-workflow',
    start(ctx) {
      if (state.engine) throw new Error('Swarm Workflow service is already running.');
      const events = ctx.gatewayEvents;
      if (!events) throw new Error('Swarm Workflow requires plugin Gateway events.');
      const epoch = ++state.generation;
      ownedGeneration = epoch;
      const publishChange = (change?: WorkflowNativeChange) => {
        if (epoch !== state.generation) return;
        try {
          events.emit(
            change ? WorkflowEventName.Changed : WorkflowEventName.Reset,
            change ? { ...change } : {},
            { scope: 'operator.read' },
          );
        } catch {
          // The transaction is already committed; a notice cannot turn it into a failed write.
          ctx.logger.error('[SwarmWorkflow] Failed to publish workflow change.');
        }
      };
      state.store = new FlowStore(path.join(ctx.stateDir, 'swarm-workflow'), publishChange);
      state.engine = new FlowEngine(state.store, {
        capacity: () => {
          const config = api.runtime.config.current();
          return swarmWorkflowCapacity(
            config,
            swarmWorkflowSettings(config.plugins?.entries?.['swarm-workflow']?.config),
          );
        },
        assertAdmission: assertParent,
        freezeBatch: (flow, node, guard) =>
          freezeBatch(flow, node, () => {
            guard();
            assertParent(flow);
          }),
        verifyResult: (flow, node, guard) =>
          verifyItemResult(flow, node, () => {
            guard();
            assertParent(flow);
          }),
        prepare,
        launch: async (flow, node, message, assertCurrent) => {
          let runtime: ManagedSubagent;
          let params: Parameters<ManagedSubagent['run']>[0];
          try {
            assertParent(flow);
            const validate = () => {
              assertCurrent();
              assertParent(flow);
              assertCrossAgentPolicy(api.runtime.config.current(), flow.agentId, node.agentId);
            };
            runtime = managedSubagent(api);
            let projectRules: string | undefined;
            if (node.batchItem)
              projectRules = (
                await readBatchManifest(
                  flow,
                  flow.nodes.find(stage => stage.id === node.batchItem!.stageId)!,
                  validate,
                )
              ).projectRules;
            validate();
            params = {
              sessionKey: node.sessionKey,
              message,
              cwd: node.batchItem?.workspace ?? flow.cwd,
              idempotencyKey: node.intendedRunId,
              assertCurrent: validate,
              disableTools: node.kind === 'plan' || node.kind === 'deliver',
              deliver: false,
              managedToolsLifetime: 'run',
              timeoutSeconds: node.deadlineAt
                ? Math.max(1, Math.floor((node.deadlineAt - Date.now()) / 1000))
                : (flow.settings ?? swarmWorkflowSettings({})).executionTimeoutSeconds,
              ...(projectRules
                ? {
                    extraSystemPrompt:
                      'Project rules from ' +
                      path.join(flow.cwd, 'AGENTS.md') +
                      '\nFrozen input version: ' +
                      node.batchItem?.manifestVersion +
                      '\nRetain these project rules for this item workspace, together with the native assistant role rules:\n' +
                      projectRules,
                  }
                : {}),
            };
          } catch (error) {
            throw new NativeLaunchNotInvokedError(error);
          }
          // The invocation boundary is outside the preflight catch. Even a
          // synchronous SDK failure cannot prove that no run was committed.
          return runtime.run(params);
        },
        wait: async runId => {
          const runtime = managedSubagent(api);
          const reply = await runtime.waitForRun({ runId, timeoutMs: 1 });
          const state = await runtime.describeRun({ runId });
          if (state.runId !== runId) throw new Error('Native execution identity changed.');
          return {
            ...reply,
            status: state.state === 'settled' ? (state.outcome ?? 'error') : 'pending',
            endedAt: state.executionEndedAt,
            executionSettled: state.executionSettled,
            cleanupSettled: state.cleanupSettled,
            executionStartedAt: state.executionStartedAt,
            unknown: state.state === 'unknown',
          };
        },
        correctionInstruction: async (flow, node) => {
          const runId = node.runId ?? node.intendedRunId!;
          assertParent(flow);
          ensure().engine.submissionOwner(node.sessionKey, runId);
          let error: string | undefined;
          try {
            const history = await api.runtime.subagent.getSessionMessages({
              sessionKey: node.sessionKey,
              limit: 64,
            });
            error = lastSubmissionError(history.messages, runId);
          } catch {
            // The native conversation still owns the evidence if this read
            // is unavailable. Never manufacture a successful result.
          }
          const current = ensure().engine.submissionOwner(node.sessionKey, runId);
          assertParent(current.flow);
          return error
            ? submissionCorrectionInstructions(node.kind as 'work' | 'verify', error)
            : (current.node.submissionRepair?.instruction ??
                submissionCorrectionInstructions(node.kind as 'work' | 'verify'));
        },
        cancel: async node => {
          if (node.runId || node.intendedRunId)
            await managedSubagent(api).cancelRun({ runId: node.runId ?? node.intendedRunId! });
        },
        deliver: async (flow, message) => {
          assertParent(flow);
          await rpc('chat.inject', { sessionKey: flow.parentKey, message });
        },
      });
      state.notifier = new FlowNotifier(state.store, {
        send: async (flow, message) => {
          if (epoch !== state.generation) throw new Error('Swarm Workflow service stopped.');
          // Reporting a blocker does not admit new work under a changed policy.
          assertParentIdentity(flow);
          await rpc('chat.inject', { sessionKey: flow.parentKey, message });
        },
      });
      const tick = () => {
        if (epoch !== state.generation || !state.engine) return;
        state.pending = state.engine
          .tick()
          .then(() => {
            if (epoch !== state.generation || state.pendingNotice) return;
            // A slow notification must not delay task dispatch or recovery.
            state.pendingNotice = state
              .notifier!.tick()
              .catch(error => ctx.logger.error('[SwarmWorkflow] ' + String(error)))
              .finally(() => {
                if (epoch === state.generation) state.pendingNotice = undefined;
              });
          })
          .catch(error => ctx.logger.error('[SwarmWorkflow] ' + String(error)))
          .finally(() => {
            if (epoch === state.generation) state.timer = setTimeout(tick, 1500);
          });
      };
      tick();
      publishChange();
    },
    async stop() {
      if (ownedGeneration !== state.generation) return;
      ownedGeneration = undefined;
      ++state.generation;
      submissionCalls.clear();
      managementCalls.clear();
      state.startAdmissions.clear();
      state.startTurns.clear();
      resultBudgets.clear();
      clearTimeout(state.timer);
      state.engine?.stop();
      state.notifier?.stop();
      await Promise.all([state.pending, state.pendingNotice, state.engine?.drain()]);
      state.store?.close();
      state.store = undefined;
      state.engine = undefined;
      state.pending = undefined;
      state.notifier = undefined;
      state.pendingNotice = undefined;
      state.timer = undefined;
    },
  });
  api.registerGatewayMethod(
    FLOW_RPC.health,
    ({ respond }) => {
      const configuration = swarmWorkflowSettings(
        api.runtime.config.current().plugins?.entries?.['swarm-workflow']?.config ?? {},
      );
      respond(true, {
        ready: Boolean(state.engine),
        version: 2,
        configuration,
        configurationHash: createHash('sha256').update(JSON.stringify(configuration)).digest('hex'),
        effectiveConcurrency: swarmWorkflowCapacity(api.runtime.config.current(), configuration),
        generation: state.generation,
      });
    },
    { scope: 'operator.read' },
  );
}
