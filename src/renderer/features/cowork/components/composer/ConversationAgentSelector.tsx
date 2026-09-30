import { ChevronDownIcon } from '@heroicons/react/24/outline';
import { UserCircleIcon } from '@heroicons/react/24/solid';
import { useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import { setCurrentAgentId } from '@/features/agents/agentSlice';
import { i18nService } from '@/services/i18n';
import type { RootState } from '@/store';

export function ConversationAgentSelector({
  agentId,
  disabled,
  onChange,
}: {
  agentId: string;
  disabled: boolean;
  onChange?: (agentId: string) => void | Promise<void>;
}) {
  const dispatch = useDispatch();
  const agents = useSelector((state: RootState) => state.agent.agents);
  const [pending, setPending] = useState(false);
  const available = agents.filter(agent => agent.enabled && !agent.deletedAt);
  return (
    <div className="relative flex items-center rounded-full border border-border bg-surface text-foreground shadow-sm transition-colors hover:border-primary/50 focus-within:border-primary focus-within:ring-1 focus-within:ring-primary/30">
      <UserCircleIcon className="pointer-events-none ml-2.5 h-4 w-4 shrink-0 text-secondary" />
      <select
        aria-label={i18nService.t('agentSelectConversation')}
        value={agentId}
        disabled={disabled || pending}
        title={onChange ? i18nService.t('agentSwitchNewConversation') : undefined}
        onChange={async event => {
          const id = event.target.value;
          if (id === agentId || pending) return;
          setPending(true);
          try {
            if (onChange) await onChange(id);
            else dispatch(setCurrentAgentId(id));
          } catch {
            window.dispatchEvent(
              new CustomEvent('app:showToast', { detail: i18nService.t('agentSwitchSaveFailed') }),
            );
          } finally {
            setPending(false);
          }
        }}
        className="min-w-0 max-w-[140px] cursor-pointer appearance-none bg-transparent py-1.5 pl-1.5 pr-6 text-xs font-semibold text-foreground outline-none disabled:cursor-not-allowed disabled:opacity-50"
      >
        {!available.some(agent => agent.id === agentId) && (
          <option value={agentId} disabled>
            {agents.find(agent => agent.id === agentId)?.name || i18nService.t('agentUnavailable')}
          </option>
        )}
        {available.map(agent => (
          <option key={agent.id} value={agent.id}>
            {agent.name}
          </option>
        ))}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute right-2 h-3 w-3 text-secondary" />
    </div>
  );
}
