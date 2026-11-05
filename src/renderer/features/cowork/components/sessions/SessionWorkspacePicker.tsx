import { SessionWorkspaceFailure } from '@shared/cowork/sessionWorkspace';
import { useRef, useState } from 'react';

import { coworkService } from '@/features/cowork/coworkService';
import { i18nService } from '@/services/i18n';
import FolderSwitchIcon from '@/shared/components/icons/FolderSwitchIcon';

import FolderSelectorPopover from '../composer/selection/FolderSelectorPopover';

const failureKeys = {
  [SessionWorkspaceFailure.Invalid]: 'sessionWorkspaceInvalid',
  [SessionWorkspaceFailure.Unsupported]: 'sessionWorkspaceUnsupported',
  [SessionWorkspaceFailure.Busy]: 'sessionWorkspaceBusy',
  [SessionWorkspaceFailure.Unknown]: 'sessionWorkspaceUnknown',
  [SessionWorkspaceFailure.PreparationUnknown]: 'sessionWorkspacePreparationUnknown',
  [SessionWorkspaceFailure.Changed]: 'sessionWorkspaceChanged',
  [SessionWorkspaceFailure.Unavailable]: 'sessionWorkspaceUnavailable',
} as const;

export default function SessionWorkspacePicker({
  sessionId,
  cwd,
  disabled,
}: {
  sessionId: string;
  cwd: string;
  disabled: boolean;
}) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const pendingRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const selectFolder = async (nextCwd: string) => {
    if (disabled || pendingRef.current || nextCwd === cwd) return;
    pendingRef.current = true;
    setSaving(true);
    setOpen(false);
    try {
      const result = await coworkService.setSessionWorkspace({
        sessionId,
        cwd: nextCwd,
        expectedCwd: cwd,
      });
      window.dispatchEvent(
        new CustomEvent('app:showToast', {
          detail: i18nService.t(
            result.success ? 'sessionWorkspaceSaved' : failureKeys[result.reason],
          ),
        }),
      );
    } finally {
      pendingRef.current = false;
      setSaving(false);
    }
  };
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        disabled={disabled || saving}
        onClick={() => setOpen(value => !value)}
        aria-label={i18nService.t('sessionWorkspaceChange')}
        title={i18nService.t(disabled ? 'sessionWorkspaceBusy' : 'sessionWorkspaceChange')}
        aria-haspopup="dialog"
        aria-expanded={open && !disabled && !saving}
        className="inline-flex h-7 w-8 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface-raised hover:text-primary disabled:opacity-40"
      >
        <FolderSwitchIcon className="h-4 w-4" />
      </button>
      <FolderSelectorPopover
        isOpen={open && !disabled && !saving}
        onClose={() => setOpen(false)}
        onSelectFolder={nextCwd => void selectFolder(nextCwd)}
        anchorRef={anchorRef}
        currentFolder={cwd}
        description={i18nService.t('sessionWorkspaceDescription')}
      />
    </>
  );
}
