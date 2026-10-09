import { ArrowLeftIcon, ArrowPathIcon } from '@heroicons/react/24/outline';
import type { SwarmWorkflowDetail, SwarmWorkflowNode } from '@shared/cowork/swarmWorkflow';
import { useEffect, useState } from 'react';

import { i18nService } from '@/services/i18n';

import ChatMessageDisplay from '../chat/ChatMessageDisplay';
import SwarmWorkflowNodeHistory from './SwarmWorkflowNodeHistory';
import SwarmWorkflowNodeIntervention from './SwarmWorkflowNodeIntervention';

export function handoffContent(message: string, sourceId: string) {
  try {
    const value = JSON.parse(message);
    const input = Array.isArray(value?.inputs)
      ? value.inputs.find((item: { id?: string } | null) => item?.id === sourceId)
      : undefined;
    if (typeof value?.assignedTask !== 'string' || typeof input?.result !== 'string')
      return undefined;
    return { result: input.result as string, task: value.assignedTask as string };
  } catch {
    return undefined;
  }
}

export default function SwarmWorkflowDetailPanel({
  sessionId,
  flowId,
  node,
  source,
  active,
  onBack,
  backLabel,
  onChanged,
}: {
  sessionId: string;
  flowId: string;
  node: SwarmWorkflowNode;
  source?: SwarmWorkflowNode;
  active: boolean;
  onBack: () => void;
  backLabel?: string;
  onChanged?: () => void;
}) {
  const t = (key: string) => i18nService.t(key);
  const label = (n: SwarmWorkflowNode) =>
    ['work', 'batch'].includes(n.kind) ? n.title : t('swarmWorkflowKind_' + n.kind);
  const [detail, setDetail] = useState<SwarmWorkflowDetail>();
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const result = await window.electron.cowork.getSwarmWorkflowDetail(
          sessionId,
          flowId,
          node.id,
          source?.id,
        );
        if (disposed) return;
        setError(!result.success);
        if (result.success) setDetail(result.detail);
      } catch {
        if (!disposed) setError(true);
      } finally {
        if (!disposed) timer = setTimeout(() => void read(), 2500);
      }
    };
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [sessionId, flowId, node.id, node.status, source?.id, active, retry]);
  const handoff =
    source && detail?.dispatch ? handoffContent(detail.dispatch.message, source.id) : undefined;
  const title = source ? label(source) + ' → ' + label(node) : label(node);
  const agentLabel = '@' + (node.agentName ?? node.agentId ?? 'main');
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex min-w-0 shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <button
          type="button"
          title={backLabel ?? t('swarmWorkflowBack')}
          aria-label={backLabel ?? t('swarmWorkflowBack')}
          onClick={onBack}
          className="shrink-0 rounded-lg p-2 hover:bg-surface-raised"
        >
          <ArrowLeftIcon className="h-4 w-4" />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <h3 title={title} className="min-w-0 flex-1 truncate text-sm font-semibold">
            {title}
          </h3>
          <span
            title={source ? t('swarmWorkflowHandoff') : t('swarmWorkflowAgent') + ': ' + agentLabel}
            className="max-w-[40%] shrink-0 truncate rounded-md bg-surface-raised px-2 py-1 text-xs text-secondary"
          >
            {source ? t('swarmWorkflowHandoff') : agentLabel}
          </span>
        </div>
        <button
          type="button"
          title={t('swarmWorkflowRefresh')}
          aria-label={t('swarmWorkflowRefresh')}
          onClick={() => setRetry(v => v + 1)}
          className="shrink-0 rounded-lg p-2 hover:bg-surface-raised"
        >
          <ArrowPathIcon className="h-4 w-4" />
        </button>
      </header>
      <p className="px-3 py-2 text-xs text-secondary">
        {source && detail && node.kind !== 'batch'
          ? t('swarmWorkflowSubmission_' + detail.submission)
          : t('swarmWorkflowNode_' + (detail?.status ?? node.status))}
      </p>
      {!source && (detail ? detail.error : node.error) && (
        <p role="alert" className="px-3 py-2 text-xs text-red-600">
          {detail ? detail.error : node.error}
        </p>
      )}
      {error && (
        <p role="alert" className="p-3 text-sm text-secondary">
          {t('swarmWorkflowHistory_error')}
        </p>
      )}
      {!detail && !error && (
        <p role="status" className="p-3 text-sm text-secondary">
          {t('swarmWorkflowHistory_loading')}
        </p>
      )}
      {detail &&
        (source ? (
          <>
            {detail.dispatch ? (
              <>
                <time className="px-3 text-xs text-muted">
                  {new Date(detail.dispatch.createdAt).toLocaleString()}
                </time>
                {handoff ? (
                  <>
                    <div className="mx-3 mt-2 max-h-32 shrink-0 overflow-auto rounded-lg bg-surface-raised p-3 text-sm">
                      <p className="mb-1 text-xs text-secondary">{t('swarmWorkflowDownstreamTask')}</p>
                      <p className="whitespace-pre-wrap break-words">{handoff.task}</p>
                    </div>
                    <ChatMessageDisplay
                      className="min-h-0 flex-1"
                      fullWidth
                      peerPerspective
                      assistantName={source.agentName ?? source.agentId ?? 'main'}
                      workingDirectory={detail.workingDirectory}
                      gatewayMessages={[
                        {
                          role: 'assistant',
                          content: handoff.result,
                          timestamp: detail.dispatch.createdAt,
                        },
                      ]}
                    />
                  </>
                ) : (
                  <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 text-xs">
                    {detail.dispatch.message}
                  </pre>
                )}
                {handoff && (
                  <details className="max-h-48 shrink-0 overflow-auto border-t border-border p-3 text-xs">
                    <summary className="cursor-pointer text-secondary">
                      {t('swarmWorkflowFullRequest')}
                    </summary>
                    <pre className="mt-2 whitespace-pre-wrap break-words">
                      {detail.dispatch.message}
                    </pre>
                  </details>
                )}
              </>
            ) : (
              <p role="status" className="p-3 text-sm text-secondary">
                {t(
                  detail.submission === 'not_sent'
                    ? 'swarmWorkflowSubmission_not_sent'
                    : 'swarmWorkflowDispatchUnavailable',
                )}
              </p>
            )}
          </>
        ) : detail.submission === 'not_sent' ? (
          <p role="status" className="p-3 text-sm text-secondary">
            {t('swarmWorkflowSubmission_not_sent')}
          </p>
        ) : (
          active && (
            <SwarmWorkflowNodeHistory
              key={detail.sessionKey + retry}
              sessionKey={detail.sessionKey}
              workingDirectory={detail.workingDirectory}
              agentId={node.agentId}
              name={node.agentName ?? node.agentId ?? 'main'}
            />
          )
        ))}
      {detail && !source && active && (
        <SwarmWorkflowNodeIntervention
          sessionId={sessionId}
          detail={detail}
          disabled={error}
          onChanged={() => {
            setRetry(value => value + 1);
            onChanged?.();
          }}
        />
      )}
    </div>
  );
}
