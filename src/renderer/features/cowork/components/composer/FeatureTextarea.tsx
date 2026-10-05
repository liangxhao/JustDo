import { ShareIcon } from '@heroicons/react/24/outline';
import { forwardRef, type TextareaHTMLAttributes, useLayoutEffect, useRef, useState } from 'react';

/** An atomic first-line prefix; the native textarea continues to own plain text. */
const FeatureTextarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & {
    featureLabel?: string;
    containerClassName?: string;
    removeLabel: string;
    onRemoveFeature: () => void;
    onLayoutChange?: (textarea: HTMLTextAreaElement) => void;
  }
>(function FeatureTextarea(
  {
    featureLabel,
    containerClassName = '',
    removeLabel,
    onRemoveFeature,
    onLayoutChange,
    style,
    onKeyDown,
    onChange,
    onCut,
    onScroll,
    onSelect,
    onPointerDown,
    onCompositionStart,
    onCompositionEnd,
    ...props
  },
  forwardedRef,
) {
  const input = useRef<HTMLTextAreaElement | null>(null);
  const token = useRef<HTMLButtonElement>(null);
  const selectAll = useRef(false);
  const composing = useRef(false);
  const compositionReplacement = useRef<string | undefined>(undefined);
  const layoutChanged = useRef(onLayoutChange);
  layoutChanged.current = onLayoutChange;
  const [layout, setLayout] = useState({ width: 0, left: 0, top: 0, lineHeight: 24 });
  const [scrollTop, setScrollTop] = useState(0);
  useLayoutEffect(() => {
    selectAll.current = false;
    if (!featureLabel || !input.current || !token.current) return;
    const measure = () => {
      const css = getComputedStyle(input.current!);
      setLayout({
        width: token.current!.getBoundingClientRect().width + 6,
        left: parseFloat(css.paddingLeft) || 0,
        top: parseFloat(css.paddingTop) || 0,
        lineHeight: parseFloat(css.lineHeight) || 24,
      });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(token.current);
    observer.observe(input.current);
    return () => observer.disconnect();
  }, [featureLabel, props.className]);
  useLayoutEffect(() => {
    if (input.current) layoutChanged.current?.(input.current);
  }, [featureLabel, layout.width]);
  const hasFullSelection = (field: HTMLTextAreaElement) =>
    field.selectionStart === 0 && field.selectionEnd === field.value.length;
  const remove = () => {
    if (props.disabled || props.readOnly) return;
    selectAll.current = false;
    onRemoveFeature();
    input.current?.focus();
  };
  return (
    <div className={`relative min-w-0 flex-1 overflow-hidden ${containerClassName}`}>
      <textarea
        {...props}
        ref={element => {
          input.current = element;
          if (typeof forwardedRef === 'function') forwardedRef(element);
          else if (forwardedRef) forwardedRef.current = element;
        }}
        style={{
          ...style,
          display: 'block',
          width: '100%',
          textIndent: featureLabel ? layout.width : undefined,
        }}
        onScroll={event => {
          setScrollTop(event.currentTarget.scrollTop);
          onScroll?.(event);
        }}
        onKeyDown={event => {
          if (featureLabel && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            const field = event.currentTarget;
            if (selectAll.current && !hasFullSelection(field)) selectAll.current = false;
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
              selectAll.current = true;
            } else if (
              event.key === 'Backspace' &&
              field.selectionStart === 0 &&
              field.selectionEnd === 0
            ) {
              event.preventDefault();
              remove();
              return;
            } else if (
              event.key === 'ArrowLeft' &&
              field.selectionStart === 0 &&
              field.selectionEnd === 0
            ) {
              event.preventDefault();
              token.current?.focus();
              return;
            } else if (selectAll.current && ['Backspace', 'Delete'].includes(event.key)) {
              remove();
            } else if (
              event.key.startsWith('Arrow') ||
              ['Home', 'End', 'Escape'].includes(event.key)
            ) {
              selectAll.current = false;
            }
          }
          onKeyDown?.(event);
        }}
        onPointerDown={event => {
          selectAll.current = false;
          onPointerDown?.(event);
        }}
        onSelect={event => {
          const field = event.currentTarget;
          selectAll.current = field.value.length > 0 ? hasFullSelection(field) : selectAll.current;
          onSelect?.(event);
        }}
        onCompositionStart={event => {
          composing.current = true;
          compositionReplacement.current =
            selectAll.current && hasFullSelection(event.currentTarget)
              ? event.currentTarget.value
              : undefined;
          onCompositionStart?.(event);
        }}
        onCompositionEnd={event => {
          composing.current = false;
          if (
            featureLabel &&
            compositionReplacement.current !== undefined &&
            compositionReplacement.current !== event.currentTarget.value
          )
            remove();
          compositionReplacement.current = undefined;
          onCompositionEnd?.(event);
        }}
        onChange={event => {
          if (featureLabel && selectAll.current && !composing.current) remove();
          onChange?.(event);
        }}
        onCut={event => {
          if (featureLabel && selectAll.current && hasFullSelection(event.currentTarget)) remove();
          onCut?.(event);
        }}
      />
      {featureLabel && (
        <button
          ref={token}
          type="button"
          disabled={props.disabled || props.readOnly}
          aria-label={removeLabel}
          title={removeLabel}
          className="absolute inline-flex select-none items-center gap-1 whitespace-nowrap rounded text-sm font-medium text-primary focus:bg-primary/15 focus:outline-none"
          style={{ left: layout.left, top: layout.top - scrollTop, height: layout.lineHeight }}
          onClick={remove}
          onKeyDown={event => {
            if (event.key === 'Backspace' || event.key === 'Delete') {
              event.preventDefault();
              remove();
            } else if (event.key === 'ArrowRight' || event.key === 'Escape') {
              event.preventDefault();
              input.current?.focus();
              input.current?.setSelectionRange(0, 0);
            }
          }}
        >
          <ShareIcon className="h-3.5 w-3.5" />
          {featureLabel}
        </button>
      )}
    </div>
  );
});

export default FeatureTextarea;
