import type { ComponentType } from 'react';

import {
  CodeFileIcon,
  getFileTypeInfo,
  TextFileIcon,
} from '@/shared/components/icons/fileTypes';

interface WorkspaceFileIconAppearance {
  color: string;
  glyph?: string;
  icon?: ComponentType<{ className?: string }>;
  kind: string;
}

const exactNameAppearances: Record<string, WorkspaceFileIconAppearance> = {
  '.gitattributes': { color: '#f05032', glyph: '◆', kind: 'git' },
  '.gitignore': { color: '#f05032', glyph: '◆', kind: 'git' },
  '.gitmodules': { color: '#f05032', glyph: '◆', kind: 'git' },
  '.prettierignore': { color: '#22b8cf', icon: TextFileIcon, kind: 'prettier' },
  '.prettierrc': { color: '#22b8cf', icon: TextFileIcon, kind: 'prettier' },
  'agents.md': { color: '#4ade80', glyph: 'M↓', kind: 'markdown' },
  'claude.md': { color: '#f59e0b', glyph: '✳', kind: 'claude' },
  'license': { color: '#9ca3af', icon: TextFileIcon, kind: 'text' },
};

const extensionAppearances: Record<string, WorkspaceFileIconAppearance> = {
  '.cjs': { color: '#d4b830', glyph: 'JS', kind: 'javascript' },
  '.css': { color: '#3b82f6', glyph: '#', kind: 'css' },
  '.htm': { color: '#e87924', glyph: '#', kind: 'html' },
  '.html': { color: '#e87924', glyph: '#', kind: 'html' },
  '.js': { color: '#d4b830', glyph: 'JS', kind: 'javascript' },
  '.json': { color: '#e87924', glyph: '{}', kind: 'json' },
  '.jsonc': { color: '#e87924', glyph: '{}', kind: 'json' },
  '.jsx': { color: '#61dafb', glyph: 'JS', kind: 'javascript-react' },
  '.md': { color: '#4ade80', glyph: 'M↓', kind: 'markdown' },
  '.mjs': { color: '#d4b830', glyph: 'JS', kind: 'javascript' },
  '.scss': { color: '#ec4899', glyph: '#', kind: 'stylesheet' },
  '.ts': { color: '#3178c6', glyph: 'TS', kind: 'typescript' },
  '.tsx': { color: '#61dafb', glyph: 'TS', kind: 'typescript-react' },
  '.yaml': { color: '#e11d48', icon: CodeFileIcon, kind: 'yaml' },
  '.yml': { color: '#e11d48', icon: CodeFileIcon, kind: 'yaml' },
};

export const getWorkspaceFileIconAppearance = (
  fileName: string,
): WorkspaceFileIconAppearance => {
  const normalizedName = fileName.toLocaleLowerCase();
  const exactAppearance = exactNameAppearances[normalizedName];
  if (exactAppearance) return exactAppearance;

  if (normalizedName.includes('eslint')) {
    return { color: '#8b5cf6', icon: CodeFileIcon, kind: 'eslint' };
  }
  if (normalizedName.includes('prettier')) {
    return { color: '#22b8cf', icon: TextFileIcon, kind: 'prettier' };
  }

  const dotIndex = normalizedName.lastIndexOf('.');
  const extension = dotIndex >= 0 ? normalizedName.slice(dotIndex) : '';
  const extensionAppearance = extensionAppearances[extension];
  if (extensionAppearance) return extensionAppearance;

  const fallback = getFileTypeInfo(fileName);
  return { color: fallback.color, icon: fallback.icon, kind: fallback.label.toLocaleLowerCase() };
};

interface WorkspaceFileIconProps {
  fileName: string;
}

const WorkspaceFileIcon = ({ fileName }: WorkspaceFileIconProps) => {
  const appearance = getWorkspaceFileIconAppearance(fileName);
  const Icon = appearance.icon;

  return (
    <span
      aria-hidden="true"
      className="flex h-4 w-4 shrink-0 items-center justify-center"
      data-file-icon-kind={appearance.kind}
      style={{ color: appearance.color }}
    >
      {appearance.glyph ? (
        <span className="text-[8px] font-bold leading-none">{appearance.glyph}</span>
      ) : Icon ? (
        <Icon className="h-4 w-4" />
      ) : null}
    </span>
  );
};

export default WorkspaceFileIcon;
