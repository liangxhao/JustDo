import {
  ArrowPathIcon,
  CheckCircleIcon,
  ClockIcon,
  ExclamationCircleIcon,
  StopCircleIcon,
  UserGroupIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import type {
  TeamDiscussionExecution,
  TeamDiscussionMember,
} from '@shared/cowork/agent-team/teamDiscussion';

import { i18nService } from '@/services/i18n';

import ChatAvatar from '../chat/ChatAvatar';
import { COLLABORATION_PALETTE } from '../shared/collaborationPalette';

const MEMBER_STATUS = {
  running: { label: 'teamMember_running', icon: ArrowPathIcon, className: 'text-primary' },
  completed: { label: 'teamMember_completed', icon: CheckCircleIcon, className: 'text-success' },
  failed: { label: 'teamMember_failed', icon: ExclamationCircleIcon, className: 'text-destructive' },
  cancelled: { label: 'teamMember_cancelled', icon: StopCircleIcon, className: 'text-secondary' },
  unknown: { label: 'teamMember_unknown', icon: ClockIcon, className: 'text-secondary' },
} as const;

export default function TeamDiscussionMembersPanel({
  members,
  executions,
  participation,
  onClose,
}: {
  members: readonly TeamDiscussionMember[];
  executions: readonly TeamDiscussionExecution[];
  participation?: {
    enabled: boolean;
    disabled: boolean;
    onChange: (enabled: boolean) => void;
  };
  onClose: () => void;
}) {
  return (
    <aside
      aria-label={i18nService.t('teamMembers')}
      className="absolute right-3 top-3 z-20 flex max-h-[calc(100%-24px)] w-72 max-w-[calc(100%-24px)] flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-elevated dark:border-[color-mix(in_srgb,var(--justdo-border)_85%,var(--justdo-foreground))] dark:bg-[color-mix(in_srgb,var(--justdo-surface-raised)_96%,var(--justdo-foreground))]"
    >
      <header className="flex shrink-0 items-center gap-2.5 px-4 py-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary-muted text-primary">
          <UserGroupIcon className="h-4 w-4" aria-hidden="true" />
        </span>
        <h2 className="min-w-0 flex-1 text-sm font-semibold">{i18nService.t('teamMembers')}</h2>
        <span className="rounded-full bg-primary-muted px-2 py-0.5 text-xs font-medium tabular-nums text-primary">
          {members.length}
        </span>
        <button
          type="button"
          aria-label={i18nService.t('teamCloseMembers')}
          title={i18nService.t('teamCloseMembers')}
          onClick={onClose}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
        >
          <XMarkIcon className="h-4 w-4" aria-hidden="true" />
        </button>
      </header>
      <div className="min-h-0 space-y-3 overflow-y-auto px-3 pb-3">
        {participation && (
          <label
            className={`flex items-center gap-3 rounded-xl bg-primary-muted px-3 py-3 ${participation.disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
          >
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium leading-5 text-foreground">
                {i18nService.t('teamOrganizerParticipationLabel')}
              </span>
              <span className="mt-0.5 block text-xs leading-5 text-secondary">
                {i18nService.t('teamOrganizerParticipationHint')}
              </span>
            </span>
            <input
              type="checkbox"
              className="peer sr-only"
              aria-label={i18nService.t('teamOrganizerParticipates')}
              checked={participation.enabled}
              disabled={participation.disabled}
              onChange={event => participation.onChange(event.target.checked)}
            />
            <span
              aria-hidden="true"
              className="relative h-5 w-9 shrink-0 rounded-full bg-border transition-colors after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow-subtle after:transition-transform peer-checked:bg-primary peer-checked:after:translate-x-4 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary"
            />
          </label>
        )}
        <ul className="space-y-2" aria-label={i18nService.t('teamMembers')}>
          {members.map((member, index) => {
            const outcome = [...executions]
              .reverse()
              .find(item => item.agentId === member.agentId)?.outcome;
            const status = MEMBER_STATUS[outcome ?? 'unknown'];
            const StatusIcon = status.icon;
            return (
              <li
                key={member.agentId}
                className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-background px-3 py-3"
              >
                <ChatAvatar
                  role="assistant"
                  peer={{
                    id: member.agentId,
                    label: member.name,
                    color: COLLABORATION_PALETTE[index % COLLABORATION_PALETTE.length].stroke,
                  }}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium leading-5" title={member.name}>
                    {member.name}
                  </p>
                  <span
                    className={`mt-0.5 flex items-center gap-1 text-[11px] leading-4 ${status.className}`}
                  >
                    <StatusIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    {i18nService.t(status.label)}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}
