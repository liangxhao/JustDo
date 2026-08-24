import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  position?: 'top' | 'bottom' | 'left' | 'right';
  delay?: number;
  maxWidth?: string;
  disabled?: boolean;
  renderInPortal?: boolean;
}

const Tooltip: React.FC<TooltipProps> = ({
  content,
  children,
  className = '',
  position = 'top',
  delay = 300,
  maxWidth = '280px',
  disabled = false,
  renderInPortal = false,
}) => {
  const [isVisible, setIsVisible] = useState(false);
  const [tooltipStyle, setTooltipStyle] = useState<React.CSSProperties | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const isHoveredRef = useRef(false);
  const isFocusedWithinRef = useRef(false);

  const showTooltip = useCallback(() => {
    if (disabled || isVisible || timeoutRef.current) return;
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null;
      setIsVisible(true);
    }, delay);
  }, [delay, disabled, isVisible]);

  const hideTooltipIfInactive = useCallback(() => {
    if (isHoveredRef.current || isFocusedWithinRef.current) return;
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setIsVisible(false);
  }, []);

  const handleMouseEnter = useCallback(() => {
    isHoveredRef.current = true;
    showTooltip();
  }, [showTooltip]);

  const handleMouseLeave = useCallback(() => {
    isHoveredRef.current = false;
    hideTooltipIfInactive();
  }, [hideTooltipIfInactive]);

  const handleFocusCapture = useCallback(() => {
    isFocusedWithinRef.current = true;
    showTooltip();
  }, [showTooltip]);

  const handleBlurCapture = useCallback(
    (event: React.FocusEvent<HTMLDivElement>) => {
      if (
        event.relatedTarget instanceof Node &&
        wrapperRef.current?.contains(event.relatedTarget)
      ) {
        return;
      }
      isFocusedWithinRef.current = false;
      hideTooltipIfInactive();
    },
    [hideTooltipIfInactive],
  );

  const updatePosition = useCallback(() => {
    if (!wrapperRef.current || !tooltipRef.current) return;
    const anchorRect = wrapperRef.current.getBoundingClientRect();
    const tooltipRect = tooltipRef.current.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const margin = 8;
    type TooltipPosition = 'top' | 'bottom' | 'left' | 'right';

    const positions = {
      top: {
        top: anchorRect.top - tooltipRect.height - margin,
        left: anchorRect.left + anchorRect.width / 2 - tooltipRect.width / 2,
      },
      bottom: {
        top: anchorRect.bottom + margin,
        left: anchorRect.left + anchorRect.width / 2 - tooltipRect.width / 2,
      },
      left: {
        top: anchorRect.top + anchorRect.height / 2 - tooltipRect.height / 2,
        left: anchorRect.left - tooltipRect.width - margin,
      },
      right: {
        top: anchorRect.top + anchorRect.height / 2 - tooltipRect.height / 2,
        left: anchorRect.right + margin,
      },
    };

    const fits = (pos: { top: number; left: number }) =>
      pos.top >= margin &&
      pos.left >= margin &&
      pos.top + tooltipRect.height <= viewportHeight - margin &&
      pos.left + tooltipRect.width <= viewportWidth - margin;

    const fallbackOrderMap: Record<TooltipPosition, TooltipPosition[]> = {
      top: ['top', 'bottom', 'right', 'left'],
      bottom: ['bottom', 'top', 'right', 'left'],
      left: ['left', 'right', 'top', 'bottom'],
      right: ['right', 'left', 'top', 'bottom'],
    };
    const fallbackOrder = fallbackOrderMap[position];

    let chosen = positions[fallbackOrder[0]];
    for (const key of fallbackOrder) {
      const candidate = positions[key];
      if (fits(candidate)) {
        chosen = candidate;
        break;
      }
    }

    const clampedLeft = Math.min(
      Math.max(chosen.left, margin),
      viewportWidth - tooltipRect.width - margin,
    );
    const clampedTop = Math.min(
      Math.max(chosen.top, margin),
      viewportHeight - tooltipRect.height - margin,
    );

    setTooltipStyle({
      position: 'fixed',
      top: Math.round(clampedTop),
      left: Math.round(clampedLeft),
      maxWidth,
      width: 'max-content',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
    });
  }, [maxWidth, position]);

  useLayoutEffect(() => {
    if (!isVisible) return;
    updatePosition();
  }, [isVisible, updatePosition, content]);

  useEffect(() => {
    if (!isVisible) return;
    const handleUpdate = () => updatePosition();
    window.addEventListener('resize', handleUpdate);
    window.addEventListener('scroll', handleUpdate, true);
    return () => {
      window.removeEventListener('resize', handleUpdate);
      window.removeEventListener('scroll', handleUpdate, true);
    };
  }, [isVisible, updatePosition]);

  const tooltipElement = isVisible && content && (
    <div
      ref={tooltipRef}
      role="tooltip"
      className={`absolute z-[100] px-3.5 py-2.5 text-[13px] leading-relaxed rounded-xl shadow-xl
        bg-background
        text-foreground
        border-border border`}
      style={tooltipStyle ?? { maxWidth }}
    >
      {content}
    </div>
  );

  return (
    <div
      ref={wrapperRef}
      className={`relative inline-block ${className}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocusCapture={handleFocusCapture}
      onBlurCapture={handleBlurCapture}
    >
      {children}
      {tooltipElement &&
        (renderInPortal ? createPortal(tooltipElement, document.body) : tooltipElement)}
    </div>
  );
};

export default Tooltip;
