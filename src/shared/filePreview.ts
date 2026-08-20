export const PREVIEWABLE_FILE_EXTENSIONS = [
  '.md',
  '.markdown',
  '.json',
  '.txt',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.xml',
  '.csv',
  '.log',
  '.conf',
  '.properties',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.html',
  '.css',
  '.scss',
  '.less',
  '.py',
  '.sh',
  '.bash',
  '.ps1',
  '.bat',
  '.java',
  '.go',
  '.rs',
  '.c',
  '.h',
  '.cpp',
  '.cs',
  '.sql',
] as const;

export const MAX_PREVIEW_FILE_BYTES = 2 * 1024 * 1024;

export const FilePreviewIpc = {
  AuthorizeEdit: 'shell:authorizePreviewFileEdit',
  Read: 'shell:readPreviewFile',
  RevokeEdit: 'shell:revokePreviewFileEdit',
  Write: 'shell:writePreviewFile',
} as const;

export type PreviewableFileExtension = (typeof PREVIEWABLE_FILE_EXTENSIONS)[number];

export type FilePreviewReadResult =
  | {
      success: true;
      content: string;
      editToken: string;
      filePath: string;
      version: string;
    }
  | {
      success: false;
      error?: string;
      notFound?: boolean;
      tooLarge?: boolean;
    };

export interface FilePreviewWriteRequest {
  content: string;
  editToken: string;
  expectedVersion: string;
}

export interface FilePreviewEditAuthorizationRequest {
  editToken: string;
  expectedVersion: string;
}

export type FilePreviewEditAuthorizationResult =
  | { success: true }
  | {
      success: false;
      conflict?: boolean;
      error?: string;
      notFound?: boolean;
      reload?: boolean;
      tooLarge?: boolean;
    };

export type FilePreviewWriteResult =
  | {
      success: true;
      version: string;
    }
  | {
      success: false;
      conflict?: boolean;
      error?: string;
      notFound?: boolean;
      reload?: boolean;
      tooLarge?: boolean;
      unauthorized?: boolean;
    };

export function getPreviewableFileExtension(filePath: string): PreviewableFileExtension | null {
  const normalizedPath = filePath.toLowerCase();
  return PREVIEWABLE_FILE_EXTENSIONS.find(extension => normalizedPath.endsWith(extension)) ?? null;
}
