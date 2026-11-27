import { ChevronDownIcon, GlobeAltIcon, TrashIcon } from '@heroicons/react/24/outline';
import {
  isRecordingNetworkEntrySelected,
  recordingNetworkAddressText,
  type RecordingNetworkCapture,
  type RecordingNetworkCapturedEntry,
  RecordingNetworkCoverage,
  type RecordingNetworkCoverageIssue,
  RecordingNetworkGroup,
  RecordingNetworkOutcome,
} from '@shared/browser/browserRecordingNetwork';
import { useState } from 'react';

import { i18nService } from '@/services/i18n';

import { recordingNetworkReviewSummary } from './browserRecordingNetworkReviewState';

const networkGroups = {
  [RecordingNetworkGroup.Load]: 'recordingNetworkLoad',
  [RecordingNetworkGroup.Action]: 'recordingNetworkAction',
  [RecordingNetworkGroup.Unassigned]: 'recordingNetworkUnassigned',
} as const;
const networkOutcomes = {
  [RecordingNetworkOutcome.Failed]: 'recordingNetworkFailed',
  [RecordingNetworkOutcome.Canceled]: 'recordingNetworkCanceled',
  [RecordingNetworkOutcome.Redirected]: 'recordingNetworkRedirected',
  [RecordingNetworkOutcome.Unfinished]: 'recordingNetworkUnfinished',
} as const;
const importantCoverageLabels: Partial<Record<RecordingNetworkCoverageIssue, string>> = {
  [RecordingNetworkCoverage.Unavailable]: 'recordingNetworkUnavailable',
  [RecordingNetworkCoverage.Detached]: 'recordingNetworkDetached',
  [RecordingNetworkCoverage.Limit]: 'recordingNetworkLimit',
  [RecordingNetworkCoverage.Transfer]: 'recordingNetworkTransfer',
};
const networkFailures: Partial<Record<string, string>> = {
  dns: 'recordingNetworkDnsFailure',
  tls: 'recordingNetworkTlsFailure',
  timeout: 'recordingNetworkTimeoutFailure',
  blocked: 'recordingNetworkBlockedFailure',
  cors: 'recordingNetworkCorsFailure',
};
const t = (key: string) => i18nService.t(key);
const PAGE_SIZE = 30;

function numberLabel(value: number): string {
  return value.toLocaleString(i18nService.getLanguage(), { maximumFractionDigits: 2 });
}

