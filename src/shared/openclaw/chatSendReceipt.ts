export type ChatSendStopReceipt = {
  ok: true;
  aborted: boolean;
  runIds: string[];
  warning?: string;
};

/** Native stop commands acknowledge control without creating an execution run. */
export function isChatSendStopReceipt(value: unknown): value is ChatSendStopReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return receipt.ok === true && typeof receipt.aborted === 'boolean' &&
    Array.isArray(receipt.runIds) && receipt.runIds.length <= 1024 &&
    receipt.runIds.every(id => typeof id === 'string' && id.trim() && id.length <= 256) &&
    (receipt.warning === undefined || (typeof receipt.warning === 'string' && receipt.warning.length <= 2000)) &&
    Object.keys(receipt).every(key => ['ok', 'aborted', 'runIds', 'warning'].includes(key));
}
