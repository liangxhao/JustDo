export const PREVIEWABLE_FILE_EXTENSIONS = [
  '.md',
  '.markdown',
  '.json',
  '.jsonl',
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
  '.cjs',
  '.mjs',
  '.jsx',
  '.ts',
  '.cts',
  '.mts',
  '.tsx',
  '.jsonc',
  '.html',
  '.htm',
  '.xhtml',
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
  '.tsv',
  '.ndjson',
  '.cfg',
  '.config',
  '.cnf',
  '.srt',
  '.vtt',
  '.ass',
  '.lrc',
  '.diff',
  '.patch',
  '.vue',
  '.svelte',
  '.astro',
  '.rb',
  '.php',
  '.lua',
  '.r',
  '.kt',
  '.kts',
  '.swift',
  '.scala',
  '.hpp',
  '.cc',
  '.cxx',
  '.sass',
  '.styl',
  '.graphql',
  '.gql',
  '.proto',
  '.ipynb',
  '.http',
  '.rest',
  '.rst',
  '.adoc',
  '.tex',
  '.bib',
  '.lock',
  '.mk',
  '.service',
  '.desktop',
] as const;

export const MAX_PREVIEW_FILE_BYTES = 2 * 1024 * 1024;
export const HOME_WORKSPACE_SESSION_ID = '__home__';

export const FilePreviewIpc = {
  AuthorizeEdit: 'shell:authorizePreviewFileEdit',
  ListDirectory: 'shell:listWorkspaceDirectory',
  OpenWith: 'shell:openPathWith',
  PrepareMessageLink: 'shell:prepareMessageFileLink',
  Read: 'shell:readPreviewFile',
  RevokeEdit: 'shell:revokePreviewFileEdit',
  Write: 'shell:writePreviewFile',
} as const;

export interface WorkspaceDirectoryEntry {
  filePath: string;
  kind: 'directory' | 'file';
  name: string;
  relativePath: string;
}

export type WorkspaceDirectoryListResult =
  | {
      success: true;
      entries: WorkspaceDirectoryEntry[];
      truncated: boolean;
    }
  | {
      success: false;
      error?: string;
      notFound?: boolean;
    };

export type PreviewableFileExtension = (typeof PREVIEWABLE_FILE_EXTENSIONS)[number];

const PREVIEWABLE_EXTENSIONLESS_FILE_NAMES: Record<string, PreviewableFileExtension> = {
  '.editorconfig': '.ini',
  '.eslintrc': '.txt',
  '.gitattributes': '.txt',
  '.git-blame-ignore-revs': '.txt',
  '.gitignore': '.txt',
  '.gitmodules': '.ini',
  '.npmignore': '.txt',
  '.npmrc': '.ini',
  '.nvmrc': '.txt',
  '.prettierignore': '.txt',
  '.prettierrc': '.txt',
  '.stylelintrc': '.txt',
  authors: '.txt',
  changelog: '.txt',
  dockerfile: '.txt',
  license: '.txt',
  makefile: '.txt',
  notice: '.txt',
  procfile: '.txt',
};

export const AUDIO_PREVIEW_EXTENSIONS = [
  '.mp3',
  '.wav',
  '.wave',
  '.ogg',
  '.oga',
  '.opus',
  '.flac',
  '.m4a',
  '.m4b',
  '.aac',
  '.weba',
] as const;
export const VIDEO_PREVIEW_EXTENSIONS = ['.mp4', '.m4v', '.webm', '.mov', '.mkv'] as const;

export type BrowserFilePreviewKind = 'pdf' | 'audio' | 'video';

export interface BrowserFilePreview {
  kind: BrowserFilePreviewKind;
  filePath: string;
  url: string;
}

export const getBrowserFilePreviewKind = (filePath: string): BrowserFilePreviewKind | null => {
  const extension = /\.[^.\\/]+$/u.exec(filePath)?.[0].toLowerCase();
  if (extension === '.pdf') return 'pdf';
  if (AUDIO_PREVIEW_EXTENSIONS.some(candidate => candidate === extension)) return 'audio';
  if (VIDEO_PREVIEW_EXTENSIONS.some(candidate => candidate === extension)) return 'video';
  return null;
};

export const isBrowserFilePreview = (value: { kind?: string }): value is BrowserFilePreview =>
  value.kind === 'pdf' || value.kind === 'audio' || value.kind === 'video';

export type FilePreviewReadResult =
  | {
      success: true;
      kind?: 'text';
      content: string;
      editToken: string;
      filePath: string;
      version: string;
    }
  | ({ success: true } & BrowserFilePreview)
  | {
      success: false;
      error?: string;
      notFound?: boolean;
      tooLarge?: boolean;
      unsupportedType?: boolean;
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
  const fileName = normalizedPath.split(/[\\/]/).pop() ?? normalizedPath;
  const extension = PREVIEWABLE_FILE_EXTENSIONS.find(candidate => fileName.endsWith(candidate));
  if (extension) return extension;
  if (fileName === '.env' || fileName.startsWith('.env.')) return '.txt';
  return PREVIEWABLE_EXTENSIONLESS_FILE_NAMES[fileName] ?? null;
}
