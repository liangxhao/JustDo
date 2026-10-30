export { useSelector } from 'react-redux';

const hostRoot = process.env.APP_PLUGIN_HOST_ROOT;
if (!hostRoot) throw new Error('Host integration requires APP_PLUGIN_HOST_ROOT');
const host = (file: string) => import(/* @vite-ignore */ `${hostRoot}/${file}`);
const state = await host('src/renderer/store/index.ts');
const service = await host('src/renderer/features/cowork/coworkService.ts');
const drafts = await host('src/renderer/features/cowork/coworkSlice.ts');
const extensions = await host('src/renderer/features/plugins/extensions/useExtensionEnablement.ts');
const nativeIds = await host('src/shared/plugins/nativeIds.ts');
export const store = state.store;
export const coworkService = service.coworkService;
export const addDraftMessageQuote = drafts.addDraftMessageQuote;
export const setDraftPrompt = drafts.setDraftPrompt;
export const useExtensionEnabled = extensions.useExtensionEnabled;
export const useExtensionAvailability = extensions.useExtensionAvailability;
export const OpenClawExtensionId = nativeIds.OpenClawExtensionId;
