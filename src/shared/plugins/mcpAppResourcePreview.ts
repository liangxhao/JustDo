export const MCP_APP_PREVIEW_RESOURCE = 'ui/preview-resource';
export const MCP_APP_PREVIEW_PART_MAX_BYTES = 8 * 1024 * 1024;
export const MCP_APP_PREVIEW_MAX_PARTS = 4;

export interface McpAppResourcePreviewStageInput {
  name: string;
  mimeType: string;
  sha256: string;
  parts: { byteLength: number; blob: string }[];
}

export interface McpAppStagedResourcePreview {
  filePath: string;
  resourcePreview: { id: string; name: string };
  kind: 'pdf' | 'audio' | 'video' | 'image' | 'text' | 'unsupported';
  url?: string;
  content?: string;
  version?: string;
}

export const isMcpAppResourcePreviewName = (name: unknown): name is string =>
  typeof name === 'string' &&
  name.length > 0 &&
  name.length <= 200 &&
  !/[<>:"/\\|?*\u0000-\u001f\u007f]/.test(name) &&
  !/^ |[. ]$/.test(name) &&
  !/^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[1-9¹²³])(?:\s*\.|$)/i.test(name);

export const isMcpAppResourcePreviewMimeType = (mimeType: unknown): mimeType is string =>
  typeof mimeType === 'string' &&
  mimeType.length <= 255 &&
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(mimeType);

export const isMcpAppResourcePreviewHash = (hash: unknown): hash is string =>
  typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash);
