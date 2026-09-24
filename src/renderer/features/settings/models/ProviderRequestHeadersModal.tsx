import { EyeIcon, EyeSlashIcon, PlusIcon, TrashIcon } from '@heroicons/react/24/outline';
import {
  MODEL_PROVIDER_HEADER_LIMITS,
  normalizeModelProviderHeaders,
  validateModelProviderHeaderName,
  validateModelProviderHeaderValue,
} from '@shared/providers/modelProviderHeaders';
import React, { useEffect, useId, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/common/Modal';

type HeaderRow = { id: string; name: string; value: string };

interface ProviderRequestHeadersModalProps {
  isOpen: boolean;
  providerName: string;
  headers?: Record<string, string>;
  onClose: () => void;
  onSave: (headers: Record<string, string>) => void;
}

const createRow = (name = '', value = ''): HeaderRow => ({
  id: crypto.randomUUID(),
  name,
  value,
});

const ProviderRequestHeadersModal: React.FC<ProviderRequestHeadersModalProps> = ({
  isOpen,
  providerName,
  headers,
  onClose,
  onSave,
}) => {
  const [rows, setRows] = useState<HeaderRow[]>([]);
  const [showValues, setShowValues] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const entries = Object.entries(headers ?? {});
    setRows(entries.length > 0 ? entries.map(([name, value]) => createRow(name, value)) : []);
    setShowValues(false);
    setError(null);
  }, [headers, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    dialogRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const updateRow = (id: string, field: 'name' | 'value', value: string): void => {
    setRows(current => current.map(row => (row.id === id ? { ...row, [field]: value } : row)));
    setError(null);
  };

  const handleSave = (): void => {
    const populatedRows = rows.filter(row => row.name.trim() || row.value);
    if (populatedRows.length > MODEL_PROVIDER_HEADER_LIMITS.count) {
      setError(i18nService.t('providerHeadersTooMany'));
      return;
    }
    const nextEntries: Array<[string, string]> = [];
    const seen = new Set<string>();
    for (const row of populatedRows) {
      const name = row.name.trim();
      const nameError = validateModelProviderHeaderName(name);
      if (nameError) {
        setError(
          i18nService.t(
            nameError === 'forbidden-name'
              ? 'providerHeaderNameForbidden'
              : 'providerHeaderNameInvalid',
          ),
        );
        return;
      }
      if (validateModelProviderHeaderValue(row.value)) {
        setError(i18nService.t('providerHeaderValueInvalid'));
        return;
      }
      const identity = name.toLowerCase();
      if (seen.has(identity)) {
        setError(i18nService.t('providerHeaderNameDuplicate'));
        return;
      }
      seen.add(identity);
      nextEntries.push([name, row.value]);
    }
    const next = Object.fromEntries(nextEntries);
    onSave(normalizeModelProviderHeaders(next));
    onClose();
  };

  if (!isOpen) return null;

  return (
    <Modal
      onClose={onClose}
      overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      className="mx-4 w-full max-w-xl rounded-2xl border border-border bg-surface p-5 shadow-2xl"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="outline-none"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold text-foreground">
              {i18nService.t('providerHeadersTitle')}
            </h2>
            <p className="mt-1 truncate text-xs text-secondary" title={providerName}>
              {providerName}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowValues(current => !current)}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border-input px-2.5 text-xs text-secondary hover:text-foreground"
            aria-pressed={showValues}
          >
            {showValues ? (
              <EyeSlashIcon className="h-4 w-4" aria-hidden="true" />
            ) : (
              <EyeIcon className="h-4 w-4" aria-hidden="true" />
            )}
            {i18nService.t(showValues ? 'providerHeadersHideValues' : 'providerHeadersShowValues')}
          </button>
        </div>

        <div className="mt-4 max-h-[45vh] space-y-2 overflow-y-auto pr-1">
          {rows.map(row => (
            <div key={row.id} className="flex items-center gap-2">
              <input
                type="text"
                value={row.name}
                onChange={event => updateRow(row.id, 'name', event.target.value)}
                placeholder={i18nService.t('providerHeaderNamePlaceholder')}
                aria-label={i18nService.t('providerHeaderName')}
                className="min-w-0 flex-1 rounded-lg border border-border-input bg-background px-2.5 py-2 text-xs text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
              />
              <input
                type={showValues ? 'text' : 'password'}
                value={row.value}
                onChange={event => updateRow(row.id, 'value', event.target.value)}
                placeholder={i18nService.t('providerHeaderValuePlaceholder')}
                aria-label={i18nService.t('providerHeaderValue')}
                className="min-w-0 flex-[1.4] rounded-lg border border-border-input bg-background px-2.5 py-2 text-xs text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
              />
              <button
                type="button"
                onClick={() =>
                  setRows(current => current.filter(candidate => candidate.id !== row.id))
                }
                className="rounded-lg p-2 text-secondary hover:bg-red-500/10 hover:text-red-500"
                aria-label={i18nService.t('providerHeaderDelete')}
              >
                <TrashIcon className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          ))}
          {rows.length === 0 && (
            <div className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-xs text-muted">
              {i18nService.t('providerHeadersEmpty')}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => setRows(current => [...current, createRow()])}
          disabled={rows.length >= MODEL_PROVIDER_HEADER_LIMITS.count}
          className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-lg border border-border-input px-2.5 text-xs font-medium text-foreground hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-40"
        >
          <PlusIcon className="h-4 w-4" aria-hidden="true" />
          {i18nService.t('providerHeaderAdd')}
        </button>

        {error && (
          <p role="alert" className="mt-3 text-xs text-red-500">
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2 border-t border-border pt-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border-input px-4 py-2 text-xs font-medium text-secondary hover:text-foreground"
          >
            {i18nService.t('cancel')}
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="rounded-lg bg-primary px-4 py-2 text-xs font-medium text-white hover:bg-primary-hover"
          >
            {i18nService.t('save')}
          </button>
        </div>
      </div>
    </Modal>
  );
};

export default ProviderRequestHeadersModal;
