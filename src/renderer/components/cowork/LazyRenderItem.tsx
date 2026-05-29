import React, { useEffect,useRef, useState } from 'react';

/**
 * LazyRenderItem — Viewport-based lazy rendering wrapper for transcript items.
 *
 * Renders a lightweight placeholder when the item is far from the viewport,
 * and renders the actual content when it enters (or is near) the viewport.
 * Once rendered, keeps a cached height so the placeholder matches the real size.
 *
 * This dramatically reduces DOM node count and React reconciliation work
 * for long conversations.
 */

interface LazyRenderItemProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Unique key for height cache */
  itemId: string;
  /** Vertical margin around viewport to pre-render (px) */
  rootMargin?: number;
  /** Whether this item should always be rendered, e.g. the latest streaming item. */
  alwaysRender?: boolean;
  children: React.ReactNode;
}

// Global height cache survives re-renders and is keyed by transcript item id.
const heightCache = new Map<string, number>();

const LazyRenderItem: React.FC<LazyRenderItemProps> = ({
  itemId,
  rootMargin = 600,
  alwaysRender = false,
  children,
  style,
  ...restProps
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(alwaysRender);
  const hasRenderedRef = useRef(false);

  // Observe intersection
  useEffect(() => {
    if (alwaysRender) {
      setIsVisible(true);
      return;
    }

    const el = containerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        const nowVisible = entry.isIntersecting;
        setIsVisible(nowVisible);
        if (nowVisible) {
          hasRenderedRef.current = true;
        }
      },
      {
        rootMargin: `${rootMargin}px 0px ${rootMargin}px 0px`,
      },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [alwaysRender, rootMargin]);

  // Cache height when visible content is rendered
  useEffect(() => {
    if (!isVisible) return;
    const el = containerRef.current;
    if (!el) return;

    const ro = new ResizeObserver(([entry]) => {
      const h = entry.contentRect.height;
      if (h > 0) {
        heightCache.set(itemId, h);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [isVisible, itemId]);

  const shouldRender = isVisible || alwaysRender;
  const cachedHeight = heightCache.get(itemId);

  return (
    <div
      ref={containerRef}
      {...restProps}
      style={{
        ...style,
        ...(!shouldRender && cachedHeight
          ? { height: cachedHeight, minHeight: cachedHeight }
          : undefined),
      }}
    >
      {shouldRender ? children : (
        <div
          style={{ height: cachedHeight || 80 }}
          className="bg-background"
        />
      )}
    </div>
  );
};

export default LazyRenderItem;

/** Clear all cached heights (e.g. when switching sessions) */
export const clearHeightCache = () => heightCache.clear();
