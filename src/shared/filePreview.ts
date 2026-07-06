export const PREVIEWABLE_FILE_EXTENSIONS = ['.md', '.markdown', '.json', '.txt'] as const;

export type PreviewableFileExtension = (typeof PREVIEWABLE_FILE_EXTENSIONS)[number];

export function getPreviewableFileExtension(filePath: string): PreviewableFileExtension | null {
  const normalizedPath = filePath.split(/[?#]/, 1)[0].toLowerCase();
  return (
    PREVIEWABLE_FILE_EXTENSIONS.find(extension => normalizedPath.endsWith(extension)) ?? null
  );
}
