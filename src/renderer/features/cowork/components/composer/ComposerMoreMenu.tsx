import { PaperClipIcon } from '@heroicons/react/24/outline';
import { useEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

export const OPEN_AGENT_TEAM = 'app:open-agent-team';
export interface AgentTeamEntry {
  cwd?: string;
  draft?: string;
  sourceSessionId?: string;
  roomId?: string;
}
export function openAgentTeam(detail: AgentTeamEntry = {}): void {
  window.dispatchEvent(new CustomEvent(OPEN_AGENT_TEAM, { detail }));
}

export default function ComposerMoreMenu({
  onAddFile,
  disabled,
  team,
}: {
  onAddFile: () => void;
  disabled: boolean;
  team?: AgentTeamEntry;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  return (
    <div
      ref={root}
      className="relative"
      onKeyDown={event => {
        if (event.key === 'Escape') {
          setOpen(false);
          root.current?.querySelector('button')?.focus();
        }
      }}
    >
      <button
        type="button"
        disabled={disabled}
        aria-label={i18nService.t('coworkAddFile')}
        aria-expanded={open}
        className="rounded-lg px-2 py-1 text-secondary hover:bg-surface-raised"
        onClick={() => setOpen(!open)}
      >
        <PaperClipIcon className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-30 mb-2 min-w-44 rounded-xl border border-border bg-surface p-1 shadow-lg">
          <button
            type="button"
            className="block w-full rounded-lg p-2 text-left hover:bg-surface-raised"
            onClick={() => {
              setOpen(false);
              onAddFile();
            }}
          >
            {i18nService.t('coworkAddFile')}
          </button>
          {team && (
            <button
              type="button"
              className="block w-full rounded-lg p-2 text-left hover:bg-surface-raised"
              onClick={() => {
                setOpen(false);
                openAgentTeam(team);
              }}
            >
              {i18nService.t('teamManualSetup')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
