export { coworkService } from './coworkService';
export { useExtensionAvailability,useExtensionEnabled } from './extensions';
export { store } from './store';
export type { AppStateSnapshot as RootState } from '@app-plugin/sdk/application';
export { useSelector } from 'react-redux';
export const OpenClawExtensionId = { AGENT_TEAM: 'agent-team' } as const;
// Test-owned draft port messages. The public host fixture records these effects.
export const addDraftMessageQuote = (payload: unknown) => ({ type: 'cowork/addDraftMessageQuote', payload });
export const setDraftPrompt = (payload: unknown) => ({ type: 'cowork/setDraftPrompt', payload });
