export const ComputerControlIpc = {
  Get: 'openclaw:computerControl:get',
  SetEnabled: 'openclaw:computerControl:setEnabled',
} as const;

export type ComputerControlResult =
  | { success: true; enabled: boolean }
  | { success: false; code: 'unavailable' | 'invalid' | 'conflict' | 'failed' };
