import type { ToolItem } from './chat-transcript-state';
import { asToolRecord } from './tool-message-adapter';

export const OPEN_SPAWNED_AGENT_EVENT = 'cowork:open-spawned-agent';

export function spawnedAgentSessionKey(tool: ToolItem): string | null {
  let name = tool.name.toLowerCase();
  const input = asToolRecord(tool.input);
  if (name === 'tool_call' && typeof input?.id === 'string') {
    name = input.id.replace(/^openclaw:core:/, '');
  }
  if (
    name !== 'sessions_spawn' ||
    tool.status !== 'completed' ||
    tool.error ||
    tool.presentation?.partial
  )
    return null;
  if (!tool.output || tool.output.length > 120_000) return null;
  try {
    const result = asToolRecord(JSON.parse(tool.output));
    const key = result?.childSessionKey;
    return result?.status === 'accepted' && typeof key === 'string' && key.trim()
      ? key.trim()
      : null;
  } catch {
    return null;
  }
}
