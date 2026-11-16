import { QueueListIcon } from '@heroicons/react/24/outline';
import type { SubagentReadFailure } from '@shared/cowork/subagentDetails';
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
  const [loadError, setLoadError] = useState<SubagentReadFailure | null>(null);
  const [panelVisible, setPanelVisible] = useState<boolean | null>(null);
  const open = panelVisible === true;
  const anchor = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  // Once used, keep the trigger available for focus restoration even after an empty read.
  const hasPanel = panelVisible !== null || tasks.length > 0 || loadError !== null;
  const close = useCallback(
    (restoreFocus = true) => {
      setPanelVisible(false);
      if (restoreFocus) ownerWindow.requestAnimationFrame(() => anchor.current?.focus());
    },
    [ownerWindow],
  );
  return (
    <div className="relative shrink-0">
      {hasPanel && (
        <button
          ref={anchor}
          type="button"
          className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-secondary hover:bg-surface-raised hover:text-foreground"
          title={i18nService.t(open ? 'subtaskHide' : 'subtaskShow')}
          aria-label={i18nService.t(open ? 'subtaskHide' : 'subtaskShow')}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setPanelVisible(!open)}
        >
          <QueueListIcon className="h-[18px] w-[18px]" />
          {tasks.length > 0 && <span className="text-xs">{tasks.length}</span>}
        </button>
      )}
      <SubtaskListPanel
        sessionId={sessionId}
        panelId={panelId}
        parentRunning={parentRunning}
        isOpen={open}
        anchorRef={anchor}
        onClose={close}
        onSubtasksChange={setTasks}
        onLoadErrorChange={setLoadError}
        onOpenSubtask={task => {
          close(false);
          onOpenSubtask(task, sessionId);
        }}
      />
    </div>
  );
}
