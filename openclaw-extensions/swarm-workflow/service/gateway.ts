import path from 'node:path';
import {
  DEFAULT_FLOW_AGENT,
  FLOW_LIMITS,
  FLOW_RPC,
  type FlowAction,
  viewFlow,
} from '../contracts/flow';
import { isSwarmWorkflowActive } from '../contracts/workflow';
import { managedSubagent } from '../../runtime-services/execution/managed-subagent';
import { permissionFingerprint } from '../../runtime-services/filesystem/admission';
import { interventionAvailability } from '../execution/intervention';
import { parentPolicy } from '../execution/policy';
import { swarmWorkflowSettings } from '../settings';
import { entry, inPlanMode, managed } from './native-context';
import type { StartAdmission } from './state';
import type { WorkflowContext } from './context';

export function registerWorkflowGateway(context: WorkflowContext): void {
  const { api, state, ensure, assertParent, assertParentIdentity, availableAgents } = context;
  api.registerGatewayMethod(
    FLOW_RPC.start,
    async ({ params, respond }) => {
      try {
        managedSubagent(api);
        if (
          !managed(params.parentKey) ||
          typeof params.goal !== 'string' ||
          !params.goal.trim() ||
          params.goal.length > FLOW_LIMITS.goal ||
          (params.concurrency !== undefined &&
            (!Number.isSafeInteger(params.concurrency) ||
              Number(params.concurrency) < 1 ||
              Number(params.concurrency) > 16)) ||
          (params.assignmentRequest !== undefined &&
            (typeof params.assignmentRequest !== 'string' ||
              params.assignmentRequest.length > FLOW_LIMITS.goal)) ||
          typeof params.requestId !== 'string' ||
          !params.requestId ||
          params.requestId.length > 256 ||
          !['auto', 'research', 'review'].includes(String(params.mode))
        )
          throw new Error('Invalid flow request.');
        const parent = entry(params.parentKey);
        if (
          !parent ||
          typeof parent.sessionId !== 'string' ||
          typeof parent.sessionRoot !== 'string' ||
          !path.isAbsolute(parent.sessionRoot) ||
          !['read-only', 'workspace', 'guarded', 'full'].includes(String(parent.permissionMode)) ||
          inPlanMode(parent)
        )
          throw new Error('Parent session is not ready for flow execution.');
        const current = ensure();
        const generation = state.generation;
        const parentSnapshot = {
          id: parent.sessionId,
          cwd: parent.sessionRoot,
          permissionMode: String(parent.permissionMode),
          policy: parentPolicy(parent),
        };
        let admission: StartAdmission | undefined;
        if (params.admission !== undefined) {
          if (typeof params.admission !== 'string') throw new Error('Invalid native admission.');
          admission = state.startAdmissions.get(params.admission);
          state.startAdmissions.delete(params.admission);
          if (
            !admission ||
            admission.parentKey !== params.parentKey ||
            admission.parentId !== parent.sessionId ||
            admission.requestId !== params.requestId ||
            admission.goal !== params.goal ||
            admission.mode !== params.mode ||
            admission.concurrency !== params.concurrency ||
            admission.generation !== state.generation ||
            admission.expiresAt <= Date.now()
          )
            throw new Error('Native flow admission expired or does not match the request.');
          admission.assertCurrent();
        }
        const agents = await availableAgents();
        if (generation !== state.generation)
          throw new Error('Swarm Workflow service changed before flow creation.');
        if (admission && admission.expiresAt <= Date.now())
          throw new Error('Native flow admission expired before flow creation.');
        admission?.assertCurrent();
        if (
          admission?.filesystem &&
          permissionFingerprint(api.runtime.config.current(), admission.filesystem.agentIds) !==
            admission.filesystem.policy
        )
          throw new Error('Native filesystem permissions changed before flow creation.');
        const latestParent = entry(params.parentKey);
        if (
          !latestParent ||
          latestParent.sessionId !== parentSnapshot.id ||
          latestParent.sessionRoot !== parentSnapshot.cwd ||
          latestParent.permissionMode !== parentSnapshot.permissionMode ||
          parentPolicy(latestParent) !== parentSnapshot.policy ||
          inPlanMode(latestParent)
        )
          throw new Error('Parent changed before flow creation.');
        if (!agents.some(agent => agent.id === DEFAULT_FLOW_AGENT))
          throw new Error('The default main agent is unavailable.');
        const result = current.engine.create({
          requestId: params.requestId,
          parentKey: params.parentKey,
          parentId: parentSnapshot.id,
          agentId: params.parentKey.split(':')[1],
          agents,
          cwd: parentSnapshot.cwd,
          permissionMode: parentSnapshot.permissionMode,
          policy: parentSnapshot.policy,
          goal: params.goal,
          assignmentRequest:
            typeof params.assignmentRequest === 'string' ? params.assignmentRequest : params.goal,
          mode: String(params.mode),
          ...(typeof params.concurrency === 'number' ? { concurrency: params.concurrency } : {}),
          settings: swarmWorkflowSettings(
            api.runtime.config.current().plugins?.entries?.['swarm-workflow']?.config,
          ),
          controlVersion: 0,
          ...(admission?.filesystem ? { filesystemAdmission: admission.filesystem } : {}),
        });
        respond(true, viewFlow(result));
      } catch (error) {
        respond(false, undefined, { code: 'swarm_workflow_error', message: String(error) });
      }
    },
    { scope: 'operator.admin' },
  );
  api.registerGatewayMethod(
    FLOW_RPC.list,
    ({ params, respond }) => {
      try {
        if (
          !Array.isArray(params.parentKeys) ||
          params.parentKeys.length > 8 ||
          !params.parentKeys.every(managed)
        )
          throw new Error('Invalid parent identities.');
        const flows = ensure().store.forParents(params.parentKeys as string[]);
        respond(true, {
          flows: flows.slice(0, 20).map(viewFlow),
          running: flows.some(isSwarmWorkflowActive),
        });
      } catch (error) {
        respond(false, undefined, { code: 'swarm_workflow_error', message: String(error) });
      }
    },
    { scope: 'operator.read' },
  );
  api.registerGatewayMethod(
    FLOW_RPC.detail,
    ({ params, respond }) => {
      try {
        if (
          !Array.isArray(params.parentKeys) ||
          !params.parentKeys.length ||
          params.parentKeys.length > 8 ||
          !params.parentKeys.every(managed) ||
          typeof params.id !== 'string' ||
          typeof params.nodeId !== 'string'
        )
          throw new Error('Invalid flow detail request.');
        const flow = ensure().store.get(params.id, params.nodeId);
        if (!flow || !(params.parentKeys as string[]).includes(flow.parentKey))
          throw new Error('Flow does not belong to this conversation.');
        const node = flow.nodes.find(item => item.id === params.nodeId);
        if (!node || (node.kind === 'batch' && params.sourceId === undefined))
          throw new Error('Select a batch item to inspect its execution.');
        if (
          params.sourceId !== undefined &&
          (typeof params.sourceId !== 'string' || !node.deps.includes(params.sourceId))
        )
          throw new Error('Flow dependency was not found.');
        respond(true, {
          flowId: flow.id,
          nodeId: node.id,
          sessionKey: node.kind === 'batch' ? '' : node.sessionKey,
          status: node.status,
          error: node.error,
          workingDirectory: node.batchItem?.workspace ?? flow.cwd,
          revision: flow.revision,
          interventions: node.interventions ?? [],
          ...interventionAvailability(flow, node),
          // Launch envelopes are workflow state, not a second native transcript.
          dispatch: node.dispatch,
          submission:
            node.runId || node.endedAt
              ? 'submitted'
              : node.intendedRunId
                ? 'uncertain'
                : 'not_sent',
        });
      } catch (error) {
        respond(false, undefined, { code: 'swarm_workflow_error', message: String(error) });
      }
    },
    { scope: 'operator.read' },
  );
  api.registerGatewayMethod(
    FLOW_RPC.intervene,
    ({ params, respond }) => {
      try {
        if (
          !Array.isArray(params.parentKeys) ||
          !params.parentKeys.length ||
          params.parentKeys.length > 8 ||
          !params.parentKeys.every(managed) ||
          typeof params.id !== 'string' ||
          typeof params.nodeId !== 'string' ||
          !Number.isSafeInteger(params.revision)
        )
          throw new Error('Invalid intervention request.');
        const { store, engine } = ensure();
        const flow = store.get(params.id);
        if (!flow || !(params.parentKeys as string[]).includes(flow.parentKey))
          throw new Error('Flow does not belong to this conversation.');
        assertParent(flow);
        respond(
          true,
          viewFlow(
            engine.intervene(
              params.id,
              params.nodeId,
              params.revision as number,
              params.intervention,
            ),
          ),
        );
      } catch (error) {
        respond(false, undefined, { code: 'swarm_workflow_error', message: String(error) });
      }
    },
    { scope: 'operator.admin' },
  );
  api.registerGatewayMethod(
    FLOW_RPC.control,
    ({ params, respond }) => {
      try {
        if (
          !Array.isArray(params.parentKeys) ||
          params.parentKeys.length > 8 ||
          !params.parentKeys.every(managed) ||
          typeof params.id !== 'string' ||
          !Number.isSafeInteger(params.revision) ||
          typeof params.action !== 'string' ||
          !['pause', 'resume', 'stop', 'retry'].includes(params.action)
        )
          throw new Error('Invalid flow control.');
        const { store: currentStore, engine: currentEngine } = ensure();
        const flow = currentStore.get(params.id);
        if (!flow || !(params.parentKeys as string[]).includes(flow.parentKey))
          throw new Error('Flow does not belong to this conversation.');
        if (['pause', 'stop'].includes(String(params.action))) assertParentIdentity(flow);
        else assertParent(flow);
        respond(
          true,
          viewFlow(
            currentEngine.control(
              params.id,
              params.revision as number,
              params.action as FlowAction,
            ),
          ),
        );
      } catch (error) {
        respond(false, undefined, { code: 'swarm_workflow_error', message: String(error) });
      }
    },
    { scope: 'operator.admin' },
  );
}
