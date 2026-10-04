import { useEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

import { resolveSubtaskExecutionKey, type Subtask } from './subtaskPresentation';

/** Fetch one native level only when requested. Failed pages preserve previous results. */
type SubtaskChildrenProps = {
  sessionId: string;
  task: Subtask;
  ancestors: readonly string[];
  onOpen: (child: Subtask) => void;
};

export default function SubtaskChildren(props: SubtaskChildrenProps) {
  return (
    <SubtaskChildrenContent
      key={JSON.stringify([props.sessionId, props.task.id, props.task.sessionKey])}
      {...props}
    />
  );
}

function SubtaskChildrenContent({ sessionId, task, ancestors, onOpen }: SubtaskChildrenProps) {
  const [children, setChildren] = useState<Subtask[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [cursor, setCursor] = useState<string>();
  const seenCursors = useRef(new Set<string>());
  const inFlight = useRef(false);
  const retryRefresh = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const load = async (refresh = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailed(false);
    retryRefresh.current = refresh;
    try {
      const requestedCursor = refresh ? undefined : cursor;
      const result = await window.electron.cowork.listSubTaskChildren(
        sessionId,
        task.id,
        requestedCursor,
      );
      if (!mounted.current) return;
      if (!result.success) {
        setFailed(true);
        return;
      }
      const blockedIds = new Set([...ancestors, task.id]);
      const next = result.subagents.filter(child => !blockedIds.has(child.id));
      setChildren(current => [
        ...new Map([...(refresh ? [] : current), ...next].map(child => [child.id, child])).values(),
      ]);
      setLoaded(true);
      if (refresh) seenCursors.current.clear();
      if (requestedCursor) seenCursors.current.add(requestedCursor);
      setCursor(
        result.nextCursor && !seenCursors.current.has(result.nextCursor)
          ? result.nextCursor
          : undefined,
      );
    } catch {
      if (mounted.current) setFailed(true);
    } finally {
      if (mounted.current) setBusy(false);
      inFlight.current = false;
    }
  };
  return (
    <section
      className="space-y-2 border-b border-border px-5 py-3"
      aria-label={i18nService.t('subtaskChildren')}
    >
      <h3 className="text-xs font-medium text-secondary">{i18nService.t('subtaskChildren')}</h3>
      {loaded && (
        <button
          type="button"
          disabled={busy}
          className="text-xs text-primary disabled:opacity-50"
          onClick={() => void load(true)}
        >
          {i18nService.t('subtaskRefresh')}
        </button>
      )}
      {children.map(child => (
        <button
          key={child.id}
          type="button"
          className="flex w-full items-center justify-between gap-3 rounded-md bg-surface-raised px-2 py-1.5 text-left text-sm hover:text-primary"
          onClick={() => onOpen(child)}
        >
          <span className="min-w-0">
            <span className="block truncate">{child.label}</span>
            {child.swarmGroupId && (
              <span className="block truncate text-xs text-secondary" title={child.swarmGroupId}>
                {i18nService.t('subtaskSwarmGroup').replace('{group}', child.swarmGroupId)}
              </span>
            )}
          </span>
          <span className="shrink-0 text-xs text-secondary">
            {i18nService.t(resolveSubtaskExecutionKey(child))}
          </span>
        </button>
      ))}
      {loaded && children.length === 0 && (
        <p className="text-xs text-secondary">{i18nService.t('subtaskChildrenEmpty')}</p>
      )}
      {failed && (
        <p role="alert" className="text-xs text-red-600">
          {i18nService.t('subtaskLoadFailed')}
        </p>
      )}
      {(!loaded || cursor || failed) && (
        <button
          type="button"
          disabled={busy}
          className="text-xs text-primary disabled:opacity-50"
          onClick={() => void load(failed && retryRefresh.current)}
        >
          {i18nService.t(
            busy
              ? 'loading'
              : failed
                ? 'sessionDetailsRetry'
                : loaded
                  ? 'subtaskChildrenMore'
                  : 'subtaskChildrenLoad',
          )}
        </button>
      )}
    </section>
  );
}
