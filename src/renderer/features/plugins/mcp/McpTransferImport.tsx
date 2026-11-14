import { CodeBracketIcon, FolderOpenIcon } from '@heroicons/react/24/outline';
import {
  isMcpTransferName,
  type McpImportCommitInput,
  type McpImportCommitReceipt,
  type McpImportPreview,
  type McpImportPreviewRow,
  type McpImportSelection,
  type McpImportSource,
  type McpTransferError,
  type McpTransferResult,
} from '@shared/plugins/mcpTransfer';
import { useState } from 'react';

import { i18nService } from '@/services/i18n';

import { MCP_FORM_INPUT_CLASS_NAME } from './mcpFormStyles';
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
  transferTransportLabels,
} from './mcpTransferView';

interface McpTransferImportProps {
  active: boolean;
  id: string;
  tabId: string;
  knownNames: ReadonlySet<string>;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onClose: () => void;
  onImport: (input: McpImportCommitInput) => Promise<McpTransferResult<McpImportCommitReceipt>>;
  onEditImported?: (id: string) => void;
}

type ImportView = 'source' | 'preview' | 'committing' | 'failed' | 'done';
type ImportChoice = Omit<McpImportSelection, 'index'>;

const canSelect = (row: McpImportPreviewRow, choice?: ImportChoice) =>
  !row.issue &&
  (!row.conflict || Boolean(choice?.name)) &&
  Boolean(row.transportType ?? choice?.transportType);

