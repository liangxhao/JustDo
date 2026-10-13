/** Ephemeral native desktop presentation; no input, screenshots or transcript data. */
export const COMPUTER_ACTIVITY_EVENT = 'computer.activity';
export const COMPUTER_ACTIVITY_LEASE_MS = 15_000;

export type ComputerActivity = {
  v: 2;
  id: string;
  execution: string;
  phase: 'start' | 'end' | 'close';
  cursor: boolean;
  click: boolean;
};

export function parseComputerActivity(value: unknown): ComputerActivity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (
    item.v !== 2 ||
    typeof item.id !== 'string' ||
    !/^[a-f0-9-]{36}$/i.test(item.id) ||
    typeof item.execution !== 'string' ||
    !/^[a-f0-9-]{36}$/i.test(item.execution) ||
    (item.phase !== 'start' && item.phase !== 'end' && item.phase !== 'close') ||
    typeof item.cursor !== 'boolean' ||
    typeof item.click !== 'boolean' ||
    (item.click && (item.phase !== 'end' || !item.cursor)) ||
    (item.phase === 'close' && (item.cursor || item.click || item.id !== item.execution))
  )
    return null;
  return {
    v: 2,
    id: item.id,
    execution: item.execution,
    phase: item.phase,
    cursor: item.cursor,
    click: item.click,
  };
}
