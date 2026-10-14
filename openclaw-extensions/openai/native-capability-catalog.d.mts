import type {
  PluginCapabilityCatalog,
  PluginCapabilityCatalogHostContext,
} from 'openclaw/plugin-sdk/plugin-entry';
declare const native: (context: PluginCapabilityCatalogHostContext) => PluginCapabilityCatalog;
export default native;
