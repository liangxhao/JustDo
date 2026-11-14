import {
  ArrowPathIcon,
  CheckIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
} from '@heroicons/react/24/outline';
import type { McpTransportType } from '@shared/plugins/mcp';
import { type ReactNode, useEffect, useRef } from 'react';

import { i18nService } from '@/services/i18n';

import { MCP_TRANSPORT_BADGE_COLORS } from './mcpTransport';

export const transferBodyClass = 'min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-5 sm:px-6';
export const transferListClass =
  'divide-y divide-border overflow-hidden rounded-xl border border-border';
export const transferRowClass =
  'grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2.5 gap-y-2 px-3 py-2.5';
export const transferCheckClass = 'size-4 shrink-0 accent-primary';
export const transferQuietButtonClass =
  'rounded-lg px-3 py-2 text-sm font-medium text-secondary hover:bg-surface hover:text-foreground disabled:opacity-50';
export const transferPrimaryButtonClass =
  'rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-primary/10 disabled:text-secondary';
export const transferLinkButtonClass =
  'rounded-md px-1.5 py-1 text-xs font-medium text-primary hover:bg-primary/10';

export const transferText = (key: string, values: Record<string, string | number>) =>
  i18nService
    .t(key)
    .replace(/\{(\w+)\}/g, (placeholder, name: string) =>
      name in values ? String(values[name]) : placeholder,
    );

export const transferTransportLabels: Record<McpTransportType, string> = {
  stdio: 'STDIO',
  http: 'Streamable HTTP',
  sse: 'SSE',
};

export function TransferSelection({
  label,
  selected,
  total,
  available,
  onChange,
}: {
  label: string;
  selected: number;
  total: number;
  available: number;
  onChange: (selected: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = selected > 0 && selected < available;
  }, [available, selected]);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 bg-surface-raised/60 px-3 py-2">
      <label className="flex items-center gap-2 text-xs font-medium text-foreground">
        <input
          ref={inputRef}
          type="checkbox"
          className={transferCheckClass}
          checked={available > 0 && selected === available}
          disabled={available === 0}
          onChange={event => onChange(event.currentTarget.checked)}
        />
        {i18nService.t(label)}
      </label>
      <span className="text-xs text-secondary" aria-live="polite">
        {transferText('mcpTransferSelection', { selected, total })}
      </span>
    </div>
  );
}

export function TransferConnection({
  name,
  transportType,
  description,
  connectionSummary,
  children,
}: {
  name: string;
  transportType?: McpTransportType;
  description?: string;
  connectionSummary?: string;
  children?: ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-0.5 text-xs text-secondary [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <strong className="text-sm font-semibold text-foreground">
          {name || i18nService.t('mcpTransferUnnamed')}
        </strong>
        {transportType && (
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${MCP_TRANSPORT_BADGE_COLORS[transportType]}`}
          >
            {transferTransportLabels[transportType]}
          </span>
        )}
      </div>
      {description && <p>{description}</p>}
      {connectionSummary && <p className="font-mono">{connectionSummary}</p>}
      {children}
    </div>
  );
}

const tagColors = {
  success: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  warning: 'bg-amber-500/10 text-amber-800 dark:text-amber-300',
  error: 'bg-red-500/10 text-red-700 dark:text-red-300',
  neutral: 'bg-surface-raised text-secondary',
};

export function TransferTag({ tone, label }: { tone: keyof typeof tagColors; label: string }) {
  return (
    <span
      className={`max-w-28 rounded-full px-2 py-0.5 text-center text-[11px] font-medium ${tagColors[tone]}`}
    >
      {i18nService.t(label)}
    </span>
  );
}

export function TransferNotice({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  const Icon = error ? ExclamationTriangleIcon : InformationCircleIcon;
  return (
    <div
      role={error ? 'alert' : undefined}
      className={`flex items-start gap-2 rounded-lg px-3 py-2 text-xs [overflow-wrap:anywhere] ${error ? 'bg-red-500/10 text-red-700 dark:text-red-300' : 'bg-surface-raised text-secondary'}`}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0">{children}</span>
    </div>
  );
}

const resultIcons = {
  success: CheckIcon,
  pending: ArrowPathIcon,
  error: ExclamationTriangleIcon,
};

export function TransferResult({
  kind,
  title,
  detail,
}: {
  kind: keyof typeof resultIcons;
  title: string;
  detail: string;
}) {
  const Icon = resultIcons[kind];
  return (
    <div
      role={kind === 'error' ? 'alert' : 'status'}
      className="flex items-center gap-3 rounded-xl border border-border bg-surface-raised/50 p-4"
    >
      <span
        className={`grid size-10 shrink-0 place-items-center rounded-xl ${kind === 'pending' ? 'bg-primary/10 text-primary' : tagColors[kind]}`}
      >
        <Icon
          className={`size-5 ${kind === 'pending' ? 'animate-spin motion-reduce:animate-spin' : ''}`}
          aria-hidden="true"
        />
      </span>
      <div className="min-w-0 [overflow-wrap:anywhere]">
        <h3 className="text-base font-semibold text-foreground">{title}</h3>
        <p className="mt-0.5 text-xs text-secondary">{detail}</p>
      </div>
    </div>
  );
}

export function TransferFooter({ children }: { children: ReactNode }) {
  return (
    <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border bg-surface-raised/50 px-4 py-3 sm:px-6">
      {children}
    </footer>
  );
}
