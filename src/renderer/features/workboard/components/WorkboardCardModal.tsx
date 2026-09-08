import { ChatBubbleLeftRightIcon, XMarkIcon } from '@heroicons/react/24/outline';
import {
  WORKBOARD_PRIORITIES,
  WORKBOARD_STATUSES,
  type WorkboardCard,
  type WorkboardCardInput,
  workboardCardSessionKey,
} from '@shared/openclaw/workboard';
import React, { useEffect, useState } from 'react';

import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/common/Modal';

type Props = {
  card: WorkboardCard | null;
  boardId?: string;
  agents: Array<{ id: string; name: string }>;
  onClose: () => void;
  onSave: (input: WorkboardCardInput) => Promise<void>;
  onDelete?: () => Promise<void>;
  onOpenSession?: () => void;
};

const WorkboardCardModal: React.FC<Props> = ({
  card,
  boardId,
  agents,
  onClose,
  onSave,
  onDelete,
  onOpenSession,
}) => {
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [status, setStatus] = useState<WorkboardCardInput['status']>('todo');
  const [priority, setPriority] = useState<WorkboardCardInput['priority']>('normal');
  const [labels, setLabels] = useState('');
  const [agentId, setAgentId] = useState('');
  const [sessionKey, setSessionKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTitle(card?.title ?? '');
    setNotes(card?.notes ?? '');
    setStatus(card?.status ?? 'todo');
    setPriority(card?.priority ?? 'normal');
    setLabels(card?.labels.join(', ') ?? '');
    setAgentId(card?.agentId ?? '');
    setSessionKey(card ? (workboardCardSessionKey(card) ?? '') : '');
    setError(null);
  }, [card]);

  const save = async () => {
    const normalizedTitle = title.trim();
    if (!normalizedTitle) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        title: normalizedTitle,
        notes: notes.trim(),
        status,
        priority,
        labels: [
          ...new Set(
            labels
              .split(',')
              .map(label => label.trim())
              .filter(Boolean),
          ),
        ].slice(0, 12),
        agentId: agentId.trim(),
        sessionKey: sessionKey.trim(),
        boardId,
      });
      onClose();
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : i18nService.t('workboardSaveFailed'),
      );
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!onDelete || !window.confirm(i18nService.t('workboardDeleteConfirm'))) return;
    setSaving(true);
    setError(null);
    try {
      await onDelete();
      onClose();
    } catch (deleteError) {
      setError(
        deleteError instanceof Error ? deleteError.message : i18nService.t('workboardDeleteFailed'),
      );
    } finally {
      setSaving(false);
    }
  };

  const fieldClass =
    'w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-primary';

  return (
    <Modal
      onClose={onClose}
      className="mx-4 flex max-h-[86vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
    >
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <h2 className="text-base font-semibold text-foreground">
          {i18nService.t(card ? 'workboardEditCard' : 'workboardNewCard')}
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-1.5 text-secondary hover:bg-surface-raised hover:text-foreground"
          aria-label={i18nService.t('dismiss')}
        >
          <XMarkIcon className="h-5 w-5" />
        </button>
      </div>
      <div className="space-y-4 overflow-y-auto px-5 py-4">
        <label className="block space-y-1.5 text-sm text-secondary">
          <span>{i18nService.t('workboardCardTitle')}</span>
          <input
            autoFocus
            value={title}
            onChange={event => setTitle(event.target.value)}
            maxLength={180}
            className={fieldClass}
          />
        </label>
        <label className="block space-y-1.5 text-sm text-secondary">
          <span>{i18nService.t('workboardCardNotes')}</span>
          <textarea
            value={notes}
            onChange={event => setNotes(event.target.value)}
            maxLength={4000}
            rows={5}
            className={`${fieldClass} resize-y`}
          />
        </label>
        <div className="grid grid-cols-2 gap-4">
          <label className="block space-y-1.5 text-sm text-secondary">
            <span>{i18nService.t('workboardStatus')}</span>
            <select
              value={status}
              onChange={event => setStatus(event.target.value as WorkboardCardInput['status'])}
              className={fieldClass}
            >
              {WORKBOARD_STATUSES.map(value => (
                <option key={value} value={value}>
                  {i18nService.t(`workboardStatus_${value}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1.5 text-sm text-secondary">
            <span>{i18nService.t('workboardPriority')}</span>
            <select
              value={priority}
              onChange={event => setPriority(event.target.value as WorkboardCardInput['priority'])}
              className={fieldClass}
            >
              {WORKBOARD_PRIORITIES.map(value => (
                <option key={value} value={value}>
                  {i18nService.t(`workboardPriority_${value}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="block space-y-1.5 text-sm text-secondary">
          <span>{i18nService.t('workboardLabels')}</span>
          <input
            value={labels}
            onChange={event => setLabels(event.target.value)}
            placeholder={i18nService.t('workboardLabelsPlaceholder')}
            className={fieldClass}
          />
        </label>
        <label className="block space-y-1.5 text-sm text-secondary">
          <span>{i18nService.t('workboardAgent')}</span>
          <select
            value={agentId}
            onChange={event => setAgentId(event.target.value)}
            className={fieldClass}
          >
            <option value="">{i18nService.t('workboardAgentPlaceholder')}</option>
            {card?.agentId && !agents.some(agent => agent.id === card.agentId) && (
              <option value={card.agentId}>{card.agentId}</option>
            )}
            {agents.map(agent => (
              <option key={agent.id} value={agent.id}>
                {agent.name || agent.id}
              </option>
            ))}
          </select>
        </label>
        {card && (
          <div className="space-y-1.5 text-sm text-secondary">
            <span>{i18nService.t('workboardLinkedSession')}</span>
            <div className="flex items-center gap-2 rounded-lg bg-surface-raised px-3 py-2">
              <span className="min-w-0 flex-1 break-all text-xs text-foreground">
                {sessionKey || i18nService.t('workboardNoLinkedSession')}
              </span>
              {sessionKey ? (
                <button
                  type="button"
                  onClick={() => setSessionKey('')}
                  disabled={saving}
                  className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-red-500 hover:bg-red-500/10 disabled:opacity-50"
                >
                  {i18nService.t('workboardClearSession')}
                </button>
              ) : workboardCardSessionKey(card) ? (
                <button
                  type="button"
                  onClick={() => setSessionKey(workboardCardSessionKey(card) ?? '')}
                  disabled={saving}
                  className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10 disabled:opacity-50"
                >
                  {i18nService.t('workboardRestoreSession')}
                </button>
              ) : null}
            </div>
            {workboardCardSessionKey(card) && !sessionKey && (
              <p className="text-xs text-amber-500">{i18nService.t('workboardClearSessionHint')}</p>
            )}
          </div>
        )}
        {onOpenSession && (
          <button
            type="button"
            onClick={onOpenSession}
            className="flex w-full items-center gap-2 rounded-lg bg-surface-raised px-3 py-2 text-left text-sm font-medium text-primary hover:bg-primary/10"
          >
            <ChatBubbleLeftRightIcon className="h-4 w-4 shrink-0" />
            {i18nService.t('workboardOpenSession')}
          </button>
        )}
        {error && (
          <div className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500">{error}</div>
        )}
      </div>
      <div className="flex items-center justify-between border-t border-border px-5 py-4">
        <div>
          {onDelete && (
            <button
              type="button"
              onClick={() => void remove()}
              disabled={saving}
              className="rounded-lg px-3 py-2 text-sm font-medium text-red-500 hover:bg-red-500/10 disabled:opacity-50"
            >
              {i18nService.t('delete')}
            </button>
          )}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm font-medium text-secondary hover:bg-surface-raised"
          >
            {i18nService.t('cancel')}
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || !title.trim()}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
          >
            {saving ? i18nService.t('saving') : i18nService.t('save')}
          </button>
        </div>
      </div>
    </Modal>
  );
};

export default WorkboardCardModal;
