import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import type { BrowserLocalHtmlPreviewResult } from '../../../shared/browser/browser';

const HTML_EXTENSIONS = new Set(['.htm', '.html', '.xhtml']);

const localHtmlFilePathFromUrl = (rawUrl: string): string | null => {
  try {
    if (/[\u0000-\u0020\u007f]/u.test(rawUrl)) return null;
    const url = new URL(rawUrl);
    if (url.protocol !== 'file:') return null;
    const filePath = fileURLToPath(url);
    return HTML_EXTENSIONS.has(path.extname(filePath).toLowerCase()) ? filePath : null;
  } catch {
    return null;
  }
};

export const isLocalHtmlPreviewUrl = (url: string): boolean =>
  localHtmlFilePathFromUrl(url) !== null;

export const resolveLocalHtmlPreviewFilePath = async (url: string): Promise<string | null> => {
  try {
    const filePath = localHtmlFilePathFromUrl(url);
    if (!filePath) return null;
    return (await fs.promises.stat(filePath)).isFile() ? filePath : null;
  } catch {
    return null;
  }
};

// Keep the existing IPC result shape; Chromium now loads the original file
// directly, with its native file-origin rules and no application preview server.
export const createLocalHtmlPreview = async (
  filePath: string,
  workingDirectory?: string,
): Promise<BrowserLocalHtmlPreviewResult> => {
  try {
    const trimmedPath = filePath.trim();
    const sourceUrl = /^file:/iu.test(trimmedPath) ? new URL(trimmedPath) : null;
    const resolvedPath = sourceUrl
      ? fileURLToPath(sourceUrl)
      : path.resolve(workingDirectory?.trim() || process.cwd(), trimmedPath);
    if (!HTML_EXTENSIONS.has(path.extname(resolvedPath).toLowerCase())) {
      return { success: false, errorCode: 'invalid_type' };
    }
    if (!(await fs.promises.stat(resolvedPath)).isFile()) {
      return { success: false, errorCode: 'invalid_source' };
    }
    const url = pathToFileURL(resolvedPath);
    if (sourceUrl) {
      url.search = sourceUrl.search;
      url.hash = sourceUrl.hash;
    }
    return {
      success: true,
      url: url.href,
      filePath: resolvedPath,
      rootPath: path.dirname(resolvedPath),
      previewRootUrl: new URL('.', url).href,
    };
  } catch (error) {
    const notFound = error instanceof Error && 'code' in error && error.code === 'ENOENT';
    return { success: false, errorCode: notFound ? 'not_found' : 'failed' };
  }
};
