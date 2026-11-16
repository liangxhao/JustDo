import type { WorktreeInitialCommitOffer } from '@shared/cowork/worktreeInitialCommit';
import { useCallback, useEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

export interface WorktreeInitialCommitDialogState {
  offer: WorktreeInitialCommitOffer;
  busy: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: (paths: string[]) => void;
}

export function dismissWorktreeInitialCommit(offerId: string): void {
  void window.electron?.cowork?.dismissWorktreeInitialCommit?.(offerId).catch(() => undefined);
}

export function useWorktreeInitialCommit() {
  const [dialog, setDialog] = useState<WorktreeInitialCommitDialogState>();
  const pending = useRef<{ id: string; busy: boolean; resolve: (confirmed: boolean) => void }>();

  const settle = useCallback((confirmed: boolean) => {
    const request = pending.current;
    pending.current = undefined;
    if (!request) return;
    if (!confirmed) dismissWorktreeInitialCommit(request.id);
    request.resolve(confirmed);
  }, []);

  const finish = useCallback((confirmed: boolean) => {
    setDialog(undefined);
    settle(confirmed);
  }, [settle]);

  useEffect(() => () => settle(false), [settle]);

  const requestConfirmation = (offer: WorktreeInitialCommitOffer) =>
    new Promise<boolean>(resolve => {
      const request = { id: offer.id, busy: false, resolve };
      pending.current = request;
      const view: WorktreeInitialCommitDialogState = {
        offer,
        busy: false,
        onCancel: () => {
          if (pending.current === request && !request.busy) finish(false);
        },
        onConfirm: async paths => {
          if (pending.current !== request || request.busy) return;
          request.busy = true;
          setDialog({ ...view, busy: true });
          let failure: string | undefined;
          try {
            const result = await window.electron.cowork.confirmWorktreeInitialCommit({
              id: offer.id,
              paths,
            });
            if (pending.current !== request) return;
            if (result.success) {
              finish(true);
              return;
            }
            failure = result.error;
          } catch {
            if (pending.current !== request) return;
          }
          request.busy = false;
          setDialog({ ...view, error: i18nService.t(failure || 'worktreeInitialCommitFailed') });
        },
      };
      setDialog(view);
    });

  return { dialog, requestConfirmation, finish };
}
