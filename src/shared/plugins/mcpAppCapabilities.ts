import { mcpAppRecord } from './mcpApps';

/** Tool metadata is the capability signal; transport and server names are not. */
export function mcpToolAppResourceUri(tool: unknown): string | undefined {
  const value = mcpAppRecord(tool);
  const meta = mcpAppRecord(value?._meta);
  const uri =
    value?.uiResourceUri ?? mcpAppRecord(meta?.ui)?.resourceUri ?? meta?.['ui/resourceUri'];
  if (typeof uri !== 'string' || !uri || uri.length > 2048 || uri.trim() !== uri) return undefined;
  try {
    return uri.startsWith('ui://') && new URL(uri).protocol === 'ui:' ? uri : undefined;
  } catch {
    return undefined;
  }
}

export const mcpToolHasApp = (tool: unknown): boolean => Boolean(mcpToolAppResourceUri(tool));
