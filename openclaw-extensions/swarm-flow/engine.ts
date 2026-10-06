import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';

import type { BatchManifest, ItemResultManifest } from './batch-contract.js';
import { BATCH_LIMITS } from './batch-contract.js';
import { itemWorkspace } from './batch-snapshot.js';
import {
  DEFAULT_FLOW_AGENT,
  type Flow,
  FLOW_LIMITS,
  type FlowAction,
  type FlowNode,
  type FlowSubmission,
} from './contract.js';
import { interventionAvailability, resetFailedNode, validateIntervention } from './intervention.js';
import {
  parseJson,
  PlanFormatError,
  planningInstructions,
  validatePlan,
  validateStageAssignments,
  verdict,
} from './plan.js';
import { swarmSettings } from './settings.js';
import { NativeLaunchNotInvokedError } from './native-execution.js';
import type { FlowStore } from './store.js';
import {
  submissionCorrectionInstructions,
  submissionInstructions,
  validateSubmission,
} from './submission.js';
export interface FlowHost {
  capacity?(): number;
  assertAdmission?(flow: Flow): void;
  freezeBatch?(
    flow: Flow,
    node: FlowNode,
    assertCurrent: () => void,
  ): Promise<{ manifest: BatchManifest; manifestPath: string }>;
  verifyResult?(flow: Flow, node: FlowNode, assertCurrent: () => void): Promise<void>;
  prepare(flow: Flow, node: FlowNode): Promise<void>;
  launch(
    flow: Flow,
    node: FlowNode,
    message: string,
    assertCurrent: () => void,
  ): Promise<{ runId: string; sessionKey?: string }>;
  wait(runId: string): Promise<{
    status: string;
    endedAt?: number;
    error?: string;
    stopReason?: string;
    yielded?: boolean;
    pendingError?: boolean;
    livenessState?: string;
    terminalReply?: { disposition: string; text?: string };
    executionSettled?: boolean;
    cleanupSettled?: boolean;
    executionStartedAt?: number;
    unknown?: boolean;
  }>;
  cancel(node: FlowNode): Promise<void>;
  correctionInstruction?(flow: Flow, node: FlowNode): Promise<string>;
  deliver(flow: Flow, text: string): Promise<void>;
}
const live = (n: FlowNode) =>
  n.kind !== 'batch' && ['preparing', 'running', 'uncertain'].includes(n.status);
