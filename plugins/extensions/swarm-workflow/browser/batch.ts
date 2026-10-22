import { useEffect, useRef, useState } from 'react';

import type {
  SwarmWorkflowBatchItem,
  SwarmWorkflowBatchPage,
  SwarmWorkflowNode,
  SwarmWorkflowView,
} from '../contracts/workflow';
import type { WorkflowBrowserPorts } from './ports';

export interface WorkflowBatchOptions {
  sessionId: string;
  flow: SwarmWorkflowView;
  stage: SwarmWorkflowNode;
  active: boolean;
  onChanged(): void;
}
export function useWorkflowBatch(
  api: Pick<
    WorkflowBrowserPorts,
    | 'getSwarmWorkflowBatch'
    | 'retrySwarmWorkflowBatch'
    | 'newOperationId'
    | 'onSwarmWorkflowsChanged'
  >,
  { sessionId, flow, stage, active, onChanged }: WorkflowBatchOptions,
) {
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
  const revalidate = useRef<(() => void) | undefined>();
  const cursor = cursors[cursors.length - 1];
  const ready = Boolean(stage.batchCounts);
  useEffect(() => {
    if (!active || !ready || selected) return;
    let disposed = false;
    let reading = false;
    let dirty = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      const request = ++sequence.current;
      reading = true;
      dirty = false;
      setLoading(true);
      try {
        const result = await api.getSwarmWorkflowBatch(sessionId, flow.id, stage.id, {
          search,
          status: filter ? (filter as SwarmWorkflowNode['status']) : undefined,
          cursor,
        });
        if (disposed || dirty || request !== sequence.current) return;
        if (result.success) {
          setPage(result.page);
          setError(false);
        } else {
          setError(true);
        }
      } catch {
        if (!disposed && !dirty) setError(true);
      } finally {
        reading = false;
        if (!disposed && request === sequence.current && !dirty) setLoading(false);
        if (!disposed && dirty) refreshPage();
        else if (
          !disposed &&
          !cursor &&
          !['completed', 'cancelled'].includes(flow.status) &&
          (stage.status === 'queued' ||
            stage.status === 'preparing' ||
            stage.status === 'running' ||
            stage.status === 'uncertain')
        )
          timer = setTimeout(load, 3000);
      }
    };
    const refreshPage = () => {
      if (disposed) return;
      clearTimeout(timer);
      if (reading) {
        dirty = true;
        return;
      }
      timer = setTimeout(load, 0);
    };
    revalidate.current = refreshPage;
    const unsubscribe = api.onSwarmWorkflowsChanged(event => {
      if (!event.sessionId) refreshPage();
    });
    timer = setTimeout(() => void load(), 200);
    return () => {
      disposed = true;
      clearTimeout(timer);
      unsubscribe();
      if (revalidate.current === refreshPage) revalidate.current = undefined;
    };
  }, [
    api,
    sessionId,
    flow.id,
    flow.status,
    stage.id,
    stage.status,
    ready,
    active,
    selected,
    cursor,
    filter,
    search,
    revision,
  ]);
  // The graph supplies current revisions even when a terminal batch has no timer.
  // Serialize changes arriving during a read instead of cancelling every response.
  useEffect(() => {
    revalidate.current?.();
  }, [flow.revision]);
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
      const result = await api.retrySwarmWorkflowBatch(
        sessionId,
        flow.id,
        stage.id,
        page.revision,
        api.newOperationId(),
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
  return {
    page,
    filter,
    setFilter,
    search,
    setSearch,
    cursors,
    setCursors,
    selected,
    setSelected,
    checked,
    setChecked,
    error,
    busy,
    loading,
    receipt,
    retry,
    counts,
    ready,
    reset,
    setLoading,
    setPage,
  };
}
