import { ExclamationTriangleIcon, FolderOpenIcon } from '@heroicons/react/24/outline';
import type {
  McpExportPreview,
  McpExportPreviewInput,
  McpExportRow,
  McpExportSaveReceipt,
  McpTransferError,
} from '@shared/plugins/mcpTransfer';
import { useEffect, useMemo, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

import {
  transferBodyClass,
  transferCheckClass,
  TransferConnection,
  TransferFooter,
  transferLinkButtonClass,
  transferListClass,
  TransferNotice,
  transferPrimaryButtonClass,
  transferQuietButtonClass,
  TransferResult,
  transferRowClass,
  TransferSelection,
  TransferTag,
  transferText,
} from './mcpTransferView';

interface McpTransferExportProps {
  active: boolean;
  id: string;
  tabId: string;
  importRevision: number;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onClose: () => void;
}

export function McpTransferExport({
  active,
  id,
  tabId,
  importRevision,
  busy,
  setBusy,
  onClose,
}: McpTransferExportProps) {
  const [catalog, setCatalog] = useState<{
    rows: McpExportRow[];
    revision: number;
    importRevision: number;
  }>();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [error, setError] = useState<McpTransferError>();
  const [catalogError, setCatalogError] = useState<McpTransferError>();
  const [receipt, setReceipt] = useState<McpExportSaveReceipt>();
  const [includeEnvValues, setIncludeEnvValues] = useState(false);
  const [includeHeaderValues, setIncludeHeaderValues] = useState(false);
  const previewTail = useRef(Promise.resolve());

  const rows =
    catalog?.revision === catalogRevision && catalog.importRevision === importRevision
      ? catalog.rows
      : undefined;
  const available = useMemo(() => rows?.filter(row => !row.issue) ?? [], [rows]);
  const ids = useMemo(
    () => available.filter(row => selected.has(row.id)).map(row => row.id),
    [available, selected],
  );
  const input = useMemo<McpExportPreviewInput>(
    () => ({ ids, includeEnvValues, includeHeaderValues }),
    [ids, includeEnvValues, includeHeaderValues],
  );
  const [preview, setPreview] = useState<{
    input: McpExportPreviewInput;
    value: McpExportPreview;
  }>();
  const currentPreview = preview?.input === input ? preview.value : undefined;

  useEffect(() => {
    if (!active || rows) return;
    let current = true;
    void window.electron.mcp
      .listExport()
      .then(result => {
        if (!current) return;
        if (!result.success) {
          setCatalogError(result.code);
          return;
        }
        setCatalogError(undefined);
        setCatalog({ rows: result.value, revision: catalogRevision, importRevision });
        setSelected(
          previous =>
            new Set(
              result.value
                .filter(
                  row =>
                    !row.issue &&
                    (!catalog?.rows.some(old => old.id === row.id) || previous.has(row.id)),
                )
                .map(row => row.id),
            ),
        );
      })
      .catch(() => {
        if (current) setCatalogError('unavailable');
      });
    return () => {
      current = false;
    };
  }, [active, catalog, catalogRevision, importRevision, rows]);

  useEffect(() => {
    if (!active || !input.ids.length || currentPreview || error || receipt) return;
    let current = true;
    // Main keeps a single preview token. Issue the newest request after the previous one settles.
    previewTail.current = previewTail.current.then(async () => {
      if (!current) return;
      try {
        const result = await window.electron.mcp.previewExport(input);
        if (!current) return;
        if (result.success) setPreview({ input, value: result.value });
        else setError(result.code);
      } catch {
        if (current) setError('unavailable');
      }
    });
    return () => {
      current = false;
    };
  }, [active, currentPreview, error, input, receipt]);

  const refresh = () => {
    setError(undefined);
    setCatalogError(undefined);
    setCatalogRevision(revision => revision + 1);
  };

  const updateSelection = (selection: Set<string>) => {
    setError(undefined);
    setSelected(selection);
  };

  const save = async () => {
    if (!currentPreview || !ids.length || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await window.electron.mcp.saveExport(currentPreview.token);
      if (result.success) setReceipt(result.value);
      else if (result.code !== 'cancelled') {
        setError(result.code);
        if (result.code === 'expired' || result.code === 'conflict') setPreview(undefined);
      }
    } catch {
      setError('write-failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      id={id}
      role="tabpanel"
      aria-labelledby={tabId}
      hidden={!active}
      className="min-h-0 flex-1 flex-col aria-busy:cursor-wait"
      style={active ? { display: 'flex' } : undefined}
      aria-busy={busy}
    >
      {active && receipt && (
        <>
          <section className={transferBodyClass}>
            <TransferResult
              kind="success"
              title={transferText('mcpTransferExportDone', { count: receipt.count })}
              detail={receipt.filePath}
            />
          </section>
          <TransferFooter>
            <button type="button" className={transferPrimaryButtonClass} onClick={onClose}>
              {i18nService.t('mcpTransferDone')}
            </button>
          </TransferFooter>
        </>
      )}
      {active && !receipt && (
        <>
          <section className={transferBodyClass}>
            <h3 className="text-sm font-semibold text-foreground">
              {i18nService.t('mcpTransferExportSelect')}
            </h3>
            {catalogError && (
              <TransferNotice error>
                {i18nService.t(`mcpTransfer.error.${catalogError}`)}{' '}
                <button type="button" className={transferLinkButtonClass} onClick={refresh}>
                  {i18nService.t('refresh')}
                </button>
              </TransferNotice>
            )}
            {!catalogError && !rows && (
              <p role="status" className="text-xs text-secondary">
                {i18nService.t('mcpTransferPreparing')}
              </p>
            )}
            {rows?.length === 0 && (
              <div className="grid justify-items-center gap-2 py-6 text-center">
                <span className="grid size-9 place-items-center rounded-lg bg-primary/10 text-primary">
                  <FolderOpenIcon className="size-5" aria-hidden="true" />
                </span>
                <p className="text-sm font-medium text-foreground">
                  {i18nService.t('mcpTransferExportEmpty')}
                </p>
                <p className="text-xs text-secondary">
                  {i18nService.t('mcpTransferExportEmptyDetail')}
                </p>
              </div>
            )}
            {Boolean(rows?.length) && rows && (
              <>
                <div className={transferListClass}>
                  <TransferSelection
                    label="mcpTransferSelectAll"
                    selected={ids.length}
                    total={rows.length}
                    available={busy ? 0 : available.length}
                    onChange={value =>
                      updateSelection(new Set(value ? available.map(row => row.id) : []))
                    }
                  />
                  {rows.map(row => (
                    <div
                      key={row.id}
                      className={`${transferRowClass} ${selected.has(row.id) ? 'bg-primary/5' : ''}`}
                    >
                      <input
                        type="checkbox"
                        className={`${transferCheckClass} mt-0.5`}
                        aria-label={transferText('mcpTransferSelectRow', { name: row.name })}
                        checked={selected.has(row.id)}
                        disabled={busy || Boolean(row.issue)}
                        onChange={event => {
                          const next = new Set(selected);
                          if (event.currentTarget.checked) next.add(row.id);
                          else next.delete(row.id);
                          updateSelection(next);
                        }}
                      />
                      <TransferConnection {...row}>
                        {row.issue && <p>{i18nService.t(`mcpTransfer.issue.${row.issue}`)}</p>}
                      </TransferConnection>
                      {row.issue && <TransferTag tone="error" label="mcpTransferCannotExport" />}
                    </div>
                  ))}
                </div>
                {available.length > 0 && (
                  <fieldset className="space-y-2" disabled={busy}>
                    <legend className="mb-2 text-sm font-medium text-foreground">
                      {i18nService.t('mcpTransferExportOptions')}
                    </legend>
                    <label className="flex items-center gap-2 text-sm text-foreground">
                      <input
                        type="checkbox"
                        className={transferCheckClass}
                        checked={includeEnvValues}
                        onChange={event => {
                          setError(undefined);
                          setIncludeEnvValues(event.currentTarget.checked);
                        }}
                      />
                      {i18nService.t('mcpTransferExportEnvValues')}
                    </label>
                    <label className="flex items-center gap-2 text-sm text-foreground">
                      <input
                        type="checkbox"
                        className={transferCheckClass}
                        checked={includeHeaderValues}
                        onChange={event => {
                          setError(undefined);
                          setIncludeHeaderValues(event.currentTarget.checked);
                        }}
                      />
                      {i18nService.t('mcpTransferExportHeaderValues')}
                    </label>
                  </fieldset>
                )}
                {(includeEnvValues || includeHeaderValues) && (
                  <p
                    role="status"
                    className="flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300"
                  >
                    <ExclamationTriangleIcon className="size-4 shrink-0" aria-hidden="true" />
                    {i18nService.t('mcpTransferExportPlaintext')}
                  </p>
                )}
                <details className="rounded-lg border border-border bg-surface-raised/50 px-3 py-2">
                  <summary tabIndex={0} className="cursor-pointer text-sm font-medium text-primary">
                    {i18nService.t('mcpTransferExportPreview')}
                  </summary>
                  {currentPreview ? (
                    <pre className="mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap border-t border-border pt-2 font-mono text-xs text-foreground [overflow-wrap:anywhere]">
                      {currentPreview.json}
                    </pre>
                  ) : (
                    <p className="mt-2 text-xs text-secondary">
                      {i18nService.t(
                        ids.length
                          ? error
                            ? `mcpTransfer.error.${error}`
                            : 'mcpTransferPreparing'
                          : 'mcpTransferExportPreviewEmpty',
                      )}
                    </p>
                  )}
                </details>
                <TransferNotice>{i18nService.t('mcpTransferExportNotice')}</TransferNotice>
                {error && (
                  <TransferNotice error>
                    {i18nService.t(`mcpTransfer.error.${error}`)}
                    {!currentPreview && ids.length > 0 && (
                      <button type="button" className={transferLinkButtonClass} onClick={refresh}>
                        {i18nService.t('mcpTransferExportPreviewRefresh')}
                      </button>
                    )}
                  </TransferNotice>
                )}
              </>
            )}
          </section>
          <TransferFooter>
            <button
              type="button"
              className={transferQuietButtonClass}
              disabled={busy}
              onClick={onClose}
            >
              {i18nService.t('cancel')}
            </button>
            <button
              type="button"
              className={transferPrimaryButtonClass}
              disabled={busy || !currentPreview}
              onClick={() => void save()}
            >
              {busy
                ? i18nService.t('mcpTransferSaving')
                : transferText('mcpTransferExportCount', { count: ids.length })}
            </button>
          </TransferFooter>
        </>
      )}
    </div>
  );
}
