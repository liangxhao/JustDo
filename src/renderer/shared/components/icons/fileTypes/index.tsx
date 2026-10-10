import type { FC } from 'react';

import { FILE_ICON_SHAPES, FileIconKind, getFileTypeDefinition } from './fileTypeDefinitions';
interface IconProps {
  className?: string;
}
function createFileIcon(kind: FileIconKind): FC<IconProps> {
  const shape = FILE_ICON_SHAPES[kind];
  return function FileIcon({ className }) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        className={className}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d={shape.path} />
        {shape.text && (
          <text
            x="12"
            y="17.5"
            textAnchor="middle"
            fill="currentColor"
            stroke="none"
            fontSize={shape.textSize}
            fontWeight="bold"
            fontFamily="Arial, sans-serif"
          >
            {shape.text}
          </text>
        )}
      </svg>
    );
  };
}
export const WordIcon = createFileIcon(FileIconKind.word);
export const ExcelIcon = createFileIcon(FileIconKind.excel);
export const PptIcon = createFileIcon(FileIconKind.ppt);
export const PdfIcon = createFileIcon(FileIconKind.pdf);
export const ArchiveIcon = createFileIcon(FileIconKind.archive);
export const CodeFileIcon = createFileIcon(FileIconKind.code);
export const TextFileIcon = createFileIcon(FileIconKind.text);
export const AudioFileIcon = createFileIcon(FileIconKind.audio);
export const VideoFileIcon = createFileIcon(FileIconKind.video);
export const ImageFileIcon = createFileIcon(FileIconKind.image);
export const FILE_TYPE_ICONS: Record<FileIconKind, FC<IconProps>> = {
  [FileIconKind.word]: WordIcon,
  [FileIconKind.excel]: ExcelIcon,
  [FileIconKind.ppt]: PptIcon,
  [FileIconKind.pdf]: PdfIcon,
  [FileIconKind.archive]: ArchiveIcon,
  [FileIconKind.code]: CodeFileIcon,
  [FileIconKind.text]: TextFileIcon,
  [FileIconKind.audio]: AudioFileIcon,
  [FileIconKind.video]: VideoFileIcon,
  [FileIconKind.image]: ImageFileIcon,
};
export interface FileTypeInfo {
  icon: FC<IconProps>;
  color: string;
  label: string;
}
/** Extension matching is case-insensitive. */
export function getFileTypeInfo(fileName: string): FileTypeInfo {
  const { iconKind, color, label } = getFileTypeDefinition(fileName);
  return { icon: FILE_TYPE_ICONS[iconKind], color, label };
}
