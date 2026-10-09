export const SwarmIpc = { Snapshot: 'cowork:swarm:snapshot' } as const;

export type SwarmChildStatus = 'queued' | 'running' | 'done' | 'failed';
export interface SwarmGroup {
  groupId: string;
  createdAt: number;
  queued: number;
  running: number;
  done: number;
  failed: number;
  children: Array<{ sessionKey: string; status: SwarmChildStatus }>;
}
export interface SwarmSnapshot {
  groups: SwarmGroup[];
  otherActiveGroups: number;
}
export type SwarmSnapshotResult = { success: true; snapshot: SwarmSnapshot } | { success: false };
export interface SwarmApi {
  getSwarmSnapshot(sessionId: string): Promise<SwarmSnapshotResult>;
}

function buildLegacySwarmInstruction(options: {
  mode: 'auto' | 'research' | 'review';
  verify: boolean;
}): string {
  const strategy = {
    auto: 'Decompose independent parts of this task where parallel work is useful.',
    research: 'Research independent aspects in parallel and preserve sources and disagreements.',
    review:
      'Have independent reviewers inspect different aspects and report evidence-backed findings.',
  }[options.mode];
  return [
    '<parallel-collaboration-request>',
    'The user explicitly requested native OpenClaw Swarm for this turn.',
    strategy,
    'Use native collector subagents: sessions_spawn with collect:true and a shared groupId, then agents_wait; or agents.run if the native Code Mode API is available.',
    'Use short descriptive labels. Keep all collectors for this request in the same native group. Obey effective tool policies and configured concurrency. Do not enable settings or substitute peer team messages.',
    'Collect every accepted child, preserve partial successes, and report failures honestly. Do not automatically repeat side effects or failed launches.',
    options.verify
      ? 'After collecting results, run an independent collector to check the evidence before synthesizing. Report whether this check actually ran and any remaining issues.'
      : 'Synthesize the collected evidence and disclose limitations.',
    'If Swarm is unavailable or this task cannot usefully be split, explain that no parallel work started. Never claim a tool ran without an accepted native receipt.',
    'Keep the final answer and deliverables in this main conversation.',
    '</parallel-collaboration-request>',
  ].join('\n');
}

// Native collector-request display projection; workflow markers belong to swarmWorkflow.
export function stripSwarmInstruction(text: string): string {
  if (!text.endsWith('</parallel-collaboration-request>')) return text;
  for (const mode of ['auto', 'research', 'review'] as const) {
    for (const verify of [true, false]) {
      const suffix = '\n\n' + buildLegacySwarmInstruction({ mode, verify });
      if (text.endsWith(suffix)) return text.slice(0, -suffix.length);
    }
  }
  return text;
}