export function McpTransferImport({
  active,
  id,
  tabId,
  knownNames,
  busy,
  setBusy,
  onClose,
  onImport,
  onEditImported,
}: McpTransferImportProps) {
  const [view, setView] = useState<ImportView>('source');
  const [source, setSource] = useState('');
  const [preview, setPreview] = useState<McpImportPreview>();
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [choices, setChoices] = useState<Record<number, ImportChoice>>({});
  const [error, setError] = useState<McpTransferError>();
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [receipt, setReceipt] = useState<McpImportCommitReceipt>();

  const applyPreview = (value: McpImportPreview) => {
    setPreview(value);
    setChoices({});
    setSelected(new Set(value.rows.filter(row => canSelect(row)).map(row => row.index)));
    setView('preview');
  };

  const prepare = async (input: McpImportSource) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await window.electron.mcp.previewImport(input);
      if (result.success) applyPreview(result.value);
      else if (result.code !== 'cancelled') setError(result.code);
    } catch {
      setError('unavailable');
    } finally {
      setBusy(false);
    }
  };

  const updateSelected = (index: number, enabled: boolean) => {
    setSelected(current => {
      const next = new Set(current);
      if (enabled) next.add(index);
      else next.delete(index);
      return next;
    });
  };

  const updateChoice = (row: McpImportPreviewRow, update: ImportChoice) => {
    const choice = { ...choices[row.index], ...update };
    setChoices(current => ({ ...current, [row.index]: choice }));
    if (canSelect(row, choice)) updateSelected(row.index, true);
  };

  const importable = preview?.rows.filter(row => canSelect(row, choices[row.index])) ?? [];
  const commit = async () => {
    if (!preview || !selected.size || busy) return;
    setBusy(true);
    setView('committing');
    setError(undefined);
    setUnconfirmed(false);
    try {
      const result = await onImport({
        token: preview.token,
        selection: importable
          .filter(row => selected.has(row.index))
          .map(row => ({ index: row.index, ...choices[row.index] })),
      });
      if (result.success) {
        setSource('');
        setReceipt(result.value);
        setView('done');
      } else if (result.preview) {
        const conflicting = new Set(result.conflictingIndices);
        const nextChoices = { ...choices };
        for (const index of conflicting) delete nextChoices[index];
        setPreview(result.preview);
        setChoices(nextChoices);
        setSelected(
          new Set(
            result.preview.rows
              .filter(
                row =>
                  selected.has(row.index) &&
                  !conflicting.has(row.index) &&
                  canSelect(row, nextChoices[row.index]),
              )
              .map(row => row.index),
          ),
        );
        setView('preview');
        setError(result.code);
      } else if (result.code === 'expired') {
        setView('source');
        setError(result.code);
      } else {
        setView('failed');
        setError(result.code);
        setUnconfirmed(result.operationUnconfirmed === true);
        if (result.operationUnconfirmed) setSource('');
      }
    } catch {
      setView('failed');
      setUnconfirmed(true);
      setSource('');
    } finally {
      setBusy(false);
    }
  };

  const occupied = new Set(knownNames);
  for (const row of preview?.rows ?? []) occupied.add(choices[row.index]?.name ?? row.name);

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
      {active && view === 'source' && (
        <>
          <section className={transferBodyClass}>
            <button
              type="button"
              className="flex w-full items-center gap-3 rounded-xl border border-dashed border-primary/30 bg-primary/5 p-3 text-left hover:bg-primary/10 disabled:opacity-60"
              onClick={() => void prepare({ kind: 'file' })}
              disabled={busy}
            >
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                <CodeBracketIcon className="size-5" aria-hidden="true" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium text-foreground">
                  {i18nService.t('mcpTransferChooseFile')}
                </span>
                <span className="text-xs text-secondary">
                  {i18nService.t('mcpTransferFormats')}
                </span>
              </span>
              <FolderOpenIcon className="size-5 shrink-0 text-primary" aria-hidden="true" />
            </button>
            <label className="grid gap-2 text-sm font-medium text-foreground">
              {i18nService.t('mcpTransferPaste')}
              <textarea
                className={`${MCP_FORM_INPUT_CLASS_NAME} min-h-28 resize-y font-mono`}
                value={source}
                spellCheck={false}
                placeholder={'{ "mcpServers": { … } }'}
                disabled={busy}
                onChange={event => {
                  setSource(event.currentTarget.value);
                  setError(undefined);
                }}
              />
            </label>
            {busy && (
              <p role="status" className="text-xs text-secondary">
                {i18nService.t('mcpTransferPreparing')}
              </p>
            )}
            {error && (
              <TransferNotice error>{i18nService.t(`mcpTransfer.error.${error}`)}</TransferNotice>
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
              disabled={busy || !source.trim()}
              onClick={() => void prepare({ kind: 'text', text: source })}
            >
              {i18nService.t('mcpTransferPreview')}
            </button>
          </TransferFooter>
        </>
      )}
      {active && view === 'preview' && preview && (
        <>
          <section className={transferBodyClass}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-foreground">
                {i18nService.t('mcpTransferImportPreview')}
              </h3>
              <p className="text-xs text-secondary [overflow-wrap:anywhere]">
                {preview.sourceLabel || i18nService.t('mcpTransferPastedSource')} ·{' '}
                <code>{preview.format}</code>
              </p>
            </div>
            {error && (
              <TransferNotice error>{i18nService.t(`mcpTransfer.error.${error}`)}</TransferNotice>
            )}
            <div className={transferListClass}>
              <TransferSelection
                label="mcpTransferSelectImportable"
                selected={selected.size}
                total={preview.rows.length}
                available={importable.length}
                onChange={value =>
                  setSelected(new Set(value ? importable.map(row => row.index) : []))
                }
              />
              {preview.rows.map(row => (
                <ImportRow
                  key={`${preview.token}-${row.index}`}
                  row={row}
                  choice={choices[row.index]}
                  selected={selected.has(row.index)}
                  occupied={occupied}
                  onSelect={value => updateSelected(row.index, value)}
                  onChoice={choice => updateChoice(row, choice)}
                />
              ))}
            </div>
            <TransferNotice>{i18nService.t('mcpTransferDisabledNotice')}</TransferNotice>
          </section>
          <TransferFooter>
            <button
              type="button"
              className={`${transferQuietButtonClass} mr-auto`}
              onClick={() => {
                setView('source');
                setError(undefined);
              }}
            >
              {i18nService.t('mcpTransferEditSource')}
            </button>
            <button
              type="button"
              className={transferPrimaryButtonClass}
              disabled={busy || !selected.size}
              onClick={() => void commit()}
            >
              {transferText('mcpTransferImportCount', { count: selected.size })}
            </button>
          </TransferFooter>
        </>
      )}
      {active && view === 'committing' && (
        <section className={transferBodyClass}>
          <TransferResult
            kind="pending"
            title={i18nService.t('mcpTransferImportPending')}
            detail={i18nService.t('mcpTransferImportPendingDetail')}
          />
        </section>
      )}
      {active && view === 'failed' && (
        <>
          <section className={transferBodyClass}>
            <TransferResult
              kind="error"
              title={i18nService.t(
                unconfirmed ? 'mcpTransferImportUnconfirmed' : 'mcpTransferImportFailed',
              )}
              detail={i18nService.t(
                unconfirmed
                  ? 'mcpTransferImportUnconfirmedDetail'
                  : `mcpTransfer.error.${error ?? 'unavailable'}`,
              )}
            />
          </section>
          <TransferFooter>
            <button type="button" className={transferQuietButtonClass} onClick={onClose}>
              {i18nService.t('close')}
            </button>
            {!unconfirmed && (
              <button
                type="button"
                className={transferPrimaryButtonClass}
                onClick={() => {
                  setError(undefined);
                  setView('source');
                }}
              >
                {i18nService.t('mcpTransferEditSource')}
              </button>
            )}
          </TransferFooter>
        </>
      )}
      {active && view === 'done' && receipt && (
        <>
          <section className={transferBodyClass}>
            <TransferResult
              kind="success"
              title={transferText('mcpTransferImportDone', { count: receipt.imported.length })}
              detail={i18nService.t('mcpTransferImportDoneDetail')}
            />
            <div className={transferListClass}>
              {receipt.imported.map(item => (
                <div key={item.id} className="flex items-start justify-between gap-2 px-3 py-2.5">
                  <TransferConnection name={item.name}>
                    {item.missingCredentials?.length ? (
                      <p>
                        {transferText('mcpTransferMissingKeys', {
                          keys: item.missingCredentials.join(', '),
                        })}
                      </p>
                    ) : null}
                  </TransferConnection>
                  <div className="flex shrink-0 flex-wrap items-center gap-1">
                    <TransferTag
                      tone={item.missingCredentials?.length ? 'warning' : 'neutral'}
                      label={
                        item.missingCredentials?.length
                          ? 'mcpTransferMissingCredentials'
                          : 'mcpTransferDisabled'
                      }
                    />
                    {onEditImported &&
                      !receipt.refreshWarning &&
                      Boolean(item.missingCredentials?.length) && (
                        <button
                          type="button"
                          className={transferLinkButtonClass}
                          onClick={() => onEditImported(item.id)}
                        >
                          {i18nService.t('mcpTransferEditCredentials')}
                        </button>
                      )}
                  </div>
                </div>
              ))}
            </div>
            <TransferNotice>
              {[
                transferText('mcpTransferImportSkipped', { count: receipt.skipped }),
                transferText('mcpTransferImportCredentialsCount', {
                  count: receipt.imported.filter(item => item.missingCredentials?.length).length,
                }),
              ].join(' · ')}
            </TransferNotice>
          </section>
          <TransferFooter>
            <button type="button" className={transferPrimaryButtonClass} onClick={onClose}>
              {i18nService.t('mcpTransferDone')}
            </button>
          </TransferFooter>
        </>
      )}
    </div>
  );
}

