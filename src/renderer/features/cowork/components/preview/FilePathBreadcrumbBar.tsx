import { ChevronRightIcon } from '@heroicons/react/24/outline';
import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '@/services/i18n';

import {
  type FilePathBreadcrumbLayout,
  fitFilePathBreadcrumb,
  getFilePathBreadcrumb,
} from './filePathBreadcrumb';

interface FilePathBreadcrumbProps {
  filePath: string;
  workspacePath?: string;
  isVisible: boolean;
}

function FileName({ name, truncate }: { name: string; truncate: boolean }) {
  if (!truncate) return <span className="shrink-0 whitespace-nowrap font-semibold">{name}</span>;
  const extensionIndex = name.lastIndexOf('.');
  const extension = extensionIndex > 0 ? name.slice(extensionIndex) : '';
  const stem = Array.from(extensionIndex > 0 ? name.slice(0, extensionIndex) : name);
  return (
    <span
      className="flex min-w-0 flex-1 overflow-hidden whitespace-nowrap font-semibold"
      title={name}
      style={{ minWidth: `min(100%, ${Array.from(extension).length || 1}ch)` }}
    >
      <span className="min-w-0 truncate">{stem.slice(0, -4).join('')}</span>
      <span className="flex max-w-full shrink-0">
        <span className="min-w-0 truncate">{stem.slice(-4).join('')}</span>
        <span className="shrink-0">{extension}</span>
      </span>
    </span>
  );
}

function PathSeparator() {
  return (
    <span className="inline-flex w-5 shrink-0 justify-center" aria-hidden>
      <ChevronRightIcon className="h-3 w-3 text-muted" />
    </span>
  );
}

