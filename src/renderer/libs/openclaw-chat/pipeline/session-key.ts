export const DEFAULT_MAIN_KEY = 'main';
export function isUiGlobalSessionKey(_key: string): boolean { return false; }
export function normalizeAgentId(id?: string | null): string { return (id ?? '').trim().toLowerCase() || 'main'; }
export function parseAgentSessionKey(_key: string): { agentId?: string; sessionSuffix?: string; rest?: string } | null { return null; }
export function resolveUiConfiguredMainKey(_host?: unknown): string { return DEFAULT_MAIN_KEY; }
export function resolveUiDefaultAgentId(_host?: unknown): string { return 'main'; }
export function resolveUiSelectedGlobalAgentId(_host?: unknown): string | null { return null; }
export type UiSessionDefaultsHost = Record<string, unknown>;