function ImportRow({
  row,
  choice,
  selected,
  occupied,
  onSelect,
  onChoice,
}: {
  row: McpImportPreviewRow;
  choice?: ImportChoice;
  selected: boolean;
  occupied: ReadonlySet<string>;
  onSelect: (selected: boolean) => void;
  onChoice: (choice: ImportChoice) => void;
}) {
  const name = choice?.name ?? row.name;
  const missingKeys = row.missingCredentials?.join(', ');
  const transport = row.transportType ?? choice?.transportType;
  const conflict = row.conflict && !choice?.name;
  const [rename, setRename] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftTransport, setDraftTransport] = useState<'http' | 'sse'>('http');
  const [renameError, setRenameError] = useState(false);
  const label = row.issue
    ? 'mcpTransferCannotImport'
    : conflict
      ? 'mcpTransferConflicted'
      : !transport
        ? 'mcpTransferTransportNeeded'
        : row.missingCredentials?.length
          ? 'mcpTransferMissingCredentials'
          : 'mcpTransferImportable';
  const tone = row.issue
    ? 'error'
    : conflict || !transport || row.missingCredentials?.length
      ? 'warning'
      : 'success';

  return (
    <div className={`${transferRowClass} ${selected ? 'bg-primary/5' : ''}`}>
      <input
        type="checkbox"
        className={`${transferCheckClass} mt-0.5`}
        checked={selected}
        aria-label={transferText('mcpTransferSelectRow', {
          name: name || i18nService.t('mcpTransferUnnamed'),
        })}
        disabled={!canSelect(row, choice)}
        onChange={event => onSelect(event.currentTarget.checked)}
      />
      <TransferConnection
        name={name}
        transportType={transport}
        description={row.description}
        connectionSummary={row.connectionSummary}
      >
        {row.issue && <p>{i18nService.t(`mcpTransfer.issue.${row.issue}`)}</p>}
        {!row.issue && missingKeys && (
          <p>{transferText('mcpTransferMissingKeys', { keys: missingKeys })}</p>
        )}
      </TransferConnection>
      <div className="flex max-w-32 flex-wrap items-center justify-end gap-1">
        <TransferTag tone={tone} label={label} />
        {conflict && !row.issue && !rename && (
          <button
            type="button"
            className={transferLinkButtonClass}
            onClick={() => {
              setDraftName(`${row.name}-2`);
              setRename(true);
            }}
          >
            {i18nService.t('mcpTransferRename')}
          </button>
        )}
      </div>
      {rename && (
        <form
          className="col-start-2 col-end-4 flex flex-wrap items-end gap-2"
          onSubmit={event => {
            event.preventDefault();
            const nextName = draftName.trim();
            if (!isMcpTransferName(nextName) || occupied.has(nextName)) {
              setRenameError(true);
              return;
            }
            onChoice({ name: nextName });
            setRename(false);
          }}
        >
          <label className="flex min-w-32 flex-1 flex-col gap-1 text-xs text-secondary">
            {i18nService.t('mcpTransferNewName')}
            <input
              autoFocus
              className={MCP_FORM_INPUT_CLASS_NAME}
              value={draftName}
              aria-invalid={renameError}
              onChange={event => {
                setDraftName(event.currentTarget.value);
                setRenameError(false);
              }}
            />
          </label>
          <button type="submit" className={transferLinkButtonClass}>
            {i18nService.t('mcpTransferApplyRename')}
          </button>
          {renameError && (
            <p className="basis-full text-xs text-red-700 dark:text-red-300" role="alert">
              {i18nService.t('mcpTransferRenameError')}
            </p>
          )}
        </form>
      )}
      {!transport && !row.issue && (
        <div className="col-start-2 col-end-4 flex flex-wrap items-end gap-2">
          <label className="flex min-w-32 flex-1 flex-col gap-1 text-xs text-secondary">
            {i18nService.t('mcpDetailTransport')}
            <select
              className={MCP_FORM_INPUT_CLASS_NAME}
              value={draftTransport}
              onChange={event =>
                setDraftTransport(event.currentTarget.value === 'sse' ? 'sse' : 'http')
              }
            >
              <option value="http">{transferTransportLabels.http}</option>
              <option value="sse">{transferTransportLabels.sse}</option>
            </select>
          </label>
          <button
            type="button"
            className={transferLinkButtonClass}
            onClick={() => onChoice({ transportType: draftTransport })}
          >
            {i18nService.t('mcpTransferConfirmTransport')}
          </button>
        </div>
      )}
    </div>
  );
}
