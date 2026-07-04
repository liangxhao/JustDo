import { app, ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';

const INVALID_FILE_NAME_PATTERN = /[<>:"/\\|?*\u0000-\u001F]/g;
const MAX_INLINE_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_READ_AS_DATA_URL_BYTES = 20 * 1024 * 1024;
const MIME_EXTENSION_MAP: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'application/json': '.json',
  'text/csv': '.csv',
};
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
};

const sanitizeFileName = (value?: string): string => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return 'attachment';
  return (
    path.basename(raw).replace(INVALID_FILE_NAME_PATTERN, ' ').replace(/\s+/g, ' ').trim() ||
    'attachment'
  );
};

const inferExtension = (fileName: string, mimeType?: string): string => {
  const extension = path.extname(fileName).toLowerCase();
  if (extension) return extension;
  const normalized =
    typeof mimeType === 'string' ? mimeType.toLowerCase().split(';')[0].trim() : '';
  return MIME_EXTENSION_MAP[normalized] ?? '';
};

const resolveAttachmentDir = (cwd?: string): string => {
  const trimmed = typeof cwd === 'string' ? cwd.trim() : '';
  if (trimmed) {
    const resolved = path.resolve(trimmed);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      return path.join(resolved, '.cowork-temp', 'attachments', 'manual');
    }
  }
  return path.join(app.getPath('temp'), 'justdo', 'attachments');
};

export const registerLocalFileHandlers = (): void => {
  ipcMain.handle(
    'dialog:saveInlineFile',
    async (
      _event,
      options?: { dataBase64?: string; fileName?: string; mimeType?: string; cwd?: string },
    ) => {
      try {
        const dataBase64 = typeof options?.dataBase64 === 'string' ? options.dataBase64.trim() : '';
        if (!dataBase64) return { success: false, path: null, error: 'Missing file data' };
        const buffer = Buffer.from(dataBase64, 'base64');
        if (!buffer.length) return { success: false, path: null, error: 'Invalid file data' };
        if (buffer.length > MAX_INLINE_ATTACHMENT_BYTES) {
          return {
            success: false,
            path: null,
            error: `File too large (max ${MAX_INLINE_ATTACHMENT_BYTES / 1024 / 1024}MB)`,
          };
        }
        const dir = resolveAttachmentDir(options?.cwd);
        await fs.promises.mkdir(dir, { recursive: true });
        const safeName = sanitizeFileName(options?.fileName);
        const extension = inferExtension(safeName, options?.mimeType);
        const baseName = extension ? safeName.slice(0, -extension.length) : safeName;
        const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const outputPath = path.join(dir, `${baseName || 'attachment'}-${suffix}${extension}`);
        await fs.promises.writeFile(outputPath, buffer);
        return { success: true, path: outputPath };
      } catch (error) {
        return {
          success: false,
          path: null,
          error: error instanceof Error ? error.message : 'Failed to save inline file',
        };
      }
    },
  );

  ipcMain.handle('dialog:readFileAsDataUrl', async (_event, filePath?: string) => {
    try {
      if (typeof filePath !== 'string' || !filePath.trim()) {
        return { success: false, error: 'Missing file path' };
      }
      const resolvedPath = path.resolve(filePath.trim());
      const stat = await fs.promises.stat(resolvedPath);
      if (!stat.isFile()) return { success: false, error: 'Not a file' };
      if (stat.size > MAX_READ_AS_DATA_URL_BYTES) {
        return {
          success: false,
          error: `File too large (max ${MAX_READ_AS_DATA_URL_BYTES / 1024 / 1024}MB)`,
        };
      }
      const buffer = await fs.promises.readFile(resolvedPath);
      const mimeType =
        MIME_BY_EXT[path.extname(resolvedPath).toLowerCase()] || 'application/octet-stream';
      return { success: true, dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}` };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to read file',
      };
    }
  });
};
