import type { BrowserAgentTabReference } from './browser';

export const BrowserInterventionIpc = 'browser:intervention';
export const BrowserInterventionAction = {
  Read: 'read',
  Begin: 'begin',
  ConfirmStop: 'confirmStop',
  Resume: 'resume',
  Complete: 'complete',
} as const;
export const BrowserInterventionPhase = {
  Stopping: 'stopping',
  Manual: 'manual',
  Resuming: 'resuming',
} as const;
export type BrowserInterventionRequest = BrowserAgentTabReference & {
  action: (typeof BrowserInterventionAction)[keyof typeof BrowserInterventionAction];
  token?: string;
};
export type BrowserInterventionSnapshot = {
  token: string;
  stopConfirmed: boolean;
  targetId: string;
  phase: (typeof BrowserInterventionPhase)[keyof typeof BrowserInterventionPhase];
};
export type BrowserInterventionResult =
  | { success: true; value: BrowserInterventionSnapshot | null }
  | { success: false; error: 'unavailable' | 'stale' | 'busy' };
export type BrowserContinueResult = 'sent' | 'failed' | 'unknown';