export default function FilePathBreadcrumbBar({
  filePath,
  workspacePath,
  isVisible,
}: FilePathBreadcrumbProps) {
  const segments = useMemo(
    () => getFilePathBreadcrumb(filePath, workspacePath),
    [filePath, workspacePath],
  );
  const pathRef = useRef<HTMLDivElement>(null);
  const measurementRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const detailsRef = useRef<HTMLDivElement>(null);
  const detailsId = useId();
  const [layout, setLayout] = useState<FilePathBreadcrumbLayout>({ tailStart: 1, truncate: false });
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsPosition, setDetailsPosition] = useState({ left: 8, top: 8, width: 320 });
  const folded = layout.tailStart > 1;
  const lastIndex = segments.length - 1;
  const visibleTailStart = segments.length === 1 ? 0 : layout.tailStart;

  useLayoutEffect(() => {
    const path = pathRef.current;
    const measurement = measurementRef.current;
    if (!path || !measurement || !isVisible) return;
    const measure = () => {
      if (path.clientWidth <= 0) return;
      const styles = getComputedStyle(path);
      const availableWidth =
        path.clientWidth -
        parseFloat(styles.paddingLeft || '0') -
        parseFloat(styles.paddingRight || '0');
      const widths = Array.from(measurement.children, child => child.getBoundingClientRect().width);
      const next = fitFilePathBreadcrumb(widths, Math.max(0, availableWidth));
      setLayout(current =>
        current.tailStart === next.tailStart && current.truncate === next.truncate ? current : next,
      );
    };
    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(path);
    observer?.observe(measurement);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [segments, isVisible]);

  useEffect(() => setDetailsOpen(false), [filePath, workspacePath, isVisible, folded]);

  useLayoutEffect(() => {
    if (!detailsOpen) return;
    const position = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const bounds = trigger.getBoundingClientRect();
      const width = Math.min(440, window.innerWidth - 16);
      setDetailsPosition({
        left: Math.max(8, Math.min(bounds.left, window.innerWidth - width - 8)),
        top: Math.max(
          8,
          Math.min(
            bounds.bottom + 6,
            window.innerHeight - (detailsRef.current?.offsetHeight ?? 0) - 8,
          ),
        ),
        width,
      });
    };
    position();
    detailsRef.current?.focus();
    const outside = (event: PointerEvent) => {
      if (
        !(event.target instanceof Node) ||
        detailsRef.current?.contains(event.target) ||
        triggerRef.current?.contains(event.target)
      )
        return;
      setDetailsOpen(false);
    };
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(position) : null;
    if (detailsRef.current) observer?.observe(detailsRef.current);
    if (pathRef.current) observer?.observe(pathRef.current);
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      observer?.disconnect();
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [detailsOpen]);

  return (
    <div
      ref={pathRef}
      className="relative flex h-8 min-w-0 flex-1 items-center overflow-hidden rounded-full bg-surface-raised px-3 text-[13px] text-foreground"
      title={filePath}
      aria-label={filePath}
    >
      <div
        ref={measurementRef}
        className="pointer-events-none invisible absolute flex w-max whitespace-nowrap"
        aria-hidden
      >
        {segments.map((segment, index) => (
          <span
            key={index}
            data-segment={segment}
            className={`shrink-0 after:content-[attr(data-segment)] ${index === lastIndex ? 'font-semibold' : ''}`}
          />
        ))}
      </div>
      {segments.length > 1 && (
        <>
          <span
            className={`whitespace-nowrap text-foreground/80 ${layout.truncate ? 'min-w-0 max-w-[30%] truncate' : 'shrink-0'}`}
            title={segments[0]}
          >
            {segments[0]}
          </span>
          <PathSeparator />
        </>
      )}
      {folded && (
        <>
          <button
            ref={triggerRef}
            type="button"
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-secondary hover:bg-surface-overlay hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
            aria-label={i18nService.t('coworkFilePathExpand')}
            title={i18nService.t('coworkFilePathExpand')}
            aria-haspopup="dialog"
            aria-expanded={detailsOpen}
            aria-controls={detailsOpen ? detailsId : undefined}
            onClick={() => setDetailsOpen(open => !open)}
          >
            …
          </button>
          <PathSeparator />
        </>
      )}
      {segments.slice(visibleTailStart).map((segment, offset) => {
        const index = visibleTailStart + offset;
        return (
          <Fragment key={index}>
            {offset > 0 && <PathSeparator />}
            {index === lastIndex ? (
              <FileName name={segment} truncate={layout.truncate} />
            ) : (
              <span className="shrink-0 whitespace-nowrap text-foreground/80">{segment}</span>
            )}
          </Fragment>
        );
      })}
      {detailsOpen &&
        isVisible &&
        folded &&
        createPortal(
          <div
            id={detailsId}
            ref={detailsRef}
            role="dialog"
            aria-label={i18nService.t('coworkFilePathExpand')}
            tabIndex={-1}
            className="fixed z-[110] max-h-[calc(100vh-16px)] overflow-y-auto rounded-xl border border-border bg-background p-3 text-[13px] text-foreground shadow-2xl focus:outline-none"
            style={detailsPosition}
            onKeyDown={event => {
              if (event.key !== 'Escape' && event.key !== 'Tab') return;
              if (event.key === 'Escape') event.preventDefault();
              setDetailsOpen(false);
              triggerRef.current?.focus();
            }}
            onBlur={event => {
              if (
                event.relatedTarget !== triggerRef.current &&
                !event.currentTarget.contains(event.relatedTarget as Node | null)
              )
                setDetailsOpen(false);
            }}
          >
            <div className="mb-2 select-text break-all border-b border-border pb-2 text-xs text-secondary">
              {filePath}
            </div>
            <ol className="space-y-1">
              {segments.map((segment, index) => (
                <li
                  key={index}
                  className={`flex items-start gap-1 break-all ${index === lastIndex ? 'font-semibold' : ''}`}
                  style={{ paddingLeft: Math.min(index, 6) * 8 }}
                >
                  {index > 0 && (
                    <ChevronRightIcon className="mt-1 h-3 w-3 shrink-0 text-muted" aria-hidden />
                  )}
                  <span className="min-w-0 select-text">{segment}</span>
                </li>
              ))}
            </ol>
          </div>,
          document.body,
        )}
    </div>
  );
}