function NetworkRequest({
  entry,
  stepNumber,
  pageLabel,
  include,
  enabled,
  addressMode,
  onInclude,
  onMode,
  onDelete,
}: {
  entry: RecordingNetworkCapturedEntry;
  stepNumber?: number;
  pageLabel?: string;
  include: boolean;
  enabled: boolean;
  addressMode?: 'without-query' | 'origin';
  onInclude: (include: boolean) => void;
  onMode: (mode: 'without-query' | 'origin' | undefined) => void;
  onDelete: () => void;
}) {
  const address = recordingNetworkAddressText(entry, t('recordingNetworkCredentialHidden'));
  const canChangeAddress = enabled && include && Boolean(entry.path || entry.search);
  const context = [
    stepNumber !== undefined
      ? t('recordingNetworkStep').replace('{number}', String(stepNumber))
      : entry.loadSequence !== undefined
        ? t('recordingNetworkLoadNumber').replace('{number}', String(entry.loadSequence))
        : undefined,
    pageLabel,
    ...(entry.urlLimited ? [t('recordingNetworkAddressLimited')] : []),
  ]
    .filter(Boolean)
    .join(' · ');
  const outcomeKind = entry.outcome;
  const complete = outcomeKind === RecordingNetworkOutcome.Complete;
  const failed = outcomeKind === RecordingNetworkOutcome.Failed || (entry.status ?? 0) >= 400;
  const status =
    entry.status !== undefined && (!complete || failed) ? `HTTP ${entry.status}` : undefined;
  const outcome =
    outcomeKind === RecordingNetworkOutcome.Complete ||
    (outcomeKind === RecordingNetworkOutcome.Redirected && status)
      ? undefined
      : t((entry.failure && networkFailures[entry.failure]) || networkOutcomes[outcomeKind]);
  const result = [status, outcome].filter(Boolean).join(' · ');
  return (
    <li className="recording-network-request">
      {enabled && (
        <input
          type="checkbox"
          aria-label={t('recordingNetworkIncludeEntry')
            .replace('{method}', entry.method)
            .replace('{address}', address)}
          checked={include}
          onChange={event => onInclude(event.target.checked)}
        />
      )}
      <div className="recording-network-request-content">
        <div className="recording-network-request-heading">
          <code className="recording-network-method">{entry.method}</code>
          <code className="recording-network-address" title={address}>
            {address}
          </code>
        </div>
        {(context || result || canChangeAddress) && (
          <div className="recording-network-request-meta">
            {(context || result) && (
              <small className="recording-network-context">
                {context}
                {context && result && ' · '}
                {result && <span data-failed={failed}>{result}</span>}
              </small>
            )}
            {canChangeAddress && (
              <select
                className="recording-network-address-mode"
                aria-label={t('recordingNetworkAddressMode')}
                value={addressMode ?? ''}
                onChange={event => {
                  const value = event.currentTarget.value;
                  onMode(value === 'without-query' || value === 'origin' ? value : undefined);
                }}
              >
                <option value="">{t('recordingNetworkFullAddress')}</option>
                {entry.search && (
                  <option value="without-query">{t('recordingNetworkWithoutQuery')}</option>
                )}
                <option value="origin">{t('recordingNetworkOnlyOrigin')}</option>
              </select>
            )}
          </div>
        )}
      </div>
      <button
        type="button"
        className="recording-icon-button recording-network-delete"
        aria-label={t('recordingNetworkDelete')}
        title={t('recordingNetworkDelete')}
        onClick={onDelete}
      >
        <TrashIcon aria-hidden="true" />
      </button>
    </li>
  );
}

