import {
  ArrowLeftIcon,
  ArrowPathIcon,
  CheckCircleIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  ExclamationCircleIcon,
  MagnifyingGlassIcon,
} from '@heroicons/react/24/outline';
import type {
  SwarmWorkflowBatchItem,
  SwarmWorkflowBatchPage,
  SwarmWorkflowNode,
  SwarmWorkflowView,
} from '@shared/cowork/swarmWorkflow';
import { useEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

import SwarmWorkflowDetailPanel from './SwarmWorkflowDetailPanel';

const statusIcon = (status: SwarmWorkflowNode['status']) =>
  status === 'done'
    ? CheckCircleIcon
    : ['failed', 'uncertain'].includes(status)
      ? ExclamationCircleIcon
      : ['running', 'preparing'].includes(status)
        ? ArrowPathIcon
        : ClockIcon;

export default function SwarmWorkflowBatchPanel({
  sessionId,
  flow,
  stage,
  active,
  onBack,
  onChanged,
}: {
  sessionId: string;
  flow: SwarmWorkflowView;
  stage: SwarmWorkflowNode;
  active: boolean;
  onBack(): void;
  onChanged(): void;
}) {
  const t = (key: string) => i18nService.t(key);
  const [page, setPage] = useState<SwarmWorkflowBatchPage>();
  const [filter, setFilter] = useState('');
  const [search, setSearch] = useState('');
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [selected, setSelected] = useState<SwarmWorkflowBatchItem>();
  const [checked, setChecked] = useState<string[]>([]);
  const [revision, refresh] = useState(0);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [receipt, setReceipt] = useState<{
    retried: number;
    skipped: number;
    reasons?: string[];
  }>();
  const sequence = useRef(0);
  const cursor = cursors[cursors.length - 1];
  const ready = Boolean(stage.batchCounts);
  useEffect(() => {
    if (!active || !ready) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      const request = ++sequence.current;
      setLoading(true);
      try {
        const result = await window.electron.cowork.getSwarmWorkflowBatch(sessionId, flow.id, stage.id, {
          search,
          status: filter ? (filter as SwarmWorkflowNode['status']) : undefined,
          cursor,
        });
        if (disposed || request !== sequence.current) return;
        if (result.success) {
          setPage(result.page);
          setError(false);
        } else {
          setError(true);
        }
      } catch {
        if (!disposed) setError(true);
      }
      if (!disposed && request === sequence.current) setLoading(false);
      if (!disposed && !cursor) timer = setTimeout(load, 3000);
    };
    timer = setTimeout(() => void load(), 200);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [sessionId, flow.id, stage.id, ready, active, cursor, filter, search, revision]);
  const reset = () => {
    setLoading(true);
    setPage(undefined);
    setCursors([undefined]);
    setChecked([]);
    refresh(n => n + 1);
    onChanged();
  };
  const retry = async () => {
    if (!page || busy) return;
    setBusy(true);
    setError(false);
    setReceipt(undefined);
    try {
      const result = await window.electron.cowork.retrySwarmWorkflowBatch(
        sessionId,
        flow.id,
        stage.id,
        page.revision,
        crypto.randomUUID(),
        checked.length ? checked : undefined,
      );
      if (result.success)
        setReceipt({
          retried: result.retried ?? 0,
          skipped: result.skipped ?? 0,
          reasons: result.reasons,
        });
      else setError(true);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
      reset();
    }
  };
  const counts = page?.counts ?? stage.batchCounts;
  return (
    <>
      <div className={selected ? 'hidden' : 'flex h-full min-h-0 flex-col'}>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-2">
          <button
            type="button"
            title={t('swarmWorkflowBack')}
            aria-label={t('swarmWorkflowBack')}
            onClick={onBack}
            className="rounded-lg p-2 hover:bg-surface-raised"
          >
            <ArrowLeftIcon className="h-4 w-4" />
          </button>
          <span className="min-w-0 flex-1 truncate text-sm font-medium" title={stage.title}>
            {stage.title}
          </span>
          <span className="text-xs text-muted">
            {counts?.done ?? 0} / {counts?.total ?? '—'}
          </span>
          <button
            type="button"
            title={t('swarmWorkflowRefresh')}
            aria-label={t('swarmWorkflowRefresh')}
            onClick={reset}
            className="rounded-lg p-2 hover:bg-surface-raised"
          >
            <ArrowPathIcon className="h-4 w-4" />
          </button>
        </header>
        <div className="h-1 shrink-0 bg-surface-raised">
          <div
            className="h-full bg-emerald-500 transition-[width]"
            style={{ width: `${counts?.total ? (counts.done / counts.total) * 100 : 0}%` }}
          />
        </div>
        <div className="flex shrink-0 items-center gap-2 px-3 py-3">
          <div className="relative min-w-0 flex-1">
            <MagnifyingGlassIcon className="absolute left-2 top-2 h-4 w-4 text-muted" />
            <input
              aria-label={t('swarmWorkflowBatchSearch')}
              placeholder={t('swarmWorkflowBatchSearch')}
              value={search}
              maxLength={100}
              onChange={event => {
                setLoading(true);
                setPage(undefined);
                setSearch(event.target.value);
                setCursors([undefined]);
                setChecked([]);
              }}
              className="h-8 w-full rounded-lg border border-border bg-background pl-8 pr-2 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <select
            aria-label={t('swarmWorkflowBatchFilter')}
            value={filter}
            onChange={event => {
              setLoading(true);
              setPage(undefined);
              setFilter(event.target.value);
              setCursors([undefined]);
              setChecked([]);
            }}
            className="h-8 rounded-lg border border-border bg-background px-2 text-xs"
          >
            <option value="">{t('swarmWorkflowBatchAll')}</option>
            {(
              [
                'queued',
                'preparing',
                'running',
                'uncertain',
                'done',
                'failed',
                'cancelled',
              ] as const
            ).map(status => (
              <option key={status} value={status}>
                {t('swarmWorkflowNode_' + status)} · {counts?.[status] ?? 0}
              </option>
            ))}
          </select>
        </div>
        {error && (
          <p role="status" className="px-3 pb-2 text-xs text-red-600">
            {t('swarmWorkflowBatchChanged')}
          </p>
        )}
        {receipt && (
          <p
            role="status"
            className="px-3 pb-2 text-xs text-secondary"
            title={receipt.reasons?.join('\n')}
          >
            {t('swarmWorkflowBatchRetried')} {receipt.retried} · {t('swarmWorkflowBatchSkipped')} {receipt.skipped}
          </p>
        )}
        <div className="min-h-0 flex-1 overflow-auto px-2">
          {!page && (
            <p
              role="status"
              className={`p-4 text-center text-xs ${stage.status === 'failed' ? 'text-red-600' : 'text-muted'}`}
            >
              {t('swarmWorkflowNode_' + (ready ? 'preparing' : stage.status))}
              {!ready && stage.error && (
                <span className="mt-2 block whitespace-pre-wrap break-words text-left">
                  {stage.error}
                </span>
              )}
            </p>
          )}
          {page?.items.map(item => {
            const Icon = statusIcon(item.status);
            return (
              <div
                key={item.id}
                className="mb-1 flex items-center gap-2 rounded-xl px-2 hover:bg-surface-raised"
              >
                <input
                  type="checkbox"
                  aria-label={t('swarmWorkflowBatchSelect') + ' ' + item.title}
                  disabled={item.status !== 'failed' || busy}
                  checked={checked.includes(item.id)}
                  onChange={event =>
                    setChecked(ids =>
                      event.target.checked ? [...ids, item.id] : ids.filter(id => id !== item.id),
                    )
                  }
                  className="h-3.5 w-3.5 accent-primary disabled:opacity-20"
                />
                <button
                  type="button"
                  onClick={() => setSelected(item)}
                  className="flex min-w-0 flex-1 items-center gap-3 py-3 text-left"
                  title={item.error || t('swarmWorkflowNode_' + item.status)}
                >
                  <Icon
                    className={`h-4 w-4 shrink-0 ${item.status === 'done' ? 'text-emerald-600' : ['failed', 'uncertain'].includes(item.status) ? 'text-red-500' : 'text-primary'}${active && ['running', 'preparing'].includes(item.status) ? ' swarm-spinner' : ''}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">{item.title}</span>
                    <span className="block truncate text-[10px] text-muted">
                      @{item.agentName ?? item.agentId ?? 'main'}
                    </span>
                  </span>
                  {item.startedAt && (
                    <span className="text-[10px] tabular-nums text-muted">
                      {t('swarmWorkflowBatchMinutes').replace(
                        '{value}',
                        String(
                          Math.max(
                            0,
                            Math.floor(((item.endedAt ?? Date.now()) - item.startedAt) / 60000),
                          ),
                        ),
                      )}
                    </span>
                  )}
                  <span className="text-[10px] text-muted">{t('swarmWorkflowNode_' + item.status)}</span>
                  <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 text-muted" />
                </button>
              </div>
            );
          })}
        </div>
        <footer className="flex h-12 shrink-0 items-center gap-2 border-t border-border px-3">
          {Boolean(page?.retryable) &&
            !['stopping', 'cancelled', 'completed'].includes(flow.status) && (
              <button
                type="button"
                disabled={busy || loading || error}
                onClick={() => void retry()}
                className="flex items-center gap-1.5 rounded-lg bg-primary-muted px-2.5 py-1.5 text-xs text-primary disabled:opacity-40"
              >
                <ArrowPathIcon className="h-3.5 w-3.5" />
                {t(checked.length ? 'swarmWorkflowBatchRetrySelected' : 'swarmWorkflowBatchRetryFailed')}
                {checked.length ? ` (${checked.length})` : ''}
              </button>
            )}
          <div className="ml-auto flex items-center gap-2 text-xs text-muted">
            <button
              type="button"
              aria-label={t('swarmWorkflowBatchPrevious')}
              disabled={loading || cursors.length <= 1}
              onClick={() => {
                setLoading(true);
                setCursors(values => values.slice(0, -1));
                setChecked([]);
              }}
              className="rounded p-1 disabled:opacity-25"
            >
              <ChevronLeftIcon className="h-4 w-4" />
            </button>
            <span>{cursors.length}</span>
            <button
              type="button"
              aria-label={t('swarmWorkflowBatchNext')}
              disabled={loading || !page?.cursor || error}
              onClick={() => {
                setLoading(true);
                setCursors(values => [...values, page?.cursor]);
                setChecked([]);
              }}
              className="rounded p-1 disabled:opacity-25"
            >
              <ChevronRightIcon className="h-4 w-4" />
            </button>
          </div>
        </footer>
      </div>
      {selected && (
        <SwarmWorkflowDetailPanel
          key={selected.id}
          sessionId={sessionId}
          flowId={flow.id}
          node={{ ...selected, kind: 'work', deps: [], sessionKey: '' }}
          active={active}
          backLabel={t('swarmWorkflowBatchBack')}
          onBack={() => setSelected(undefined)}
          onChanged={reset}
        />
      )}
    </>
  );
}
