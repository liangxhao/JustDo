import type { ChatState } from '@/libs/openclaw-chat/gateway/chat-controller';

export type GoalRunPhase = 'starting' | 'thinking' | 'tool' | 'responding' | 'compacting';

export interface GoalRunProgress {
  phase: GoalRunPhase;
  startedAt: number;
  toolCount: number;
  toolName?: string;
}

type GoalActivityState = Pick<ChatState, 'chatSending' | 'compactionInFlight' | 'transcript'>;

export const buildGoalRunProgress = (state: GoalActivityState): GoalRunProgress | null => {
  if (!state.chatSending) return null;
  const turn = state.transcript.activeTurn;
  const items = turn?.items ?? [];
  const tools = items.filter(item => item.type === 'tool');
  const toolCount = tools.length;
  const base = {
    startedAt: turn?.startedAt ?? Date.now(),
    toolCount,
  };
  if (state.compactionInFlight) {
    return { ...base, phase: 'compacting' };
  }
  if (items.some(item => item.type === 'content' && item.text.length > 0)) {
    return { ...base, phase: 'responding' };
  }
  if (toolCount > 0) {
    return {
      ...base,
      phase: 'tool',
      toolName: tools[toolCount - 1]?.name,
    };
  }
  if (items.some(item => item.type === 'thinking' && item.text.length > 0)) {
    return { ...base, phase: 'thinking' };
  }
  return { ...base, phase: 'starting' };
};

export const goalRunProgressKey = (progress: GoalRunProgress | null): string =>
  progress
    ? [progress.phase, progress.startedAt, progress.toolCount, progress.toolName ?? ''].join(':')
    : '';
