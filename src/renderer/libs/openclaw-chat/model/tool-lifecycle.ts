import type { ToolItem } from './chat-transcript-state';

export const SESSIONS_YIELD_TOOL_NAME = 'sessions_yield';

export function isSessionsYieldTool(name: string): boolean {
  return name.trim().toLowerCase() === SESSIONS_YIELD_TOOL_NAME;
}

export function hasToolResultPayload(tool: Pick<ToolItem, 'output' | 'error'>): boolean {
  return [tool.output, tool.error].some(value => {
    if (value === undefined) return false;
    const normalized = value.trim();
    return normalized.length > 0 && normalized !== '[]';
  });
}
