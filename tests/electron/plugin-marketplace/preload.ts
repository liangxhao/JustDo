import { contextBridge, ipcRenderer } from 'electron';

import { createExtensionChangedSubscription } from '../../../src/main/preload/extensions';
import { createPluginOperationSubscription } from '../../../src/main/preload/pluginOperations';
import {
  type ExtensionDeleteRequest,
  type ExtensionImportProgress,
  type ExtensionImportRequest,
  ExtensionIpc,
  type ExtensionSetEnabledRequest,
  type ExtensionUpdateConfigurationRequest,
} from '../../../src/shared/plugins/extensions';
import {
  type MarketplaceCategoryRequest,
  type MarketplaceDetailRequest,
  type MarketplaceInstallRequest,
  MarketplaceIpc,
  type MarketplacePluginKind,
  type MarketplaceQuery,
  type MarketplaceResolveRequest,
  type MarketplaceUpdateCheckRequest,
} from '../../../src/shared/plugins/marketplace';
import type { PluginOperationContext } from '../../../src/shared/plugins/pluginOperation';
import type { OpenClawSkillSource } from '../../../src/shared/plugins/skills';
import { LocalSpeechModelIpc, type LocalSpeechModelStatus } from '../../../src/shared/speech/localSpeechModels';

// This isolated test window uses the same channels, argument order and subscription
// implementation as the application preload. No result or progress is synthesized here.
contextBridge.exposeInMainWorld('electron', {
  marketplace: {
    resolveInstalled: (request: MarketplaceResolveRequest) =>
      ipcRenderer.invoke(MarketplaceIpc.ResolveInstalled, request),
    listSources: (kind?: MarketplacePluginKind) =>
      ipcRenderer.invoke(MarketplaceIpc.ListSources, kind),
    listCategories: (request: MarketplaceCategoryRequest) =>
      ipcRenderer.invoke(MarketplaceIpc.ListCategories, request),
    search: (query: MarketplaceQuery) => ipcRenderer.invoke(MarketplaceIpc.Search, query),
    checkUpdates: (request: MarketplaceUpdateCheckRequest) =>
      ipcRenderer.invoke(MarketplaceIpc.CheckUpdates, request),
    detail: (request: MarketplaceDetailRequest) =>
      ipcRenderer.invoke(MarketplaceIpc.Detail, request),
    install: (request: MarketplaceInstallRequest, context?: PluginOperationContext) =>
      ipcRenderer.invoke(MarketplaceIpc.Install, request, context),
  },
  plugins: { onOperationProgress: createPluginOperationSubscription() },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    setEnabled: (options: { id: string; enabled: boolean }, context?: PluginOperationContext) =>
      ipcRenderer.invoke('skills:setEnabled', options, context),
    delete: (
      options: { id: string; source?: OpenClawSkillSource },
      context?: PluginOperationContext,
    ) => ipcRenderer.invoke('skills:delete', options, context),
  },
  extensions: {
    list: () => ipcRenderer.invoke(ExtensionIpc.List),
    importPath: (request: ExtensionImportRequest, context?: PluginOperationContext) =>
      ipcRenderer.invoke(ExtensionIpc.Import, request, context),
    onChanged: createExtensionChangedSubscription(),
    onImportProgress: (callback: (progress: ExtensionImportProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: ExtensionImportProgress) => callback(progress);
      ipcRenderer.on(ExtensionIpc.ImportProgress, handler);
      return () => ipcRenderer.removeListener(ExtensionIpc.ImportProgress, handler);
    },
    updateConfiguration: (request: ExtensionUpdateConfigurationRequest, context?: PluginOperationContext) =>
      ipcRenderer.invoke(ExtensionIpc.UpdateConfiguration, request, context),
    setEnabled: (request: ExtensionSetEnabledRequest, context?: PluginOperationContext) =>
      ipcRenderer.invoke(ExtensionIpc.SetEnabled, request, context),
    delete: (request: ExtensionDeleteRequest, context?: PluginOperationContext) =>
      ipcRenderer.invoke(ExtensionIpc.Delete, request, context),
  },
  mcp: {
    list: () => ipcRenderer.invoke('mcp:list'),
    setEnabled: (options: { id: string; enabled: boolean }, context?: PluginOperationContext) =>
      ipcRenderer.invoke('mcp:setEnabled', options, context),
    delete: (id: string, context?: PluginOperationContext) =>
      ipcRenderer.invoke('mcp:delete', id, context),
  },
  dialog: {
    // The driver supplies the user's file selection. Import, review and feedback
    // still run through the production manager, preload channels and handlers.
    selectFiles: () => ipcRenderer.invoke('marketplace-probe:select-inputs'),
    selectFolders: () => ipcRenderer.invoke('marketplace-probe:select-inputs'),
  },
  localSpeechModels: {
    list: () => ipcRenderer.invoke(LocalSpeechModelIpc.List),
    onChanged: (callback: (status: LocalSpeechModelStatus) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: LocalSpeechModelStatus) => callback(status);
      ipcRenderer.on(LocalSpeechModelIpc.Changed, handler);
      return () => ipcRenderer.removeListener(LocalSpeechModelIpc.Changed, handler);
    },
  },
});

contextBridge.exposeInMainWorld('marketplaceProbe', {
  inventory: (kind: MarketplacePluginKind) =>
    ipcRenderer.invoke('marketplace-probe:inventory', kind),
  setScenario: (scenario: {
    pluginId?: string;
    failure?: 'metadata' | 'download' | 'invalid' | 'activation' | 'refresh';
    delayMs?: number;
    version?: string;
  }) => ipcRenderer.invoke('marketplace-probe:scenario', scenario),
  evidence: () => ipcRenderer.invoke('marketplace-probe:evidence'),
  selectInputs: (paths: string[]) => ipcRenderer.invoke('marketplace-probe:queue-inputs', paths),
  nativeInventory: () => ipcRenderer.invoke('marketplace-probe:native-inventory'),
});
