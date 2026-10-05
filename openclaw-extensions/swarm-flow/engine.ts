import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_FLOW_AGENT,
  type Flow,
  FLOW_LIMITS,
  type FlowAction,
  type FlowNode,
  type FlowSubmission,
} from './contract.js';
import { interventionAvailability, resetFailedNode, validateIntervention } from './intervention.js';
import { parseJson, validatePlan, validateStageAssignments, verdict } from './plan.js';
import type { FlowStore } from './store.js';
import {
  submissionCorrectionInstructions,
  submissionInstructions,
  validateSubmission,
} from './submission.js';
export interface FlowHost {
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
  }>;
  cancel(node: FlowNode): Promise<void>;
  correctionInstruction?(flow: Flow, node: FlowNode): Promise<string>;
  deliver(flow: Flow, text: string): Promise<void>;
}
const live = (n: FlowNode) => ['preparing', 'running', 'uncertain'].includes(n.status);
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
  constructor(
    readonly store: FlowStore,
    readonly host: FlowHost,
  ) {
    // A persisted receipt proves acceptance, not continued liveness after restart.
    for (const flow of store.all()) {
      if (flow.nodes.some(node => node.status === 'running')) {
        for (const node of flow.nodes) if (node.status === 'running') node.status = 'uncertain';
        store.put(flow);
      }
    }
  }
  stop(): void {
    this.enabled = false;
  }
  create(
    input: Omit<Flow, 'id' | 'revision' | 'createdAt' | 'updatedAt' | 'status' | 'nodes'>,
  ): Flow {
    const prior = this.store.all().find(f => f.requestId === input.requestId);
    if (prior) {
      if (prior.parentKey !== input.parentKey || prior.goal !== input.goal)
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
    const flow = this.store
      .all()
      .find(item => item.nodes.some(node => node.sessionKey === sessionKey));
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
  submit(sessionKey: string, runId: string, submission: FlowSubmission): { accepted: true } {
    const { flow, node } = this.submissionOwner(sessionKey, runId);
    const { outcome, ...fields } = submission;
    submission = validateSubmission(outcome, fields);
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
    if (
      submission.outcome === 'blocked' ||
      (submission.outcome === 'verified' && !submission.passed)
    )
      flow.status = 'blocked';
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
  control(id: string, revision: number, action: FlowAction): Flow {
    const flow = this.store.get(id);
    if (!flow || flow.revision !== revision) throw new Error('Flow revision conflict.');
    if (['completed', 'cancelled'].includes(flow.status)) throw new Error('Flow has ended.');
    if (flow.status === 'running' && flow.deliveryIntent && !flow.delivered)
      throw new Error('Final delivery is already in progress and cannot be interrupted.');
    if (action === 'pause') {
      if (flow.status !== 'running') throw new Error('Only a running flow can be paused.');
      flow.status = 'paused';
    } else if (action === 'retry') {
      const failed = flow.nodes.filter(node => node.status === 'failed');
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
      if (failed.some(node => (node.attempt ?? 1) >= FLOW_LIMITS.attempts))
        throw new Error('Retry limit reached. Inspect the failed task or start a new flow.');
      for (const node of failed) {
        resetFailedNode(flow, node);
      }
      flow.status = 'running';
    } else if (action === 'stop') flow.status = 'stopping';
    else {
      if (
        flow.status !== 'paused' ||
        flow.nodes.some(n => n.status === 'failed' || n.status === 'uncertain')
      )
        throw new Error('Resolve failed or uncertain work before resuming.');
      flow.status = 'running';
    }
    this.store.put(flow);
    return flow;
  }
  intervene(id: string, nodeId: string, revision: number, input: unknown): Flow {
    if (!this.enabled) throw new Error('Swarm service is unavailable.');
    const request = validateIntervention(input);
    const flow = this.store.get(id);
    const node = flow?.nodes.find(n => n.id === nodeId);
    if (!flow || !node) throw new Error('Flow node was not found.');
    // A lost response may be retried after execution has advanced or the flow ended.
    const prior = flow.nodes.flatMap(n => n.interventions ?? []).find(n => n.id === request.id);
    if (prior) {
      if (
        !node.interventions?.includes(prior) ||
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
      flow.status = 'running';
    }
    this.store.put(flow);
    return flow;
  }
  private prompt(flow: Flow, node: FlowNode): string {
    const inputIds =
      node.kind === 'verify' || node.kind === 'deliver'
        ? flow.nodes
            .filter(n => n.kind === 'work' || (node.kind === 'deliver' && n.kind === 'verify'))
            .map(n => n.id)
        : node.deps;
    const inputs = inputIds.map(id => {
      const n = flow.nodes.find(n => n.id === id)!;
      return { id, task: n.task, result: n.result };
    });
    const instruction =
      node.kind === 'plan'
        ? 'Return only JSON {"tasks":[{"id":"task-id","title":"short title","task":"complete brief and acceptance criteria","deps":[],"access":"read or write","agentId":"main"}],"stages":{"verify":{"agentId":"main"},"deliver":{"agentId":"main"}},"unresolvedAssignments":[]}. Create 1-8 tasks with acyclic dependencies, choosing meaningful parallel work. Each task ID is a unique non-empty reference label. Prefer short labels. Dependencies must reference exact task IDs. The service converts these labels and their dependencies into internal node IDs. Do not create verification or delivery tasks; the service adds those gates. All tasks and gates default to main regardless of the originating chat agent. ONLY when the user explicitly assigns a stage to another existing agent, set its exact availableAgents ID and include agentRequest with a verbatim excerpt of assignmentRequest naming that agent. Only assignmentRequest is authoritative for agent assignments; the goal may be a rewritten task brief. Resolve names using availableAgents; never invent agents or silently replace unavailable/ambiguous assignments with main. Put unresolved assignments in unresolvedAssignments. The service adds verification/delivery gates; assign them with stages, do not add duplicates. This planning pass is main orchestration; if the user assigns design/planning work to a specialist, create a separate work task for that agent. Tasks need no further conversation context. Mark any possible modification as write.'
        : node.kind === 'verify'
          ? 'Independently inspect every work result against the goal, using read-only evidence. Submit the verdict using swarm_flow_verify(passed, summary, evidence), then end this turn. Do not use final-reply JSON as a substitute for the tool. Set passed=true only if the original goal and acceptance criteria are satisfied with concrete evidence. A missing target project, missing implementation or unmet prerequisite must set passed=false even if workers honestly reported that limitation. Missing or unverifiable evidence must fail. Never perform implementation. Use swarm_flow_block(summary, evidence) if external input is required. Once a terminal submission is accepted, do no more work; a short natural-language final reply is optional.'
          : node.kind === 'deliver'
            ? 'Produce the final user-facing answer in the language of the goal, using verified results. Include deliverables and limitations. Do not perform additional work.'
            : 'Execute only this assigned task within the user goal. Call swarm_flow_complete(summary, evidence) with deliverable references and remaining limitations before ending the turn. If you cannot satisfy the task because of a missing prerequisite or external input, call swarm_flow_block(summary, evidence) instead; never claim success for an unmet goal. Once a submission is accepted, do no more work. A short natural-language final reply is optional. Do not delegate extra workers, send a final reply to the user, or broaden scope.';
    return JSON.stringify({
      goal: flow.goal,
      ...(node.kind === 'plan'
        ? { availableAgents: flow.agents, assignmentRequest: flow.assignmentRequest ?? flow.goal }
        : {}),
      strategy:
        flow.mode === 'research'
          ? 'Parallel research; all tasks must be read-only.'
          : flow.mode === 'review'
            ? 'Independent review from different perspectives; all tasks must be read-only.'
            : 'Choose dependencies and parallelism appropriate to the goal.',
      assignedTask: node.task,
      access: node.access,
      accessInstruction:
        node.access === 'read'
          ? 'This is an inspection task. Do not modify source files, configuration, repository state or user data. Native session permission governs which tools you may invoke; read-only task intent is not permission to mutate through shell commands. Tests that create files require a write task.'
          : 'Perform only modifications explicitly authorized by the goal and this assigned task; native session permissions remain the upper bound.',
      inputs,
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
  }
  async tick(): Promise<void> {
    if (!this.enabled || this.ticking) return;
    this.ticking = true;
    try {
      for (const entry of this.store.all()) {
        if (!this.enabled) break;
        if (['completed', 'cancelled'].includes(entry.status)) continue;
        await this.advance(entry.id);
      }
    } finally {
      this.ticking = false;
    }
  }
  private async advance(id: string): Promise<void> {
    let flow = this.store.get(id)!;
    for (const original of flow.nodes.filter(live)) {
      if (!this.enabled) return;
      flow = this.store.get(id)!;
      const node = flow.nodes.find(n => n.id === original.id)!;
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
      flow = this.store.get(id)!;
      let current = flow.nodes.find(n => n.id === node.id)!;
      const yielded =
        result.status === 'ok' && (result.yielded === true || result.livenessState === 'paused');
      if (!result.endedAt || result.status === 'pending' || result.pendingError || yielded) {
        if (yielded && flow.status !== 'stopping') {
          current.status = 'uncertain';
          current.error = 'Native execution yielded; waiting for a conclusive result.';
          flow.status = 'blocked';
          this.store.put(flow);
          continue;
        }
        if (
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
      if (flow.status === 'stopping') current.status = 'cancelled';
      // Native wait normalizes execution failures. Successful provider stop reasons
      // include both "stop" and "end_turn" and are not cancellation evidence.
      else if (result.status !== 'ok') {
        current.status = 'failed';
        current.error = result.error || result.stopReason || 'Native run failed.';
        flow.status = 'blocked';
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
              flow = this.store.get(id)!;
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
              flow = this.store.get(id)!;
              current = flow.nodes.find(n => n.id === node.id)!;
              current.endedAt = result.endedAt;
              receipt = current.completion;
              repair = current.submissionRepair;
            }
            if (
              !receipt &&
              repair?.runId === (current.runId ?? current.intendedRunId) &&
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
          } else if (!text?.trim() || text.length > FLOW_LIMITS.result)
            throw new Error('Missing or oversized terminal result.');
          if (current.kind === 'plan') {
            const parsed = parseJson(text!);
            const tasks = validatePlan(parsed, flow.agents, flow.assignmentRequest ?? flow.goal);
            const stages = validateStageAssignments(
              parsed,
              flow.agents,
              flow.assignmentRequest ?? flow.goal,
            );
            if (flow.mode !== 'auto' && tasks.some(task => task.access !== 'read'))
              throw new Error('Research and review flows cannot schedule write tasks.');
            const work = tasks.map(t =>
              this.node(
                flow,
                t.id,
                'work',
                t.title,
                t.task,
                t.deps.length ? t.deps : ['plan'],
                t.access,
                t.agentId,
              ),
            );
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
          current.status = 'done';
          delete current.error;
        } catch (error) {
          current.status = 'failed';
          current.error = String(error);
          flow.status = 'blocked';
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
      if (!flow.nodes.some(live)) {
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
    for (const candidate of flow.nodes.filter(n => n.status === 'queued')) {
      flow = this.store.get(id)!;
      if (!this.enabled || flow.status !== 'running') return;
      const node = flow.nodes.find(n => n.id === candidate.id)!;
      const project = projectIdentity(flow.cwd);
      const active = this.store
        .all()
        .filter(other => projectIdentity(other.cwd) === project)
        .flatMap(other => other.nodes.filter(live));
      if (
        active.length >= FLOW_LIMITS.parallel ||
        active.some(n => n.access === 'write') ||
        (node.access === 'write' && active.length)
      )
        continue;
      if (!node.deps.every(dep => flow.nodes.find(n => n.id === dep)?.status === 'done')) continue;
      node.status = 'preparing';
      node.startedAt = Date.now();
      this.store.put(flow);
      try {
        await this.host.prepare(flow, node);
        flow = this.store.get(id)!;
        const current = flow.nodes.find(n => n.id === node.id)!;
        if (!this.enabled || flow.status !== 'running') {
          current.status = 'queued';
          this.store.put(flow);
          return;
        }
        current.intendedRunId = randomUUID();
        const repair = current.submissionRepair;
        const correcting = repair?.pending === true;
        if (correcting) {
          repair.runId = current.intendedRunId;
          repair.passes += 1;
          delete repair.pending;
        } else current.dispatch = { message: this.prompt(flow, current), createdAt: Date.now() };
        current.status = 'uncertain';
        this.store.put(flow);
        const assertCurrent = () => {
          if (!this.enabled || this.store.get(id)?.status !== 'running')
            throw new Error('Flow admission revoked.');
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
        flow = this.store.get(id)!;
        const admitted = flow.nodes.find(n => n.id === node.id)!;
        admitted.runId = receipt.runId;
        admitted.sessionKey = receipt.sessionKey ?? admitted.sessionKey;
        admitted.status = 'running';
        this.store.put(flow);
      } catch (error) {
        flow = this.store.get(id)!;
        const failed = flow.nodes.find(n => n.id === node.id)!;
        failed.status = failed.intendedRunId ? 'uncertain' : 'failed';
        failed.error = String(error);
        if (flow.status !== 'stopping') flow.status = 'blocked';
        this.store.put(flow);
      }
    }
  }
}
