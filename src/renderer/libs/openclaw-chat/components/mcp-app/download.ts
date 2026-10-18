import {
  MCP_APP_DOWNLOAD_MAX_BYTES,
  type McpAppDownloadInput,
  validMcpAppDownloadBase64,
  validMcpAppDownloadName,
} from '@shared/plugins/mcpAppDownload';
import { mcpAppRecord } from '@shared/plugins/mcpApps';

/** Accept embedded bytes only. Resource URIs are names, never a network fetch instruction. */
export function prepareMcpAppDownload(contents: unknown): McpAppDownloadInput {
  if (!Array.isArray(contents) || contents.length !== 1) throw new Error('Expected one App file');
  const wrapper = mcpAppRecord(contents[0]);
  if (wrapper?.type !== 'resource') throw new Error('Expected embedded App file');
  const content = mcpAppRecord(wrapper.resource);
  if (!content || typeof content.uri !== 'string' || typeof content.mimeType !== 'string')
    throw new Error('Invalid App file');
  const uri = new URL(content.uri);
  const fileName = decodeURIComponent(uri.pathname.split('/').pop() ?? '');
  if (!validMcpAppDownloadName(fileName, content.mimeType)) throw new Error('Unsupported App file');
  let dataBase64: string;
  if (typeof content.text === 'string' && content.blob === undefined) {
    const bytes = new TextEncoder().encode(content.text);
    if (!bytes.length || bytes.byteLength > MCP_APP_DOWNLOAD_MAX_BYTES)
      throw new Error('Invalid App file size');
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192)
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    dataBase64 = btoa(binary);
  } else if (typeof content.blob === 'string' && content.text === undefined) {
    dataBase64 = content.blob;
    if (!validMcpAppDownloadBase64(dataBase64)) throw new Error('Invalid App file bytes');
  } else throw new Error('Missing embedded App file');
  return { fileName, mimeType: content.mimeType, dataBase64 };
}