const projectIdentity = (cwd: string) => {
  let resolved = path.resolve(cwd);
  try {
    resolved = realpathSync.native(resolved);
  } catch {
    // Admission will report a missing project; retain its normalized lock identity.
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};
export class FlowEngine {
  private enabled = true;
  private ticking = false;
  private freezes = new Map<string, Promise<void>>();
  private jobs = new Map<string, Promise<void>>();
  constructor(
    readonly store: FlowStore,
    readonly host: FlowHost,
  ) {
    // A persisted receipt proves acceptance, not continued liveness after restart.
    for (const flow of store.all()) {
      if (
        flow.nodes.some(
          node => node.kind !== 'batch' && ['running', 'preparing'].includes(node.status),
        )
      ) {
        for (const node of flow.nodes) {
          if (node.kind === 'batch') continue;
          if (node.status === 'running') node.status = 'uncertain';
          else if (node.status === 'preparing' && !node.runId && !node.intendedRunId)
            node.status = 'queued';
        }
        store.put(flow);
      }
      for (const node of flow.nodes.filter(
        node => node.kind === 'batch' && node.status === 'preparing' && !node.batchInput,
      )) {
        node.status = 'queued';
        store.put(flow);
      }
    }
  }
  stop(): void {
    this.enabled = false;
  }
  async drain(): Promise<void> {
    await Promise.allSettled([...this.freezes.values(), ...this.jobs.values()]);
  }
  create(
    input: Omit<Flow, 'id' | 'revision' | 'createdAt' | 'updatedAt' | 'status' | 'nodes'>,
  ): Flow {
    const prior = this.store.all().find(f => f.requestId === input.requestId);
    if (prior) {
      if (
        prior.parentKey !== input.parentKey ||
        prior.goal !== input.goal ||
        prior.concurrency !== input.concurrency
      )
        throw new Error('Request identity conflict.');
      return prior;
    }
    if (
      this.store
        .all()
        .some(
          f => f.parentKey === input.parentKey && !['completed', 'cancelled'].includes(f.status),
        )
    )
      throw new Error('This conversation already has an unfinished flow.');
    const id = randomUUID();
    const now = Date.now();
    const flow: Flow = {
      ...input,
      id,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      status: 'running',
      nodes: [],
    };
    flow.nodes.push(this.node(flow, 'plan', 'plan', 'Plan', input.goal, []));
    if (flow.settings) this.prompt(flow, flow.nodes[0]);
    this.store.insert(flow);
    return flow;
  }
  private node(
    flow: Flow,
    id: string,
    kind: FlowNode['kind'],
    title: string,
    task: string,
    deps: string[],
    access: FlowNode['access'] = 'read',
    agentId = DEFAULT_FLOW_AGENT,
  ): FlowNode {
    return {
      id,
      kind,
      title,
      task,
      deps,
      access,
      status: 'queued',
      attempt: 1,
      ...(kind === 'work' || kind === 'verify' ? { completionMode: 'tool' as const } : {}),
      agentId,
      agentName: flow.agents.find(agent => agent.id === agentId)?.name ?? agentId,
      sessionKey: `agent:${agentId}:subagent:swarm-flow-${flow.id}-${id}`,
    };
  }
  submissionOwner(sessionKey: string, runId: string) {
    if (!this.enabled) throw new Error('Swarm service is unavailable.');
    const owner = this.store.batches.owner(sessionKey, runId);
    const flow = owner
      ? this.store.get(owner.flowId, owner.nodeId)
      : this.store.all().find(item => item.nodes.some(node => node.sessionKey === sessionKey));
    const node = flow?.nodes.find(item => item.sessionKey === sessionKey);
    if (
      !flow ||
      !node ||
      !['running', 'paused', 'blocked'].includes(flow.status) ||
      !live(node) ||
      !runId ||
      runId !== (node.runId ?? node.intendedRunId) ||
      !['work', 'verify'].includes(node.kind) ||
      !node.deps.every(dep => flow.nodes.find(item => item.id === dep)?.status === 'done')
    )
      throw new Error('Submission does not own an active Swarm node/run.');
    return { flow, node };
  }
  submit(
    sessionKey: string,
    runId: string,
    submission: FlowSubmission,
    artifacts?: ItemResultManifest,
  ): { accepted: true } {
    const { flow, node } = this.submissionOwner(sessionKey, runId);
    const { outcome, ...fields } = submission;
    submission = validateSubmission(outcome, fields);
    if (
      flow.settings &&
      submission.outcome === 'verified' &&
      Buffer.byteLength(JSON.stringify(submission)) > 4096
    )
      throw new Error(
        'Verification receipt exceeds 4 KiB. Keep a concise verdict and compact deliverable references; store detailed findings in an artifact.',
      );
    if (
      (submission.outcome === 'verified' && node.kind !== 'verify') ||
      (submission.outcome === 'complete' && node.kind !== 'work')
    )
      throw new Error('This submission is not allowed for the assigned stage.');
    if (node.completion) {
      const { createdAt: _time, runId: _run, ...prior } = node.completion;
      if (JSON.stringify(prior) !== JSON.stringify(submission))
        throw new Error('A different terminal submission already exists. Do not overwrite it.');
      return { accepted: true };
    }
    node.completion = { ...submission, runId, createdAt: Date.now() };
    if (node.batchItem && submission.outcome === 'complete') {
      if (!artifacts || artifacts.runId !== runId || artifacts.itemId !== node.id)
        throw new Error('A batch result requires verified artifact references.');
      node.artifacts = artifacts;
    }
    if (
      submission.outcome === 'blocked' ||
      (submission.outcome === 'verified' && !submission.passed)
    )
      if (!node.batchItem) flow.status = 'blocked';
    this.store.put(flow);
    return { accepted: true };
  }
  requireSubmissionCorrection(sessionKey: string, runId: string, instruction?: string): boolean {
    const { flow, node } = this.submissionOwner(sessionKey, runId);
    if (node.completion || node.completionMode !== 'tool') return false;
    if (!node.submissionRepair) {
      node.submissionRepair = {
        runId,
        passes: 0,
        instruction:
          instruction ?? submissionCorrectionInstructions(node.kind as 'work' | 'verify'),
        priorRuns: [],
      };
      this.store.put(flow);
    } else if (instruction && node.submissionRepair.instruction !== instruction) {
      node.submissionRepair.instruction = instruction;
      this.store.put(flow);
    }
    return true;
  }
  control(id: string, revision: number, action: FlowAction, operationId?: string): Flow {
    if (!this.enabled) throw new Error('Swarm service is unavailable.');
    if (!['pause', 'resume', 'stop', 'retry'].includes(action))
      throw new Error('Invalid flow control action.');
    const flow = this.store.get(id);
    if (flow && operationId && flow.operations?.some(item => item.id === operationId)) {
      if (flow.operations.find(item => item.id === operationId)?.action !== action)
        throw new Error('Flow operation identity conflict.');
      return flow;
    }
    if (!flow || flow.revision !== revision) throw new Error('Flow revision conflict.');
    if (operationId && (flow.operations?.length ?? 0) >= FLOW_LIMITS.operations)
      throw new Error('Flow operation limit reached. Use the Swarm tab to manage this flow.');
    if (['completed', 'cancelled'].includes(flow.status)) throw new Error('Flow has ended.');
    if (flow.status === 'running' && flow.deliveryIntent && !flow.delivered)
      throw new Error('Final delivery is already in progress and cannot be interrupted.');
    if (action === 'pause') {
      if (flow.status !== 'running') throw new Error('Only a running flow can be paused.');
      flow.status = 'paused';
    } else if (action === 'retry') {
      this.store.batches.loadFailed(flow);
      const failed = flow.nodes.filter(
        node => node.status === 'failed' && (node.kind !== 'batch' || !node.batchInput),
      );
      if (
        flow.status !== 'blocked' ||
        !failed.length ||
        flow.error ||
        flow.deliveryIntent ||
        flow.nodes.some(live)
      )
        throw new Error(
          'Only conclusive failed nodes can be retried after all native runs have settled.',
        );
      if (
        failed.some(
          node => (node.attempt ?? 1) >= (flow.settings?.maxAttempts ?? FLOW_LIMITS.attempts),
        )
      )
        throw new Error('Retry limit reached. Inspect the failed task or start a new flow.');
      for (const node of failed) {
        resetFailedNode(flow, node);
      }
      flow.status = 'running';
    } else if (action === 'stop') flow.status = 'stopping';
    else {
      if (
        flow.status !== 'paused' ||
        flow.nodes.some(
          n =>
            n.kind !== 'batch' &&
            !n.batchItem &&
            (n.status === 'failed' || n.status === 'uncertain'),
        )
      )
        throw new Error('Resolve failed or uncertain work before resuming.');
      flow.status = 'running';
    }
    if (operationId) flow.operations = [...(flow.operations ?? []), { id: operationId, action }];
    flow.controlVersion = (flow.controlVersion ?? 0) + 1;
    this.store.put(flow);
    return flow;
  }
  intervene(id: string, nodeId: string, revision: number, input: unknown): Flow {
    if (!this.enabled) throw new Error('Swarm service is unavailable.');
    const request = validateIntervention(input);
    const flow = this.store.get(id, nodeId);
    const node = flow?.nodes.find(n => n.id === nodeId);
    if (!flow || !node) throw new Error('Flow node was not found.');
    // A lost response may be retried after execution has advanced or the flow ended.
    const owner = this.store.batches.interventionOwner(flow.id, request.id);
    const prior =
      owner?.note ?? flow.nodes.flatMap(n => n.interventions ?? []).find(n => n.id === request.id);
    if (prior) {
      if (
        (owner ? owner.nodeId !== nodeId : !node.interventions?.includes(prior)) ||
        prior.action !== request.action ||
        prior.text !== request.text
      )
        throw new Error('Intervention identity conflict.');
      return flow;
    }
    if (flow.revision !== revision) throw new Error('Flow revision conflict.');
    const availability = interventionAvailability(flow, node);
    if (
      !availability.canNote ||
      (request.action === 'continue' && !availability.canContinue) ||
      (request.action === 'retry' && !availability.canRetry)
    )
      throw new Error('This node cannot accept the requested intervention.');
    node.interventions = [...(node.interventions ?? []), request];
    if (request.action !== 'note') {
      resetFailedNode(flow, node, request.action === 'continue');
      if (!node.batchItem || flow.status !== 'paused') flow.status = 'running';
    }
    flow.controlVersion = (flow.controlVersion ?? 0) + 1;
    this.store.put(flow);
    return flow;
  }
  retryBatch(
    id: string,
    stageId: string,
    revision: number,
    operationId: string,
    itemIds?: string[],
  ) {
    if (
      !this.enabled ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(operationId) ||
      (itemIds !== undefined &&
        (!Array.isArray(itemIds) ||
          !itemIds.length ||
          itemIds.length > 100 ||
          new Set(itemIds).size !== itemIds.length ||
          itemIds.some(id => typeof id !== 'string' || !id || id.length > 80)))
    )
      throw new Error('Invalid batch retry request.');
    const flow = this.store.get(id);
    if (!flow?.nodes.some(node => node.id === stageId && node.kind === 'batch' && node.batchInput))
      throw new Error('Batch not found.');
    const fingerprint = JSON.stringify([stageId, itemIds ? [...itemIds].sort() : null]);
    const prior = flow.batchOperations?.find(operation => operation.id === operationId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error('Batch operation identity conflict.');
      return { retried: prior.retried, skipped: prior.skipped, reasons: prior.reasons };
    }
    if (flow.revision !== revision) throw new Error('Flow revision conflict.');
    if ((flow.batchOperations?.length ?? 0) >= 128)
      throw new Error('Batch operation limit reached.');
    this.host.assertAdmission?.(flow);
    this.store.batches.loadFailed(flow, stageId, itemIds);
    const retried: string[] = [];
    const skipped = new Set(itemIds ?? []);
    const reasons: Record<string, string> = Object.fromEntries(
      (itemIds ?? []).map(id => [id, 'Item is not a failed member of this batch.']),
    );
    for (const node of flow.nodes.filter(
      node =>
        node.batchItem?.stageId === stageId &&
        node.status === 'failed' &&
        (!itemIds || itemIds.includes(node.id)),
    )) {
      if (!interventionAvailability(flow, node).canRetry) {
        skipped.add(node.id);
        reasons[node.id] = !node.cleanupSettled
          ? 'Native execution cleanup is not confirmed.'
          : (node.attempt ?? 1) >= (flow.settings?.maxAttempts ?? FLOW_LIMITS.attempts)
            ? 'Attempt limit reached.'
            : !node.deps.every(dep => flow.nodes.find(node => node.id === dep)?.status === 'done')
              ? 'Dependencies are incomplete.'
              : 'Flow controls or intervention limits do not currently allow retry.';
        continue;
      }
      resetFailedNode(flow, node);
      retried.push(node.id);
      skipped.delete(node.id);
      delete reasons[node.id];
    }
    if (retried.length && flow.status === 'blocked') flow.status = 'running';
    flow.batchOperations = [
      ...(flow.batchOperations ?? []),
      { id: operationId, fingerprint, retried, skipped: [...skipped], reasons },
    ];
    flow.controlVersion = (flow.controlVersion ?? 0) + 1;
    this.store.put(flow);
    return { retried, skipped: [...skipped], reasons };
  }
  private prompt(flow: Flow, node: FlowNode): string {
    const inputIds =
      node.kind === 'verify' || node.kind === 'deliver'
        ? flow.nodes
            .filter(
              n =>
                !n.batchItem &&
                (['work', 'batch'].includes(n.kind) ||
                  (node.kind === 'deliver' && n.kind === 'verify')),
            )
            .map(n => n.id)
        : node.deps;
    const inputs = inputIds.map(id => {
      const n = flow.nodes.find(n => n.id === id)!;
      const compact =
        flow.settings && n.kind !== 'batch' && (node.kind !== 'deliver' || n.kind !== 'verify');
      return {
        id,
        ...(compact
          ? {
              summaryPreview: n.completion?.summary.slice(0, 512),
              resultReference: {
                nodeId: id,
                instruction:
                  'Read the full accepted result using swarm_flow_results(nodeId, cursor). Follow every page before relying on it.',
              },
            }
          : { result: n.result }),
        ...(n.kind === 'batch'
          ? {
              batch: {
                stageId: n.id,
                manifestVersion: n.batchInput?.version,
                counts: n.batchCounts,
                instruction:
                  node.kind === 'deliver'
                    ? 'Batch coverage and artifacts have passed the independent verification gate. Use its verdict and deliverable references.'
                    : 'Use swarm_flow_results(stageId, cursor) to read the paged accepted result index; follow cursor until absent. Consume each page before requesting the next; earlier pages may leave the model context. For write tasks persist a compact intermediate index or partial aggregate, then finalize after checking complete coverage. Verification must remain read-only and inspect each page as it arrives. Inspect actual artifact files before aggregation or verification. Every item must have succeeded; missing or changed files must fail verification.',
              },
            }
          : {}),
      };
    });
    const instruction =
      node.kind === 'plan'
        ? planningInstructions(Boolean(flow.filesystemAdmission))
        : node.kind === 'verify'
          ? 'Independently inspect every work result against the goal, using read-only evidence. Submit the verdict using swarm_flow_verify(passed, summary, evidence), then end this turn. Do not use final-reply JSON as a substitute for the tool. Set passed=true only if the original goal and acceptance criteria are satisfied with concrete evidence. A missing target project, missing implementation or unmet prerequisite must set passed=false even if workers honestly reported that limitation. Missing or unverifiable evidence must fail. Never perform implementation. Use swarm_flow_block(summary, evidence) if external input is required. Once a terminal submission is accepted, do no more work; a short natural-language final reply is optional.'
          : node.kind === 'deliver'
            ? 'Produce the final user-facing answer in the language of the goal, using verified results. Include deliverables and limitations. Do not perform additional work.'
            : 'Execute only this assigned task within the user goal. Call swarm_flow_complete(summary, evidence) with deliverable references and remaining limitations before ending the turn. If you cannot satisfy the task because of a missing prerequisite or external input, call swarm_flow_block(summary, evidence) instead; never claim success for an unmet goal. Once a submission is accepted, do no more work. A short natural-language final reply is optional. Do not delegate extra workers, send a final reply to the user, or broaden scope.';
    const message = JSON.stringify({
      goal: flow.goal,
      ...(node.kind === 'plan'
        ? { availableAgents: flow.agents, assignmentRequest: flow.assignmentRequest ?? flow.goal }
        : {}),
      strategy:
        flow.mode === 'research'
          ? 'Parallel research; all business materials remain read-only. Only batch items may write their assigned output/ report artifacts, when the user goal and native permissions allow. An explicit ban on all file creation requires blocking the batch item.'
          : flow.mode === 'review'
            ? 'Independent review from different perspectives; all business materials remain read-only. Only batch items may write their assigned output/ report artifacts, when the user goal and native permissions allow. An explicit ban on all file creation requires blocking the batch item.'
            : 'Choose dependencies and parallelism appropriate to the goal.',
      assignedTask:
        node.kind === 'plan' || node.kind === 'verify' || node.kind === 'deliver'
          ? 'Follow the goal and stage instruction.'
          : node.task,
      access: node.access,
      accessInstruction:
        node.access === 'read'
          ? node.batchItem
            ? "This is an inspection task. Read the assigned inputs without modifying them. You may write only this assigned item's report artifacts under output/; do not modify input.json, input/, original project data, source files, configuration, repository state or any other item. Do not run tests or commands that write outside output/. This narrow report exception does not override the user goal or native session permissions. If the user explicitly forbids all file creation or native permissions do not allow these report artifacts, call swarm_flow_block instead of creating them."
            : 'This is an inspection task. Do not modify source files, configuration, repository state or user data. Native session permission governs which tools you may invoke; read-only task intent is not permission to mutate through shell commands. Tests that create files require a write task.'
          : 'Perform only modifications explicitly authorized by the goal and this assigned task; native session permissions remain the upper bound.',
      inputs,
      ...(node.batchItem
        ? {
            batchItem: {
              id: node.batchItem.key,
              manifestVersion: node.batchItem.manifestVersion,
              input: 'input.json',
              output: 'output/',
              executionBudgetSeconds: (flow.settings ?? swarmSettings({})).executionTimeoutSeconds,
              instruction:
                'The service has already expanded the batch. Read input.json and its pinned input files. Process ONLY this item; do not expand the manifest, launch workers or aggregate other items. ' +
                (node.access === 'read'
                  ? 'Business materials remain read-only; write only report artifacts under output/ if the user goal and native permissions allow. If all file creation is forbidden, call swarm_flow_block instead. '
                  : 'Write deliverables under output/. ') +
                'For long commands explicitly set a supported exec timeout within the execution budget, or use managed background execution and poll until completion. Do not detach unmanaged processes or submit while calculation is still running. Submit a summary of at most 512 characters and evidence as 1-16 exact output file paths. Do not modify original project data or any other item. This is cooperative isolation within the parent permissions.',
            },
          }
        : {}),
      ...(node.kind === 'plan' && flow.filesystemAdmission
        ? {
            batchPlanning:
              'For many inputs sharing one task template, declare one batch object at the task top level, with source.kind/source.path and optional files pattern. JSONL rows are {id,title?,data?,files?:[project-relative paths]}. The service freezes and expands the manifest after its prerequisites succeed. The source must be an existing authorized project input or an exact path generated by a declared preparation prerequisite. Do not invent data, enumerate 100 model-generated task IDs or leave expansion to a worker. Use batch:null for preparation and aggregation tasks.',
          }
        : {}),
      ...(node.kind === 'plan' && node.planningRepair
        ? {
            planningCorrection: {
              round: node.planningRepair.passes,
              maximumRounds: FLOW_LIMITS.planningRepairs,
              error: node.planningRepair.error,
              instruction:
                'The previous plan was rejected before any work was scheduled. Correct the reported structure and return the entire valid JSON plan. Preserve the goal, dependencies, permission constraints and explicit assistant assignments. Do not execute work or submit task results.',
            },
          }
        : {}),
      ...(node.attempts?.length
        ? {
            priorAttempts: node.attempts.map(attempt => ({
              attempt: attempt.attempt,
              status: attempt.status,
              error: attempt.error,
              submission: attempt.receipt,
            })),
          }
        : {}),
      ...(node.interventions?.length ? { humanInput: node.interventions } : {}),
      ...(node.continuation
        ? {
            continuationInstruction:
              'The user supplied input and explicitly resumed this same node session. Continue from the existing conversation and current project state. Inspect prior attempts and humanInput; do not blindly repeat completed actions. Resolve the blocker within the original task, access intent and permission ceiling. Submit a new result for this run; prior submissions do not complete it.',
          }
        : {}),
      instruction:
        instruction +
        (node.kind === 'work' || node.kind === 'verify'
          ? ' ' + submissionInstructions(node.kind)
          : ''),
    });
    if (flow.settings && Buffer.byteLength(message) > BATCH_LIMITS.envelopeBytes)
      throw new Error(
        'Stage input exceeds 24 KiB. Shorten the complete brief, task template or intervention; keep all required constraints. Large results belong in artifact files and the paged result index.',
      );
    return message;
  }
  async tick(): Promise<void> {
    if (!this.enabled || this.ticking) return;
    this.ticking = true;
    try {
      for (const entry of this.store.all()) {
        if (!this.enabled) break;
        if (['completed', 'cancelled'].includes(entry.status)) continue;
        await this.advance(entry.id, true, false);
      }
      // Reconcile every occupied slot before granting one turn per flow. The
      // persisted cursor also prevents newest-first starvation after restart.
      let progressed = true;
      while (
        this.enabled &&
        progressed &&
        this.store.batches.occupiedCount() < (this.host.capacity?.() ?? FLOW_LIMITS.parallel)
      ) {
        progressed = false;
        const flows = this.store.all().filter(flow => flow.status === 'running');
        const cursor = flows.findIndex(flow => flow.id === this.store.batches.cursor());
        const ordered = [...flows.slice(cursor + 1), ...flows.slice(0, cursor + 1)];
        for (const entry of ordered) {
          if (
            !this.enabled ||
            this.store.batches.occupiedCount() >= (this.host.capacity?.() ?? FLOW_LIMITS.parallel)
          )
            break;
          const before = entry.revision;
          await this.advance(entry.id, false, true);
          if (this.store.get(entry.id)?.revision !== before) {
            progressed = true;
            this.store.batches.setCursor(entry.id);
          }
        }
      }
    } finally {
      this.ticking = false;
    }
  }
  private async advance(id: string, reconcile = true, dispatch = true): Promise<void> {
    let flow = this.store.get(id)!;
    for (const original of reconcile ? flow.nodes.filter(live) : []) {
      if (!this.enabled) return;
      flow = this.store.get(id, original.id)!;
      const node = flow.nodes.find(n => n.id === original.id)!;
      if (this.jobs.has(id + ':' + node.id)) continue;
      if (flow.status === 'stopping') {
        try {
          await this.host.cancel(node);
        } catch {
          /* Remain stopping until terminal evidence. */
        }
      }
      if (!node.runId && !node.intendedRunId) {
        if (flow.status === 'stopping') {
          node.status = 'cancelled';
          this.store.put(flow);
          continue;
        }
        node.status = 'uncertain';
        flow.status = 'blocked';
        node.error = 'Launch outcome unavailable; no automatic retry.';
        this.store.put(flow);
        continue;
      }
      let result: Awaited<ReturnType<FlowHost['wait']>>;
      try {
        result = await this.host.wait(node.runId ?? node.intendedRunId!);
      } catch {
        continue;
      }
      if (!this.enabled) return;
      flow = this.store.get(id, node.id)!;
      let current = flow.nodes.find(n => n.id === node.id)!;
      if (
        current.sessionKey !== node.sessionKey ||
        current.attempt !== node.attempt ||
        (current.runId ?? current.intendedRunId) !== (node.runId ?? node.intendedRunId)
      )
        continue;
      if (result.executionStartedAt && !current.deadlineAt) {
        current.startedAt = result.executionStartedAt;
        current.deadlineAt =
          result.executionStartedAt +
          (flow.settings?.executionTimeoutSeconds ?? swarmSettings({}).executionTimeoutSeconds) *
            1000;
        this.store.put(flow);
      }
      const endedWithinBudget =
        result.executionSettled === true &&
        Boolean(result.endedAt && current.deadlineAt && result.endedAt <= current.deadlineAt);
      if (
        current.deadlineAt &&
        Date.now() >= current.deadlineAt &&
        !endedWithinBudget &&
        !current.budgetExceeded
      ) {
        current.budgetExceeded = true;
        current.error =
          'Attempt execution budget exhausted; waiting for native cancellation and cleanup.';
        if (!current.batchItem && flow.status !== 'stopping') flow.status = 'blocked';
        this.store.put(flow);
      }
      if (current.budgetExceeded && result.cleanupSettled !== true) {
        try {
          await this.host.cancel(current);
        } catch {
          /* Retain the occupied lease until authoritative cleanup. */
        }
      }
      const yielded =
        result.status === 'ok' && (result.yielded === true || result.livenessState === 'paused');
      if (
        !result.endedAt ||
        result.status === 'pending' ||
        result.pendingError ||
        yielded ||
        (flow.settings || current.batchItem
          ? result.executionSettled !== true || result.cleanupSettled !== true
          : result.executionSettled === false || result.cleanupSettled === false)
      ) {
        if (yielded && flow.status !== 'stopping') {
          current.status = 'uncertain';
          current.error = 'Native execution yielded; waiting for a conclusive result.';
          if (!current.batchItem) flow.status = 'blocked';
          this.store.put(flow);
          continue;
        }
        if (
          !flow.settings &&
          !current.batchItem &&
          !current.deadlineAt &&
          Date.now() - (current.startedAt ?? flow.createdAt) > FLOW_LIMITS.durationMs &&
          flow.status !== 'stopping'
        ) {
          flow.status = 'blocked';
          current.error = 'Run deadline exceeded; inspect or stop the native run.';
          this.store.put(flow);
        }
        continue;
      }
      current.endedAt = result.endedAt;
      current.cleanupSettled = result.cleanupSettled;
      if (flow.status === 'stopping') current.status = 'cancelled';
      // Native wait normalizes execution failures. Successful provider stop reasons
      // include both "stop" and "end_turn" and are not cancellation evidence.
      else if (result.status !== 'ok' || current.budgetExceeded) {
        current.status = 'failed';
        current.error = result.error || result.stopReason || 'Native run failed.';
        if (!current.batchItem) flow.status = 'blocked';
      } else {
        try {
          const text =
            result.terminalReply?.disposition === 'visible' ? result.terminalReply.text : undefined;
          const toolCompletion =
            ['work', 'verify'].includes(current.kind) &&
            (current.completionMode === 'tool' || current.completion !== undefined);
          if (toolCompletion) {
            let receipt = current.completion;
            let repair = current.submissionRepair;
            if (
              !receipt &&
              current.completionMode === 'tool' &&
              (repair?.passes ?? 0) < FLOW_LIMITS.submissionRepairs
            ) {
              const sessionKey = current.sessionKey;
              const runId = current.runId ?? current.intendedRunId!;
              let instruction: string | undefined;
              let preparationFailed = false;
              let preparationError: unknown;
              try {
                instruction = await this.host.correctionInstruction?.(flow, current);
              } catch (error) {
                preparationFailed = true;
                preparationError = error;
              }
              if (!this.enabled) return;
              flow = this.store.get(id, node.id)!;
              current = flow.nodes.find(n => n.id === node.id)!;
              current.endedAt = result.endedAt;
              if (flow.status === 'stopping') {
                current.status = 'cancelled';
                this.store.put(flow);
                continue;
              }
              if (
                !live(current) ||
                sessionKey !== current.sessionKey ||
                runId !== (current.runId ?? current.intendedRunId)
              )
                continue;
              if (preparationFailed) throw preparationError;
              // A native isolated finalization may skip all finalize hooks.
              // Revalidate the owned run after the on-demand history read.
              this.requireSubmissionCorrection(sessionKey, runId, instruction);
              flow = this.store.get(id, node.id)!;
              current = flow.nodes.find(n => n.id === node.id)!;
              current.endedAt = result.endedAt;
              receipt = current.completion;
              repair = current.submissionRepair;
            }
            if (
              !receipt &&
              repair &&
              repair.runId === (current.runId ?? current.intendedRunId) &&
              repair.passes < FLOW_LIMITS.submissionRepairs
            ) {
              repair.priorRuns.push({ runId: repair.runId, endedAt: result.endedAt });
              repair.pending = true;
              current.status = 'queued';
              delete current.runId;
              delete current.intendedRunId;
              delete current.endedAt;
              this.store.put(flow);
              continue;
            }
            if (!receipt || receipt.runId !== (current.runId ?? current.intendedRunId))
              throw new Error(
                'Native run ended without an accepted task submission. ' +
                  (repair?.passes === FLOW_LIMITS.submissionRepairs
                    ? 'Submission correction limit reached; inspect or retry the failed node.'
                    : 'Inspect or retry the failed node.'),
              );
            current.result = JSON.stringify({
              summary: receipt.summary,
              evidence: receipt.evidence,
              ...(receipt.outcome === 'verified' ? { passed: receipt.passed } : {}),
            });
            if (
              receipt.outcome === 'blocked' ||
              (receipt.outcome === 'verified' && !receipt.passed)
            )
              throw new Error('Task requires attention: ' + receipt.summary);
          } else if (!text?.trim() || (current.kind !== 'plan' && text.length > FLOW_LIMITS.result))
            throw new Error('Missing or oversized terminal result.');
          if (current.kind === 'plan') {
            const parsed = parseJson(text!);
            const tasks = validatePlan(parsed, flow.agents, flow.assignmentRequest ?? flow.goal, {
              batchAvailable: Boolean(flow.filesystemAdmission),
            });
            const stages = validateStageAssignments(
              parsed,
              flow.agents,
              flow.assignmentRequest ?? flow.goal,
            );
            if (flow.mode !== 'auto' && tasks.some(task => task.access !== 'read'))
              throw new Error('Research and review flows cannot schedule write tasks.');
            const work = tasks.map(t => ({
              ...this.node(
                flow,
                t.id,
                t.batch ? 'batch' : 'work',
                t.title,
                t.task,
                t.deps.length ? t.deps : ['plan'],
                t.access,
                t.agentId,
              ),
              ...(t.batch ? { batch: t.batch, sessionKey: '' } : {}),
            }));
            flow.nodes.push(
              ...work,
              this.node(
                flow,
                'verify',
                'verify',
                'Verify',
                flow.goal,
                work.filter(n => !work.some(other => other.deps.includes(n.id))).map(n => n.id),
                'read',
                stages.verify,
              ),
              this.node(
                flow,
                'deliver',
                'deliver',
                'Deliver',
                flow.goal,
                ['verify'],
                'read',
                stages.deliver,
              ),
            );
          }
          if (current.kind === 'verify' && !toolCompletion && !verdict(text!).passed)
            throw new Error('Independent verification failed: ' + verdict(text!).summary);
          if (!toolCompletion) current.result = text;
          if (current.batchItem) {
            const publicationFlow = flow;
            const publicationNode = current;
            const exactRun = current.runId ?? current.intendedRunId;
            const assertPublication = () => {
              const latest = this.store.get(id, current.id)!;
              const item = latest.nodes.find(candidate => candidate.id === current.id);
              if (
                !this.enabled ||
                !item ||
                latest.status === 'stopping' ||
                item.sessionKey !== current.sessionKey ||
                (item.runId ?? item.intendedRunId) !== exactRun ||
                item.attempt !== current.attempt
              )
                throw new Error('Batch result publication revoked.');
              this.host.assertAdmission?.(latest);
            };
            const key = id + ':' + node.id;
            this.store.put(flow);
            const pending = Promise.resolve().then(async () => {
              try {
                if (!this.host.verifyResult)
                  throw new Error('Native batch result verification is unavailable.');
                await this.host.verifyResult(publicationFlow, publicationNode, assertPublication);
                assertPublication();
                const latest = this.store.get(id, node.id)!;
                const item = latest.nodes.find(candidate => candidate.id === node.id)!;
                item.status = 'done';
                delete item.error;
                item.result = JSON.stringify({
                  summary: item.completion!.summary,
                  evidence: item.completion!.evidence,
                });
                this.store.put(latest);
              } catch (error) {
                const latest = this.store.get(id, node.id)!;
                const item = latest.nodes.find(candidate => candidate.id === node.id)!;
                if (
                  item.sessionKey !== publicationNode.sessionKey ||
                  item.attempt !== publicationNode.attempt ||
                  (item.runId ?? item.intendedRunId) !== exactRun
                )
                  return;
                item.status =
                  latest.status === 'stopping'
                    ? 'cancelled'
                    : this.enabled
                      ? 'failed'
                      : 'uncertain';
                item.error = String(error);
                this.store.put(latest);
              } finally {
                this.jobs.delete(key);
              }
            });
            this.jobs.set(key, pending);
            void pending.catch(() => {
              /* A persistence failure leaves the durable lease for reconciliation. */
            });
            continue;
          }
          current.status = 'done';
          delete current.error;
        } catch (error) {
          if (!this.enabled) return;
          const expectedRun = current.runId ?? current.intendedRunId;
          flow = this.store.get(id, node.id)!;
          const latest = flow.nodes.find(item => item.id === node.id)!;
          if (
            latest.sessionKey !== current.sessionKey ||
            latest.attempt !== current.attempt ||
            (latest.runId ?? latest.intendedRunId) !== expectedRun
          )
            continue;
          current = latest;
          current.endedAt = result.endedAt;
          current.cleanupSettled = result.cleanupSettled;
          if (flow.status === 'stopping') {
            current.status = 'cancelled';
            this.store.put(flow);
            continue;
          }
          if (current.kind === 'plan' && error instanceof PlanFormatError) {
            const passes = current.planningRepair?.passes ?? 0;
            if (passes < FLOW_LIMITS.planningRepairs) {
              current.planningRepair = { passes: passes + 1, error: String(error).slice(0, 1000) };
              current.status = 'queued';
              delete current.runId;
              delete current.intendedRunId;
              delete current.endedAt;
              delete current.cleanupSettled;
              delete current.error;
              this.store.put(flow);
              continue;
            }
            error = new Error('Planning correction limit reached after 3 rounds: ' + String(error));
          }
          current.status = 'failed';
          current.error = String(error);
          if (!current.batchItem) flow.status = 'blocked';
        }
      }
      this.store.put(flow);
    }
    flow = this.store.get(id)!;
    // A lost receipt or delayed result can become conclusive without replaying
    // the run. Once every blocker has cleared, expose the existing resume action
    // rather than leaving known-successful work permanently blocked.
    if (
      flow.status === 'blocked' &&
      !flow.error &&
      !flow.deliveryIntent &&
      flow.nodes.every(n => !n.error && !['failed', 'uncertain', 'preparing'].includes(n.status))
    ) {
      flow.status = 'paused';
      this.store.put(flow);
    }
    if (flow.status === 'stopping') {
      if (
        !flow.nodes.some(live) &&
        ![...this.freezes.keys()].some(key => key.startsWith(id + ':'))
      ) {
        for (const n of flow.nodes) if (n.status === 'queued') n.status = 'cancelled';
        flow.status = 'cancelled';
        this.store.put(flow);
      }
      return;
    }
    if (flow.status !== 'running' || !this.enabled) return;
    if (
      flow.nodes.some(n => n.status === 'failed') &&
      !flow.nodes.some(live) &&
      !flow.nodes.some(
        n =>
          n.status === 'queued' &&
          n.deps.every(dep => flow.nodes.find(p => p.id === dep)?.status === 'done'),
      )
    ) {
      flow.status = 'blocked';
      this.store.put(flow);
      return;
    }
    if (flow.nodes.every(n => n.status === 'done')) {
      const delivery = flow.nodes.find(n => n.kind === 'deliver');
      if (!delivery?.result) return;
      if (flow.deliveryIntent && !flow.delivered) {
        flow.status = 'blocked';
        flow.error = 'Final message delivery is unconfirmed; inspect the main conversation.';
        this.store.put(flow);
        return;
      }
      flow.deliveryIntent = true;
      this.store.put(flow);
      try {
        await this.host.deliver(flow, delivery.result);
        flow = this.store.get(id)!;
        flow.delivered = true;
        flow.status = 'completed';
        this.store.put(flow);
      } catch {
        flow = this.store.get(id)!;
        flow.status = 'blocked';
        flow.error = 'Final delivery could not be confirmed. Results remain available.';
        this.store.put(flow);
      }
      return;
    }
    if (!dispatch) return;
    for (const candidate of flow.nodes.filter(n => n.status === 'queued')) {
      flow = this.store.get(id)!;
      if (!this.enabled || flow.status !== 'running') return;
      const node = flow.nodes.find(n => n.id === candidate.id)!;
      const project = projectIdentity(flow.cwd);
      const allActive = this.store.all().flatMap(other => other.nodes.filter(live));
      const flowActive = flow.nodes.filter(live);
      const active = this.store
        .all()
        .filter(other => projectIdentity(other.cwd) === project)
        .flatMap(other => other.nodes.filter(live));
      if (
        allActive.length >= (this.host.capacity?.() ?? FLOW_LIMITS.parallel) ||
        flowActive.length >= (flow.concurrency ?? 16) ||
        active.some(n => n.access === 'write' && !n.batchItem) ||
        (node.access === 'write' && !node.batchItem && active.length)
      )
        continue;
      if (!node.deps.every(dep => flow.nodes.find(n => n.id === dep)?.status === 'done')) continue;
      const controlVersion = flow.controlVersion;
      const sessionKey = node.sessionKey;
      const attempt = node.attempt;
      const admission = () => {
        const latest = this.store.get(id, node.id);
        const current = latest?.nodes.find(item => item.id === node.id);
        if (
          !this.enabled ||
          !latest ||
          latest.status !== 'running' ||
          latest.controlVersion !== controlVersion ||
          !current ||
          current.sessionKey !== sessionKey ||
          current.attempt !== attempt
        )
          throw new Error('Flow admission revoked.');
        this.host.assertAdmission?.(latest);
      };
      if (node.kind === 'batch') {
        const freezeKey = id + ':' + node.id;
        if (node.batchInput || this.freezes.has(freezeKey)) continue;
        try {
          admission();
        } catch (error) {
          flow.status = 'blocked';
          flow.error = String(error);
          this.store.put(flow);
          return;
        }
        try {
          node.dispatch = { message: this.prompt(flow, node), createdAt: Date.now() };
        } catch (error) {
          node.status = 'failed';
          node.error = String(error);
          flow.status = 'blocked';
          this.store.put(flow);
          return;
        }
        node.status = 'preparing';
        this.store.put(flow);
        const pending = Promise.resolve().then(async () => {
          try {
            if (!this.host.freezeBatch)
              throw new Error('Native batch input admission is unavailable.');
            const frozen = await this.host.freezeBatch(flow, node, admission);
            admission();
            flow = this.store.get(id)!;
            const stage = flow.nodes.find(item => item.id === node.id)!;
            stage.batchInput = {
              version: frozen.manifest.version,
              manifestPath: frozen.manifestPath,
            };
            const items = frozen.manifest.inputs.map(input => {
              const item = this.node(
                flow,
                input.id,
                'work',
                input.title,
                stage.task,
                stage.deps,
                stage.access,
                stage.agentId,
              );
              item.batchItem = {
                stageId: stage.id,
                manifestVersion: frozen.manifest.version,
                ordinal: input.ordinal,
                key: input.key,
                workspace: '',
              };
              item.batchItem.workspace = itemWorkspace(flow, item);
              return item;
            });
            this.store.expandBatch(flow, stage, items, admission);
          } catch (error) {
            flow = this.store.get(id)!;
            const stage = flow.nodes.find(item => item.id === node.id)!;
            if (
              !this.enabled ||
              flow.status !== 'running' ||
              flow.controlVersion !== controlVersion
            ) {
              if (!stage.batchInput)
                stage.status = ['stopping', 'cancelled'].includes(flow.status)
                  ? 'cancelled'
                  : 'queued';
              this.store.put(flow);
              return;
            }
            stage.status = 'failed';
            stage.error = String(error);
            flow.status = 'blocked';
            this.store.put(flow);
          } finally {
            this.freezes.delete(freezeKey);
          }
        });
        this.freezes.set(freezeKey, pending);
        void pending.catch(() => {
          /* The next reconciliation reports persisted stage failures. */
        });
        return;
      }
      try {
        admission();
      } catch (error) {
        flow.status = 'blocked';
        flow.error = String(error);
        this.store.put(flow);
        return;
      }
      if (node.batchItem) node.batchItem.workspace = itemWorkspace(flow, node);
      node.status = 'preparing';
      if (!flow.settings) node.startedAt = Date.now();
      this.store.put(flow);
      const preparingKey = id + ':' + node.id;
      const prepareAndLaunch = async () => {
        let launchIntent: string | undefined;
        let pendingCorrection: { runId: string; passes: number } | undefined;
        try {
          await this.host.prepare(flow, node);
          flow = this.store.get(id, node.id)!;
          const current = flow.nodes.find(n => n.id === node.id)!;
          if (
            !this.enabled ||
            flow.status !== 'running' ||
            flow.controlVersion !== controlVersion ||
            current.sessionKey !== sessionKey ||
            current.attempt !== attempt
          ) {
            if (current.status === 'preparing' && !current.intendedRunId)
              current.status = flow.status === 'stopping' ? 'cancelled' : 'queued';
            this.store.put(flow);
            return;
          }
          current.intendedRunId = randomUUID();
          const repair = current.submissionRepair;
          const correcting = repair?.pending === true;
          if (correcting) {
            pendingCorrection = { runId: repair.runId, passes: repair.passes };
            repair.runId = current.intendedRunId;
            repair.passes += 1;
            delete repair.pending;
          } else current.dispatch = { message: this.prompt(flow, current), createdAt: Date.now() };
          current.status = 'uncertain';
          this.store.put(flow);
          launchIntent = current.intendedRunId;
          const assertCurrent = () => {
            admission();
            const latest = this.store
              .get(id, current.id)
              ?.nodes.find(item => item.id === current.id);
            if (latest?.intendedRunId !== current.intendedRunId || latest?.status !== 'uncertain')
              throw new Error('Launch intent revoked.');
          };
          const receipt = await this.host.launch(
            flow,
            current,
            correcting ? repair.instruction : current.dispatch!.message,
            assertCurrent,
          );
          if (
            receipt.runId !== current.intendedRunId ||
            (receipt.sessionKey && receipt.sessionKey !== current.sessionKey)
          )
            throw new Error('Native receipt does not match the persisted launch intent.');
          flow = this.store.get(id, node.id)!;
          const admitted = flow.nodes.find(n => n.id === node.id)!;
          if (
            admitted.intendedRunId !== current.intendedRunId ||
            admitted.sessionKey !== sessionKey ||
            admitted.attempt !== attempt
          )
            throw new Error('Native launch receipt belongs to an obsolete attempt.');
          admitted.runId = receipt.runId;
          admitted.sessionKey = receipt.sessionKey ?? admitted.sessionKey;
          admitted.status = 'running';
          this.store.put(flow);
        } catch (error) {
          flow = this.store.get(id, node.id)!;
          const failed = flow.nodes.find(n => n.id === node.id)!;
          if (failed.sessionKey !== sessionKey || failed.attempt !== attempt) return;
          if (error instanceof NativeLaunchNotInvokedError && launchIntent) {
            // Only the local preflight wrapper proves that the SDK was never
            // called. A lost SDK response, even with the same message/name,
            // remains uncertain and keeps its lease.
            if (failed.intendedRunId !== launchIntent || failed.runId) return;
            delete failed.intendedRunId;
            if (pendingCorrection && failed.submissionRepair?.runId === launchIntent) {
              failed.submissionRepair.runId = pendingCorrection.runId;
              failed.submissionRepair.passes = pendingCorrection.passes;
              failed.submissionRepair.pending = true;
            }
            failed.cleanupSettled = true;
            if (
              !this.enabled ||
              flow.status !== 'running' ||
              flow.controlVersion !== controlVersion
            ) {
              failed.status = ['stopping', 'cancelled'].includes(flow.status)
                ? 'cancelled'
                : 'queued';
              delete failed.error;
              if (failed.status === 'queued') delete failed.cleanupSettled;
              if (!failed.deadlineAt) delete failed.startedAt;
              this.store.put(flow);
              return;
            }
            failed.status = 'failed';
            failed.error = String(error.cause);
            try {
              this.host.assertAdmission?.(flow);
            } catch (admissionError) {
              flow.status = 'blocked';
              flow.error = String(admissionError);
            }
            if (!failed.batchItem) flow.status = 'blocked';
            this.store.put(flow);
            return;
          }
          if (
            !failed.intendedRunId &&
            (!this.enabled || flow.status !== 'running' || flow.controlVersion !== controlVersion)
          ) {
            failed.status = flow.status === 'stopping' ? 'cancelled' : 'queued';
            delete failed.error;
            this.store.put(flow);
            return;
          }
          failed.status = failed.intendedRunId ? 'uncertain' : 'failed';
          if (!failed.intendedRunId) failed.cleanupSettled = true;
          failed.error = String(error);
          try {
            this.host.assertAdmission?.(flow);
          } catch (admissionError) {
            if (flow.status !== 'stopping') {
              flow.status = 'blocked';
              flow.error = String(admissionError);
            }
          }
          if (flow.status !== 'stopping' && !failed.batchItem) flow.status = 'blocked';
          this.store.put(flow);
        }
      };
      if (node.batchItem) {
        const pending = Promise.resolve()
          .then(prepareAndLaunch)
          .finally(() => this.jobs.delete(preparingKey));
        this.jobs.set(preparingKey, pending);
        void pending.catch(() => {
          /* Preserve the durable preparing/uncertain lease on storage failure. */
        });
      } else await prepareAndLaunch();
      return;
    }
  }
}
