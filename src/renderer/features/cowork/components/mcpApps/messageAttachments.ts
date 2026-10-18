import { mcpAppRecord } from '@shared/plugins/mcpApps';

import type { DraftAttachment } from '@/features/cowork/coworkSlice';

/** Convert explicitly accepted App content through the existing attachment writer. */
export async function saveAppMessageAttachments(
  content: unknown[],
  cwd: string,
  isCurrent: () => boolean,
): Promise<DraftAttachment[]> {
  if (JSON.stringify(content).length > 8 * 1024 * 1024 || content.length > 64)
    throw new Error('App message is too large');
  const files = content.flatMap((value, index) => {
    const block = mcpAppRecord(value);
    const resource = mcpAppRecord(block?.resource);
    if (block?.type === 'text') return [];
    const image = block?.type === 'image';
    const binary = image ? block.data : resource?.blob;
    const mimeType = image ? block.mimeType : resource?.mimeType;
    const title = mcpAppRecord(block?._meta)?.['openai/title'];
    const baseName =
      (typeof title === 'string'
        ? title
        : typeof block?.name === 'string'
          ? block.name
          : `resource-${index + 1}`
      )
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
        .slice(0, 120) || `resource-${index + 1}`;
    if (
      typeof binary === 'string' &&
      typeof mimeType === 'string' &&
      /^[\w.+-]+\/[\w.+-]+$/.test(mimeType) &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(binary)
    ) {
      return [{ dataBase64: binary, fileName: baseName, mimeType, image }];
    }
    if (
      block?.type !== 'resource_link' &&
      !(block?.type === 'resource' && typeof resource?.text === 'string')
    ) {
      throw new Error('Unsupported App message content');
    }
    const bytes = new TextEncoder().encode(JSON.stringify(block, null, 2));
    let text = '';
    for (const byte of bytes) text += String.fromCharCode(byte);
    return [
      { dataBase64: btoa(text), fileName: `${baseName}.txt`, mimeType: 'text/plain', image: false },
    ];
  });
  const attachments: DraftAttachment[] = [];
  for (const file of files) {
    if (!isCurrent()) throw new Error('App draft changed');
    const saved = await window.electron.dialog.saveInlineFile({ ...file, cwd });
    if (!saved.success || !saved.path || !isCurrent())
      throw new Error('App attachment was not admitted');
    attachments.push({
      path: saved.path,
      name: file.fileName,
      isImage: file.image,
      ...(file.image ? { dataUrl: `data:${file.mimeType};base64,${file.dataBase64}` } : {}),
    });
  }
  return attachments;
}
