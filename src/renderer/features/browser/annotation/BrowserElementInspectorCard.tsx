import { CheckCircleIcon, CursorArrowRaysIcon } from '@heroicons/react/24/outline';
import type { BrowserInspectedElement } from '@shared/browser/browser';
import type { CSSProperties, ReactNode } from 'react';

import { i18nService } from '@/services/i18n';

const displayValue = (value: string | undefined): string => value?.trim() || '—';

const ColorValue = ({ value }: { value: string }) => (
  <span className="flex min-w-0 items-center gap-1.5">
    <span
      className="h-3.5 w-3.5 shrink-0 rounded border border-white/15 shadow-sm"
      style={{ backgroundColor: value }}
    />
    <span className="truncate font-mono">{displayValue(value)}</span>
  </span>
);

const PropertyRow = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="grid grid-cols-[76px_minmax(0,1fr)] items-center gap-2 py-1">
    <span className="text-[10px] text-white/45">{label}</span>
    <div className="min-w-0 truncate text-[11px] text-white/85">{children}</div>
  </div>
);

export default function BrowserElementInspectorCard({
  element,
  locked,
  embedded = false,
  style,
}: {
  element: BrowserInspectedElement;
  locked: boolean;
  embedded?: boolean;
  style: CSSProperties;
}) {
  const computed = element.computedStyle;
  const identity = `${element.tag}${element.id ? `#${element.id}` : ''}${element.classes
    .slice(0, 2)
    .map(name => `.${name}`)
    .join('')}`;

  return (
    <div
      className={`${locked ? 'pointer-events-auto select-text' : 'pointer-events-none'} ${embedded ? 'relative w-full' : 'absolute z-20 w-[292px] max-w-[calc(100%-16px)]'} overflow-hidden rounded-xl border border-white/10 bg-neutral-900/95 text-white shadow-2xl backdrop-blur-md`}
      style={style}
      role="tooltip"
    >
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-white/10">
          {locked ? (
            <CheckCircleIcon className="h-4 w-4 text-emerald-400" />
          ) : (
            <CursorArrowRaysIcon className="h-4 w-4 text-sky-400" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-xs font-semibold text-white">{identity}</div>
          <div className="truncate text-[10px] text-white/45">
            {locked
              ? i18nService.t('browserInspectorLocked')
              : i18nService.t('browserInspectorHovering')}
          </div>
        </div>
        <span className="rounded bg-white/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-white/55">
          {element.focusable
            ? i18nService.t('browserInspectorFocusable')
            : element.role || element.tag}
        </span>
      </div>

      <div className="max-h-72 overflow-y-auto px-3 py-2">
        <div className="mb-1 truncate rounded-md bg-black/25 px-2 py-1.5 font-mono text-[10px] text-sky-300">
          {element.cssPath || identity}
        </div>

        {(element.name || element.role) && (
          <div className="mb-1.5 rounded-md border border-white/5 bg-white/[0.03] px-2 py-1">
            {element.name && (
              <PropertyRow label={i18nService.t('browserInspectorName')}>
                {element.name}
              </PropertyRow>
            )}
            {element.role && (
              <PropertyRow label={i18nService.t('browserInspectorRole')}>
                <span className="font-mono">{element.role}</span>
              </PropertyRow>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-x-3 border-b border-white/10 pb-1">
          <PropertyRow label={i18nService.t('browserInspectorSize')}>
            <span className="font-mono">
              {Math.round(element.rect.width)} × {Math.round(element.rect.height)}
            </span>
          </PropertyRow>
          <PropertyRow label={i18nService.t('browserInspectorPosition')}>
            <span className="font-mono">
              {Math.round(element.rect.x)}, {Math.round(element.rect.y)}
            </span>
          </PropertyRow>
        </div>

        {computed && (
          <div className="pt-1">
            <PropertyRow label={i18nService.t('browserInspectorTextColor')}>
              <ColorValue value={computed.color} />
            </PropertyRow>
            <PropertyRow label={i18nService.t('browserInspectorBackground')}>
              <ColorValue value={computed.backgroundColor} />
            </PropertyRow>
            <PropertyRow label={i18nService.t('browserInspectorOpacity')}>
              <span className="font-mono">{displayValue(computed.opacity)}</span>
            </PropertyRow>
            <PropertyRow label={i18nService.t('browserInspectorFont')}>
              <span title={computed.fontFamily}>
                {displayValue(computed.fontFamily)} · {displayValue(computed.fontSize)} ·{' '}
                {displayValue(computed.fontWeight)}
              </span>
            </PropertyRow>
            <PropertyRow label={i18nService.t('browserInspectorLayout')}>
              <span className="font-mono">
                {displayValue(computed.display)} / {displayValue(computed.position)}
                {computed.zIndex && computed.zIndex !== 'auto' ? ` / z:${computed.zIndex}` : ''}
              </span>
            </PropertyRow>
            <PropertyRow label={i18nService.t('browserInspectorRadius')}>
              <span className="font-mono">{displayValue(computed.borderRadius)}</span>
            </PropertyRow>
          </div>
        )}
      </div>
    </div>
  );
}
