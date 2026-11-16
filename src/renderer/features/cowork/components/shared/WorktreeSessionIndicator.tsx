import { useSelector } from 'react-redux';

import { i18nService } from '@/services/i18n';
import GitBranchIcon from '@/shared/components/icons/GitBranchIcon';
import type { RootState } from '@/store';

export function WorktreeSessionIndicator({
  sessionId,
  nativeSessionKey,
  className = '',
}: {
  sessionId: string;
  nativeSessionKey?: string;
  className?: string;
}) {
  const isWorktree = useSelector((state: RootState) => {
    const binding = state.cowork?.sessionWorktreeBindings?.[sessionId];
    return binding?.isWorktree === true && binding.nativeSessionKey === nativeSessionKey;
  });
  if (!isWorktree) return null;
  const label = i18nService.t('worktreeSessionIndicator');
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`inline-flex shrink-0 text-secondary opacity-70 ${className}`}
    >
      <GitBranchIcon className="h-3.5 w-3.5" />
    </span>
  );
}
