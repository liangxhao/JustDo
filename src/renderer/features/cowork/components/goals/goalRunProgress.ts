import type { ChatState } from '@/libs/openclaw-chat/gateway/chat-controller';

export type GoalRunPhase = 'running' | 'thinking' | 'tool' | 'responding' | 'compacting';

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
  const runningTool = [...tools].reverse().find(item => item.status === 'running');
  if (runningTool) {
    return { ...base, phase: 'tool', toolName: runningTool.name };
  }
  const activeContent = [...items]
    .reverse()
    .find(item => item.type === 'content' && item.status === 'streaming' && item.text.length > 0);
  if (activeContent) {
    return { ...base, phase: 'responding' };
  }
  const activeThinking = [...items]
    .reverse()
    .find(item => item.type === 'thinking' && item.status === 'running' && item.text.length > 0);
  if (activeThinking) {
    return { ...base, phase: 'thinking' };
  }
  return { ...base, phase: 'running' };
};

export const goalRunProgressKey = (progress: GoalRunProgress | null): string =>
  progress
    ? [progress.phase, progress.startedAt, progress.toolCount, progress.toolName ?? ''].join(':')
    : '';
