// Existing UI behavior fixtures keep their metadata store; production uses the portable SDK.
export { useSelector } from 'react-redux';
export { store } from '@/store';
export { coworkService } from '@/features/cowork/coworkService';
export { addDraftMessageQuote, setDraftPrompt } from '@/features/cowork/coworkSlice';
export {
  useExtensionEnabled,
  useExtensionAvailability,
} from '@/features/plugins/extensions/useExtensionEnablement';
export { OpenClawExtensionId } from '@shared/plugins/nativeIds';
export type { RootState } from '@/store';
