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

export function inferSessionsYieldInput(name: string, output: string | null | undefined): unknown {
  if (!isSessionsYieldTool(name) || !output?.trim()) return undefined;
  try {
    const parsed = JSON.parse(output) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const message = (parsed as Record<string, unknown>).message;
    return typeof message === 'string' && message.trim() ? { message: message.trim() } : undefined;
  } catch {
    return undefined;
  }
}
