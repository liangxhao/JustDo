export const EXTENSION_OUTBOUND_HEADER_MANIFEST_FILE = 'outbound-header-policy.json';

export type ExtensionOutboundHeaderGroupV1 = {
  baseUrlWhitelist: string[];
  headerNames: string[];
};

export type ExtensionOutboundHeaderManifestV1 = {
  schemaVersion: 1;
  groups: ExtensionOutboundHeaderGroupV1[];
};
