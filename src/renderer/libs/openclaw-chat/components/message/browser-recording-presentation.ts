import type { BrowserRecordingDraft, BrowserRecordingStep } from '@shared/browser/browserRecording';
import { RecordingAction } from '@shared/browser/browserRecording';

import { i18nService } from '@/services/i18n';

/** Shared human-readable evidence for React editor and Lit message cards. */
export function recordingEvidenceRows(
  step: BrowserRecordingStep,
): { label: string; value: string }[] {
  if (step.sensitive) return [];
  const t = (key: string) => i18nService.t(key);
  const target = step.target;
  const interaction = step.interaction;
  const rows: { label: string; value: string }[] = [];
  const add = (key: string, value: string | undefined) => {
    if (value) rows.push({ label: t(key), value });
  };
  const state = (value: Record<string, string | boolean> | undefined) =>
    Object.entries(value ?? {})
      .map(([key, v]) => `${key}: ${String(v)}`)
      .join(' · ');
  add(
    'recordingLocators',
    target?.locators
      ?.map(
        l =>
          `${l.kind}: ${l.value}${l.name ? ` · ${l.name}` : ''}\n${t(l.verified ? 'recordingLocatorVerified' : 'recordingLocatorHint')} · ${t('recordingLocatorMatches').replace('{count}', String(l.matches))}${l.dynamic ? ` · ${t('recordingLocatorDynamic')}` : ''}`,
      )
      .join('\n\n'),
  );
  add(
    'recordingScopes',
    target?.scopes
      ?.map(
        s =>
          `${s.kind}: ${s.selector || t('recordingUnavailableValue')}${s.url ? `\n${s.url}` : ''}`,
      )
      .join('\n'),
  );
  add(
    'recordingAttributes',
    Object.entries(target?.attributes ?? {})
      .map(([key, value]) => `${key}="${value}"`)
      .join('\n'),
  );
  add('recordingElementState', state(target?.state));
  add(
    'recordingElementContext',
    target?.context?.map(c => `${c.tag} · ${c.name}\n${c.selector}`).join('\n\n'),
  );
  add(
    'recordingBounds',
    target?.bounds
      ? `x: ${target.bounds.x}, y: ${target.bounds.y}, w: ${target.bounds.width}, h: ${target.bounds.height}`
      : undefined,
  );
  add(
    'recordingPointer',
    interaction?.pointer
      ? `x: ${interaction.pointer.x}, y: ${interaction.pointer.y} · offset: ${interaction.pointer.offsetX}, ${interaction.pointer.offsetY}`
      : undefined,
  );
  add(
    'recordingOrigin',
    interaction?.origin && interaction.origin !== target?.selector ? interaction.origin : undefined,
  );
  add('recordingDestination', interaction?.destination);
  add(
    'recordingDestinationScope',
    interaction?.destinationElement
      ? [
          interaction.destinationElement.name,
          ...(interaction.destinationElement.scopes ?? []).map(s => `${s.kind}: ${s.selector}`),
        ]
          .filter(Boolean)
          .join('\n')
      : undefined,
  );
  add(
    'recordingOptions',
    interaction?.options?.map(o => `${o.label} · value: ${o.value} · index: ${o.index}`).join('\n'),
  );
  add(
    'recordingScrollScope',
    interaction?.scroll
      ? t(interaction.scroll.scope === 'page' ? 'recordingPage' : 'recordingKindRegion')
      : undefined,
  );
  add(
    'recordingObserved',
    interaction?.observed
      ? [
          interaction.observed.url,
          state(interaction.observed.state),
          ...(interaction.observed.messages ?? []),
        ]
          .filter(Boolean)
          .join('\n')
      : undefined,
  );
  add('recordingLimitations', target?.limitations?.map(l => t(`recordingLimit_${l}`)).join('\n'));
  return rows;
}

export function recordingElementKind(step: BrowserRecordingStep): string {
  const role = step.target?.role;
  const tag = step.target?.tag?.toLowerCase();
  const key =
    role === 'button' || tag === 'button'
      ? 'recordingKindButton'
      : role === 'link' || tag === 'a'
        ? 'recordingKindLink'
        : role === 'searchbox' || role === 'textbox' || tag === 'input' || tag === 'textarea'
          ? 'recordingKindInput'
          : tag === 'select'
            ? 'recordingKindSelect'
            : tag === 'img'
              ? 'recordingKindImage'
              : 'recordingKindRegion';
  return i18nService.t(key);
}

/** Scroll values are absolute CSS pixel offsets, not the distance of a gesture. */
export function recordingActionValue(step: BrowserRecordingStep): {
  label: string;
  text: string;
  hint?: string;
} {
  const t = (key: string) => i18nService.t(key);
  const value = step.value ?? '';
  if (step.sensitive) return { label: t('recordingValue'), text: t('recordingSensitive') };
  if (step.action === RecordingAction.Scroll) {
    const parts = value.split(',').map(part => part.trim());
    const valid =
      parts.length === 2 &&
      parts.every(part => /^-?\d+(?:\.\d+)?$/.test(part) && Number.isFinite(Number(part)));
    return {
      label: t('recordingScrollPosition'),
      text: valid
        ? t('recordingScrollCoordinates').replace('{x}', parts[0]).replace('{y}', parts[1])
        : value,
    };
  }
  if (step.action === RecordingAction.Key) {
    return { label: t('recordingPressedKey'), text: value };
  }
  if (step.action === RecordingAction.Select) {
    const checked = step.target?.tag === 'input' && ['true', 'false'].includes(value);
    return {
      label: t(checked ? 'recordingCheckedState' : 'recordingSelectedOption'),
      text: checked
        ? t(value === 'true' ? 'recordingChecked' : 'recordingUnchecked')
        : value || t('recordingEmptyValue'),
    };
  }
  return {
    label: t(step.action === RecordingAction.Input ? 'recordingValue' : 'recordingRecordedValue'),
    text: step.action === RecordingAction.Input && value === '' ? t('recordingEmptyValue') : value,
  };
}

export function recordingSummary(
  draft: BrowserRecordingDraft,
  includeHistoryReferences = false,
): string {
  const images =
    draft.images.length ||
    (includeHistoryReferences
      ? draft.steps.reduce((sum, step) => sum + (step.screenshotFiles?.length ?? 0), 0)
      : 0);
  return i18nService
    .t('recordingSummary')
    .replace('{steps}', String(draft.steps.length))
    .replace('{pages}', String(new Set(draft.steps.map(step => step.pageId)).size))
    .replace('{images}', String(images));
}

export function recordingPageLabel(step: BrowserRecordingStep): string {
  try {
    return new URL(step.url).hostname;
  } catch {
    return step.title || i18nService.t('recordingPage');
  }
}

export function hasRecordingElement(step: BrowserRecordingStep): boolean {
  return (
    !step.sensitive &&
    !!(step.target?.tag || step.target?.name || step.target?.selector || step.target?.html)
  );
}

export function recordingTargetLabel(step: BrowserRecordingStep): string {
  if (step.sensitive) return i18nService.t('recordingSensitive');
  if (hasRecordingElement(step))
    return step.target!.name || step.target!.selector || `<${step.target!.tag}>`;
  return step.title && !/^https?:\/\/|^[\w.-]+\.[a-z]{2,}\//i.test(step.title)
    ? step.title
    : recordingPageLabel(step);
}
