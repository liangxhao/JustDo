export const SwarmIpc = {
  Snapshot: 'cowork:swarm:snapshot',
  Prepare: 'cowork:swarm:prepare',
} as const;

export const SwarmMode = { Auto: 'auto', Research: 'research', Review: 'review' } as const;
export type SwarmOptions = { mode: (typeof SwarmMode)[keyof typeof SwarmMode]; verify: boolean };
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
export type SwarmPrepareResult =
  | { success: true; instruction: string }
  | { success: false; reason: 'disabled' | 'plan' | 'unavailable' | 'invalid' };
export interface SwarmApi {
  getSwarmSnapshot: (sessionId: string) => Promise<SwarmSnapshotResult>;
  prepareSwarm: (options: SwarmOptions, sessionId?: string) => Promise<SwarmPrepareResult>;
}
export const isSwarmOptions = (value: unknown): value is SwarmOptions => {
  if (!value || typeof value !== 'object') return false;
  const options = value as Record<string, unknown>;
  return (
    Object.values(SwarmMode).includes(options.mode as SwarmOptions['mode']) &&
    typeof options.verify === 'boolean' &&
    Object.keys(options).every(key => key === 'mode' || key === 'verify')
  );
};

function buildLegacySwarmInstruction(options: SwarmOptions): string {
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

export function buildSwarmInstruction(options: SwarmOptions): string {
  return `<justdo-swarm-flow mode="${options.mode}"/>`;
}

// Display projection only. Match complete application-authored suffixes, never arbitrary tags.
export function stripSwarmInstruction(text: string): string {
  if (!text.endsWith('</parallel-collaboration-request>') && !text.endsWith('"/>')) return text;
  for (const mode of Object.values(SwarmMode)) {
    for (const verify of [true, false]) {
      for (const build of [buildSwarmInstruction, buildLegacySwarmInstruction]) {
        const suffix = '\n\n' + build({ mode, verify });
        if (text.endsWith(suffix)) return text.slice(0, -suffix.length);
      }
    }
  }
  return text;
}
