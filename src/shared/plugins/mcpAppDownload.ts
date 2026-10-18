export const MCP_APP_DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024;
export const MCP_APP_DOWNLOAD_TYPES: Readonly<Record<string, readonly string[]>> = {
  'application/vnd.jgraph.mxfile': ['drawio'],
  'application/xml': ['xml', 'drawio'],
  'image/svg+xml': ['svg'],
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/webp': ['webp'],
  'application/pdf': ['pdf'],
  'text/plain': ['txt'],
  'text/csv': ['csv'],
  'text/markdown': ['md'],
  'application/json': ['json'],
};
export interface McpAppDownloadInput {
  fileName: string;
  mimeType: string;
  dataBase64: string;
}

export function validMcpAppDownloadBase64(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length % 4 === 0 &&
    value.length <= Math.ceil(MCP_APP_DOWNLOAD_MAX_BYTES / 3) * 4 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value)
  );
}

export function validMcpAppDownloadName(name: unknown, mime: unknown): boolean {
  if (
    typeof name !== 'string' ||
    name.length > 200 ||
    !name ||
    /[<>:"/\\|?*\u0000-\u001f]/.test(name) ||
    /[. ]$/.test(name)
  )
    return false;
  const extension = name.split('.').pop()?.toLowerCase();
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) return false;
  return (
    typeof mime === 'string' &&
    Boolean(extension && MCP_APP_DOWNLOAD_TYPES[mime]?.includes(extension))
  );
}
