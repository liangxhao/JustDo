/** Ephemeral native desktop presentation; no input, screenshots or transcript data. */
export const COMPUTER_ACTIVITY_EVENT = 'computer.activity';
export const COMPUTER_ACTIVITY_LEASE_MS = 15_000;

export type ComputerActivity = {
  v: 1;
  id: string;
  phase: 'start' | 'end';
  cursor: boolean;
  click: boolean;
};

export function parseComputerActivity(value: unknown): ComputerActivity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (
    item.v !== 1 ||
    typeof item.id !== 'string' ||
    !/^[a-f0-9-]{36}$/i.test(item.id) ||
    (item.phase !== 'start' && item.phase !== 'end') ||
    typeof item.cursor !== 'boolean' ||
    typeof item.click !== 'boolean' ||
    (item.click && (item.phase !== 'end' || !item.cursor))
  )
    return null;
  return { v: 1, id: item.id, phase: item.phase, cursor: item.cursor, click: item.click };
}
