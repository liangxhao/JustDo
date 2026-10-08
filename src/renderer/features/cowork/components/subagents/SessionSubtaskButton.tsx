import { QueueListIcon } from '@heroicons/react/24/outline';
import { useCallback, useId, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';
import { useOwnerWindow } from '@/shared/dom/ownerDocument';

import SubtaskListPanel from './SubtaskListPanel';
import type { Subtask } from './subtaskPresentation';

/** Mount per parent session; counts and navigation always belong to that session. */
export default function SessionSubtaskButton({
  sessionId,
  parentRunning,
  onOpenSubtask,
}: {
  sessionId: string;
  parentRunning: boolean;
  onOpenSubtask: (task: Subtask, parentSessionId: string) => void;
}) {
  const ownerWindow = useOwnerWindow();
  const [tasks, setTasks] = useState<Subtask[]>([]);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const close = useCallback(
    (restoreFocus = true) => {
      setOpen(false);
      if (restoreFocus) ownerWindow.requestAnimationFrame(() => anchor.current?.focus());
    },
    [ownerWindow],
  );
  return (
    <div className="relative shrink-0">
      {tasks.length > 0 && (
        <button
          ref={anchor}
          type="button"
          className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-secondary hover:bg-surface-raised hover:text-foreground"
          title={i18nService.t(open ? 'subtaskHide' : 'subtaskShow')}
          aria-label={i18nService.t(open ? 'subtaskHide' : 'subtaskShow')}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen(value => !value)}
        >
          <QueueListIcon className="h-[18px] w-[18px]" />
          <span className="text-xs">{tasks.length}</span>
        </button>
      )}
      <SubtaskListPanel
        sessionId={sessionId}
        panelId={panelId}
        parentRunning={parentRunning}
        isOpen={open && tasks.length > 0}
        anchorRef={anchor}
        onClose={close}
        onSubtasksChange={setTasks}
        onOpenSubtask={task => {
          close(false);
          onOpenSubtask(task, sessionId);
        }}
      />
    </div>
  );
}