export function BrowserRecordingNetworkReview({
  capture,
  attachedCount,
  omittedToSend,
  partial,
  stepNumbers,
  pageLabels,
  onChange,
}: {
  capture: RecordingNetworkCapture;
  attachedCount: number;
  omittedToSend: number;
  partial: boolean;
  stepNumbers: ReadonlyMap<string, number>;
  pageLabels: ReadonlyMap<string, string>;
  onChange: (capture: RecordingNetworkCapture) => void;
}) {
  const [visibleRows, setVisibleRows] = useState<Record<keyof typeof networkGroups, number>>({
    load: PAGE_SIZE,
    action: PAGE_SIZE,
    unassigned: PAGE_SIZE,
  });
  const enabled = capture.include === true;
  const coverageLabels = [...new Set(capture.coverage)]
    .filter(issue => issue !== RecordingNetworkCoverage.Limit || !capture.omittedCount)
    .map(issue => importantCoverageLabels[issue])
    .filter(label => label !== undefined);
  const hasSpecificNotice = coverageLabels.length > 0 || capture.omittedCount > 0;
  const showPartial = !hasSpecificNotice && (
    partial || capture.coverage.includes(RecordingNetworkCoverage.LateStart) ||
    capture.coverage.includes(RecordingNetworkCoverage.Unattributed)
  );
  const hasNotices = showPartial || hasSpecificNotice;
  const setIncluded = (entries: RecordingNetworkCapturedEntry[], include: boolean) =>
    onChange({
      ...capture,
      selections: {
        ...capture.selections,
        ...Object.fromEntries(entries.map(entry => [entry.id, include])),
      },
    });
  return (
    <details className="recording-network recording-network-disclosure">
      <summary>
        <GlobeAltIcon aria-hidden="true" />
        <strong>{t('recordingNetwork')}</strong>
        <span>{recordingNetworkReviewSummary(capture.entries.length, attachedCount)}</span>
        <ChevronDownIcon className="recording-network-chevron" aria-hidden="true" />
      </summary>
      <div className="recording-network-body">
        <label className="recording-network-toggle">
          <input
            type="checkbox"
            checked={enabled}
            disabled={capture.entries.length === 0 && !enabled}
            onChange={event => onChange({ ...capture, include: event.target.checked })}
          />
          {t('recordingNetworkInclude')}
        </label>
        {!enabled && capture.entries.length > 0 && (
          <p className="recording-network-note">{t('recordingNetworkLocalOnly')}</p>
        )}
        {omittedToSend > 0 && (
          <p className="recording-network-note" role="status">
            {t('recordingNetworkSendOmitted').replace('{count}', numberLabel(omittedToSend))}
          </p>
        )}
        {hasNotices && (
          <ul className="recording-network-notices">
            {showPartial && <li>{t('recordingNetworkPartial')}</li>}
            {coverageLabels.map(label => (
              <li key={label}>{t(label)}</li>
            ))}
            {capture.omittedCount > 0 && (
              <li>
                {t('recordingNetworkCaptureOmitted').replace(
                  '{count}',
                  numberLabel(capture.omittedCount),
                )}
              </li>
            )}
          </ul>
        )}
        {!capture.entries.length && !hasNotices && (
          <p className="recording-network-note">{t('recordingNetworkEmpty')}</p>
        )}
        {(Object.keys(networkGroups) as (keyof typeof networkGroups)[]).map(group => {
          const entries = capture.entries.filter(entry => entry.group === group);
          if (!entries.length) return null;
          const allSelected = entries.every(entry =>
            isRecordingNetworkEntrySelected(capture, entry),
          );
          const remaining = entries.length - visibleRows[group];
          return (
            <details className="recording-network-group recording-network-disclosure" key={group}>
              <summary>
                <strong>{t(networkGroups[group])}</strong>
                <span>
                  {t('recordingNetworkCount').replace('{count}', numberLabel(entries.length))}
                </span>
                <ChevronDownIcon className="recording-network-chevron" aria-hidden="true" />
              </summary>
              {enabled && (
                <button
                  type="button"
                  className="recording-button"
                  onClick={() => setIncluded(entries, !allSelected)}
                >
                  {t(allSelected ? 'recordingNetworkExcludeGroup' : 'recordingNetworkIncludeGroup')}
                </button>
              )}
              <ul className="recording-network-list">
                {entries.slice(0, visibleRows[group]).map(entry => (
                  <NetworkRequest
                    key={entry.id}
                    entry={entry}
                    stepNumber={entry.stepId ? stepNumbers.get(entry.stepId) : undefined}
                    pageLabel={pageLabels.get(entry.pageId)}
                    enabled={enabled}
                    include={isRecordingNetworkEntrySelected(capture, entry)}
                    addressMode={capture.addressModes?.[entry.id]}
                    onInclude={include => setIncluded([entry], include)}
                    onMode={mode => {
                      const addressModes = { ...capture.addressModes };
                      if (mode) addressModes[entry.id] = mode;
                      else delete addressModes[entry.id];
                      onChange({ ...capture, addressModes });
                    }}
                    onDelete={() => {
                      const selections = { ...capture.selections };
                      const addressModes = { ...capture.addressModes };
                      delete selections[entry.id];
                      delete addressModes[entry.id];
                      onChange({
                        ...capture,
                        entries: capture.entries.filter(item => item.id !== entry.id),
                        selections,
                        addressModes,
                      });
                    }}
                  />
                ))}
              </ul>
              {remaining > 0 && (
                <button
                  type="button"
                  className="recording-button"
                  onClick={() =>
                    setVisibleRows(rows => ({ ...rows, [group]: rows[group] + PAGE_SIZE }))
                  }
                >
                  {t('recordingNetworkMore').replace('{count}', numberLabel(remaining))}
                </button>
              )}
            </details>
          );
        })}
      </div>
    </details>
  );
}
