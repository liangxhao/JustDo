import { FILE_TYPE_ICONS } from '@/shared/components/icons/fileTypes';
import { getWorkspaceFileIconAppearance } from '@/shared/components/icons/fileTypes/workspaceFileIcons';
export { getWorkspaceFileIconAppearance } from '@/shared/components/icons/fileTypes/workspaceFileIcons';

interface WorkspaceFileIconProps {
  fileName: string;
}

const WorkspaceFileIcon = ({ fileName }: WorkspaceFileIconProps) => {
  const appearance = getWorkspaceFileIconAppearance(fileName);
  const Icon = appearance.iconKind ? FILE_TYPE_ICONS[appearance.iconKind] : undefined;

  return (
    <span
      aria-hidden="true"
      className="flex h-4 w-4 shrink-0 items-center justify-center"
      data-file-icon-kind={appearance.kind}
      style={{ color: appearance.color }}
    >
      {appearance.glyph ? (
        <span className="font-mono text-xs font-bold leading-none">{appearance.glyph}</span>
      ) : Icon ? (
        <Icon className="h-4 w-4" />
      ) : null}
    </span>
  );
};

export default WorkspaceFileIcon;
