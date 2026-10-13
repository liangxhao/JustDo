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
    'getSwarmWorkflowBatch' | 'retrySwarmWorkflowBatch' | 'newOperationId'
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
        const result = await api.getSwarmWorkflowBatch(sessionId, flow.id, stage.id, {
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
