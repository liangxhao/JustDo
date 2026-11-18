import {
  isMcpAppResourcePreviewHash,
  isMcpAppResourcePreviewMimeType,
  isMcpAppResourcePreviewName,
  MCP_APP_PREVIEW_MAX_PARTS,
  MCP_APP_PREVIEW_PART_MAX_BYTES,
  type McpAppResourcePreviewStageInput,
} from '@shared/plugins/mcpAppResourcePreview';
import { mcpAppRecord } from '@shared/plugins/mcpApps';
import { z } from 'zod';

const externalSchemes = new Set([
  'file:',
  'openclaw-file:',
  'app-file:',
  'ui:',
  'blob:',
  'data:',
  'http:',
  'https:',
]);

const isPluginResource = (uri: string): boolean => {
  const url = URL.parse(uri);
  return Boolean(url && !externalSchemes.has(url.protocol) && !url.username && !url.password);
};

const previewSchema = z.strictObject({
  name: z.string().refine(isMcpAppResourcePreviewName),
  mimeType: z.string().refine(isMcpAppResourcePreviewMimeType),
  sha256: z.string().refine(isMcpAppResourcePreviewHash),
  resources: z
    .array(
      z.strictObject({
        uri: z.string().max(2048).refine(isPluginResource),
        byteLength: z.int().min(1).max(MCP_APP_PREVIEW_PART_MAX_BYTES),
      }),
    )
    .min(1)
    .max(MCP_APP_PREVIEW_MAX_PARTS),
});

export async function readMcpAppResourcePreview(
  input: unknown,
  readResource: (uri: string) => Promise<unknown>,
  isCurrent: () => boolean,
): Promise<McpAppResourcePreviewStageInput> {
  const { name, mimeType, sha256, resources } = previewSchema.parse(input);
  if (new Set(resources.map(resource => resource.uri)).size !== resources.length)
    throw new Error('Duplicate App preview resource');
  const parts: McpAppResourcePreviewStageInput['parts'] = [];
  for (const { uri, byteLength } of resources) {
    if (!isCurrent()) throw new Error('App resource preview is no longer current');
    const response = mcpAppRecord(await readResource(uri));
    const contents = response?.contents;
    const part =
      Array.isArray(contents) && contents.length === 1 ? mcpAppRecord(contents[0]) : null;
    if (
      !isCurrent() ||
      part?.uri !== uri ||
      part.mimeType !== mimeType ||
      part.text !== undefined ||
      typeof part.blob !== 'string' ||
      part.blob.length !== Math.ceil(byteLength / 3) * 4
    )
      throw new Error('Invalid App preview resource');
    parts.push({ byteLength, blob: part.blob });
  }
  return { name, mimeType, sha256, parts };
}
