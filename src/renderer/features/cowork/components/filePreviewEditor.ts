import type { PreviewableFileExtension } from '@shared/filePreview';

export type FilePreviewEditorLanguage =
  | 'bat'
  | 'cpp'
  | 'csharp'
  | 'css'
  | 'go'
  | 'html'
  | 'ini'
  | 'java'
  | 'javascript'
  | 'json'
  | 'less'
  | 'markdown'
  | 'plaintext'
  | 'powershell'
  | 'python'
  | 'rust'
  | 'scss'
  | 'shell'
  | 'sql'
  | 'typescript'
  | 'xml'
  | 'yaml';

const FILE_PREVIEW_EDITOR_LANGUAGES: Record<PreviewableFileExtension, FilePreviewEditorLanguage> = {
  '.bash': 'shell',
  '.bat': 'bat',
  '.c': 'cpp',
  '.conf': 'ini',
  '.cpp': 'cpp',
  '.cs': 'csharp',
  '.css': 'css',
  '.csv': 'plaintext',
  '.go': 'go',
  '.h': 'cpp',
  '.html': 'html',
  '.ini': 'ini',
  '.java': 'java',
  '.js': 'javascript',
  '.json': 'json',
  '.jsx': 'javascript',
  '.less': 'less',
  '.log': 'plaintext',
  '.markdown': 'markdown',
  '.md': 'markdown',
  '.properties': 'ini',
  '.ps1': 'powershell',
  '.py': 'python',
  '.rs': 'rust',
  '.scss': 'scss',
  '.sh': 'shell',
  '.sql': 'sql',
  '.toml': 'ini',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.txt': 'plaintext',
  '.xml': 'xml',
  '.yaml': 'yaml',
  '.yml': 'yaml',
};

export function getFilePreviewEditorLanguage(
  extension: PreviewableFileExtension,
): FilePreviewEditorLanguage {
  return FILE_PREVIEW_EDITOR_LANGUAGES[extension];
}

export function isValidJsonDocument(content: string): boolean {
  try {
    JSON.parse(content);
    return true;
  } catch {
    return false;
  }
}

export function hasUnsavedFilePreviewChanges(draft: string, savedContent: string): boolean {
  return draft !== savedContent;
}

export function runFilePreviewSingleFlight<T>(
  holder: { current: Promise<T> | null },
  operation: () => Promise<T>,
): Promise<T> {
  if (holder.current) return holder.current;

  const promise = operation().finally(() => {
    if (holder.current === promise) holder.current = null;
  });
  holder.current = promise;
  return promise;
}

export async function isFilePreviewCleanAfterSave(
  inFlightSave: Promise<unknown> | null,
  getDraft: () => string,
  getSavedContent: () => string,
): Promise<boolean> {
  if (inFlightSave) await inFlightSave;
  return !hasUnsavedFilePreviewChanges(getDraft(), getSavedContent());
}

export function deferFilePreviewGrantRevocation(
  editToken: string,
  revoke: (editToken: string) => void,
  schedule: (callback: () => void) => void,
): () => void {
  let active = true;
  schedule(() => {
    if (active) revoke(editToken);
  });
  return () => {
    active = false;
  };
}
