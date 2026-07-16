import type { ChatState } from '@/libs/openclaw-chat/gateway/chat-controller';

export type GoalRunPhase = 'starting' | 'thinking' | 'tool' | 'responding';

export interface GoalRunProgress {
  phase: GoalRunPhase;
  startedAt: number;
  toolCount: number;
  toolName?: string;
}

type GoalActivityState = Pick<
  ChatState,
  | 'chatSending'
  | 'chatStreamStartedAt'
  | 'chatStream'
  | 'chatThinkingStream'
  | 'chatThinkingMessages'
  | 'chatToolMessages'
>;

const readToolName = (message: unknown): string | undefined => {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined;
  const record = message as Record<string, unknown>;
  for (const candidate of [record.toolName, record.tool_name, record.name]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  const content = Array.isArray(record.content) ? record.content : [];
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const block = content[index];
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    const name = (block as Record<string, unknown>).name;
    if (typeof name === 'string' && name.trim()) return name.trim();
  }
  return undefined;
};

export const buildGoalRunProgress = (state: GoalActivityState): GoalRunProgress | null => {
  if (!state.chatSending) return null;
  const toolCount = state.chatToolMessages.length;
  const base = {
    startedAt: state.chatStreamStartedAt ?? Date.now(),
    toolCount,
  };
  if (state.chatStream) {
    return { ...base, phase: 'responding' };
  }
  if (toolCount > 0) {
    return {
      ...base,
      phase: 'tool',
      toolName: readToolName(state.chatToolMessages[toolCount - 1]),
    };
  }
  if (state.chatThinkingStream || state.chatThinkingMessages.length > 0) {
    return { ...base, phase: 'thinking' };
  }
  return { ...base, phase: 'starting' };
};

export const goalRunProgressKey = (progress: GoalRunProgress | null): string =>
  progress
    ? [progress.phase, progress.startedAt, progress.toolCount, progress.toolName ?? ''].join(':')
    : '';
