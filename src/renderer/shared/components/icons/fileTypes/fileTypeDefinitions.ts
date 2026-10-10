/** Shared file icon shapes and type metadata for React and Lit consumers. */
export const FileIconKind = {
  word: 'word',
  excel: 'excel',
  ppt: 'ppt',
  pdf: 'pdf',
  archive: 'archive',
  code: 'code',
  text: 'text',
  audio: 'audio',
  video: 'video',
  image: 'image',
} as const;
export type FileIconKind = (typeof FileIconKind)[keyof typeof FileIconKind];
export interface FileIconShape {
  path: string;
  text?: string;
  textSize?: number;
}
const DOCUMENT_PATH =
  'M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z';
export const FILE_ICON_SHAPES: Record<FileIconKind, FileIconShape> = {
  [FileIconKind.word]: { path: DOCUMENT_PATH, text: 'W', textSize: 7 },
  [FileIconKind.excel]: { path: DOCUMENT_PATH, text: 'X', textSize: 7 },
  [FileIconKind.ppt]: { path: DOCUMENT_PATH, text: 'P', textSize: 7 },
  [FileIconKind.pdf]: { path: DOCUMENT_PATH, text: 'PDF', textSize: 5.5 },
  [FileIconKind.archive]: {
    path: 'M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5m8.25 3v6.75m0 0l-3-3m3 3l3-3M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z',
  },
  [FileIconKind.code]: {
    path: 'M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5',
  },
  [FileIconKind.text]: {
    path: 'M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z',
  },
  [FileIconKind.audio]: {
    path: 'M9 9l10.5-3m0 6.553v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 11-.99-3.467l2.31-.66a2.25 2.25 0 001.632-2.163zm0 0V2.25L9 5.25v10.303m0 0v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 01-.99-3.467l2.31-.66A2.25 2.25 0 009 15.553z',
  },
  [FileIconKind.video]: {
    path: 'M3.375 19.5h17.25m-17.25 0a1.125 1.125 0 01-1.125-1.125M3.375 19.5h1.5C5.496 19.5 6 18.996 6 18.375m-3.75 0V5.625m0 12.75v-1.5c0-.621.504-1.125 1.125-1.125m18.375 2.625V5.625m0 12.75c0 .621-.504 1.125-1.125 1.125m1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125m0 3.75h-1.5A1.125 1.125 0 0118 18.375M20.625 4.5H3.375m17.25 0c.621 0 1.125.504 1.125 1.125M20.625 4.5h-1.5C18.504 4.5 18 5.004 18 5.625m3.75 0v1.5c0 .621-.504 1.125-1.125 1.125M3.375 4.5c-.621 0-1.125.504-1.125 1.125M3.375 4.5h1.5C5.496 4.5 6 5.004 6 5.625m-3.75 0v1.5c0 .621.504 1.125 1.125 1.125m0 0h1.5m-1.5 0c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125m1.5-3.75C5.496 8.25 6 7.746 6 7.125v-1.5M4.875 8.25C5.496 8.25 6 8.754 6 9.375v1.5m0-5.25v5.25m0-5.25C6 5.004 6.504 4.5 7.125 4.5h9.75c.621 0 1.125.504 1.125 1.125m1.125 2.625h1.5m-1.5 0A1.125 1.125 0 0118 7.125v-1.5m1.125 2.625c-.621 0-1.125.504-1.125 1.125v1.5m2.625-2.625c.621 0 1.125.504 1.125 1.125v1.5c0 .621-.504 1.125-1.125 1.125M18 5.625v5.25M7.125 12h9.75m-9.75 0A1.125 1.125 0 016 10.875M7.125 12C6.504 12 6 12.504 6 13.125m0-2.25C6 11.496 5.496 12 4.875 12M18 10.875c0 .621-.504 1.125-1.125 1.125M18 10.875c0 .621.504 1.125 1.125 1.125m-2.25 0c.621 0 1.125.504 1.125 1.125m-12 5.25v-5.25m0 5.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125m-12 0v-1.5c0-.621-.504-1.125-1.125-1.125M18 18.375v-5.25m0 5.25v-1.5c0-.621.504-1.125 1.125-1.125M18 13.125v1.5c0 .621.504 1.125 1.125 1.125M18 13.125c0-.621.504-1.125 1.125-1.125M6 13.125v1.5c0 .621-.504 1.125-1.125 1.125M6 13.125C6 12.504 5.496 12 4.875 12m-1.5 0h1.5m14.25 0h1.5',
  },
  [FileIconKind.image]: {
    path: 'M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z',
  },
};
export interface FileTypeDefinition {
  iconKind: FileIconKind;
  color: string;
  label: string;
}
const extensionDefinitions: Record<string, FileTypeDefinition> = {};
const register = (extensions: string[], definition: FileTypeDefinition) => {
  for (const extension of extensions) extensionDefinitions[extension] = definition;
};
register(['.doc', '.docx'], { iconKind: FileIconKind.word, color: '#2B579A', label: 'Word' });
register(['.xls', '.xlsx', '.csv'], {
  iconKind: FileIconKind.excel,
  color: '#217346',
  label: 'Excel',
});
register(['.ppt', '.pptx'], { iconKind: FileIconKind.ppt, color: '#D24726', label: 'PPT' });
register(['.pdf'], { iconKind: FileIconKind.pdf, color: '#FF0000', label: 'PDF' });
register(['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2'], {
  iconKind: FileIconKind.archive,
  color: '#F59E0B',
  label: 'Archive',
});
register(
  [
    '.js',
    '.ts',
    '.tsx',
    '.jsx',
    '.py',
    '.java',
    '.go',
    '.rs',
    '.c',
    '.cpp',
    '.h',
    '.css',
    '.html',
    '.xml',
    '.sh',
    '.bat',
    '.rb',
    '.php',
    '.swift',
    '.kt',
  ],
  { iconKind: FileIconKind.code, color: '#8B5CF6', label: 'Code' },
);
register(
  ['.txt', '.md', '.log', '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.env', '.gitignore'],
  { iconKind: FileIconKind.text, color: '#6B7280', label: 'Text' },
);
register(['.mp3', '.wav', '.flac', '.ogg', '.aac', '.m4a', '.wma'], {
  iconKind: FileIconKind.audio,
  color: '#EC4899',
  label: 'Audio',
});
register(['.mp4', '.avi', '.mov', '.mkv', '.wmv', '.flv', '.webm'], {
  iconKind: FileIconKind.video,
  color: '#6366F1',
  label: 'Video',
});
register(
  ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.tiff', '.tif', '.ico', '.avif'],
  { iconKind: FileIconKind.image, color: '#3B82F6', label: 'Image' },
);
const DEFAULT_FILE_TYPE: FileTypeDefinition = {
  iconKind: FileIconKind.text,
  color: '#9CA3AF',
  label: 'File',
};
export function getFileTypeDefinition(fileName: string): FileTypeDefinition {
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex === -1) return DEFAULT_FILE_TYPE;
  return extensionDefinitions[fileName.slice(dotIndex).toLowerCase()] ?? DEFAULT_FILE_TYPE;
}
