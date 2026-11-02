const USER_ROLE = 'user';
const CUSTOM_ROLE = 'custom';
const INTERNAL_SYSTEM_INPUT = 'internal_system';
const INTER_SESSION_INPUT = 'inter_session';
const EXEC_APPROVAL_FOLLOWUP = 'exec_approval_followup';
const RUNTIME_CONTEXT_TYPE = 'openclaw.runtime-context';
const SYSTEM_UPDATE_TYPE = 'openclaw.system-update';
const RUNTIME_CONTEXT_KIND = 'runtime-context';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Display policy only: never use message visibility as execution or authorization evidence. */
export function isHiddenNativeMessage(value: unknown): boolean {
  const outer = record(value);
  if (!outer) return false;
  if (outer.display === false) return true;
  // Some history readers retain an entry envelope. Never inspect JSON inside an
  // authored message that already has its own role.
  const message = typeof outer.role === 'string' ? outer : record(outer.message) ?? outer;
  if (message.display === false) return true;
  const role = typeof message.role === 'string' ? message.role.toLowerCase() : '';
  if (role === CUSTOM_ROLE) {
    return message.customType === RUNTIME_CONTEXT_TYPE ||
      (message.customType === SYSTEM_UPDATE_TYPE && record(message.details)?.kind === RUNTIME_CONTEXT_KIND);
  }
  if (role !== USER_ROLE) return false;
  const provenance = record(message.provenance);
  return provenance?.kind === INTERNAL_SYSTEM_INPUT ||
    (provenance?.kind === INTER_SESSION_INPUT && provenance.sourceTool === EXEC_APPROVAL_FOLLOWUP);
}
