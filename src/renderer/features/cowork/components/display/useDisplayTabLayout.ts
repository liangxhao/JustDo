import { type RefObject, useCallback, useLayoutEffect, useRef, useState } from 'react';

const DISPLAY_TAB_MIN_WIDTH = 88;
const DISPLAY_TAB_MAX_WIDTH = 192;
const DISPLAY_TAB_LIST_BUTTON_WIDTH = 32;

interface DisplayTabLayoutOptions {
  hasActions: boolean;
  activeTabId: string;
  isOpen: boolean;
  isWorkspaceFullscreen: boolean;
  tabCount: number;
  tabButtonRefs: RefObject<Map<string, HTMLButtonElement>>;
  width: number;
  ownerWindow: Window & typeof globalThis;
}

export default function useDisplayTabLayout({
  hasActions,
  activeTabId,
  isOpen,
  isWorkspaceFullscreen,
  tabCount,
  tabButtonRefs,
  width,
  ownerWindow,
}: DisplayTabLayoutOptions) {
  const clusterRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState({ tabWidth: DISPLAY_TAB_MAX_WIDTH, hasOverflow: false });

  const revealTab = useCallback(
    (tabId: string) => {
      const scroller = scrollerRef.current;
      const tab = tabButtonRefs.current?.get(tabId)?.parentElement;
      if (!scroller || !tab || scroller.clientWidth <= 0) return;
      const viewport = scroller.getBoundingClientRect();
      const bounds = tab.getBoundingClientRect();
      const delta =
        bounds.left < viewport.left
          ? bounds.left - viewport.left
          : bounds.right > viewport.right
            ? bounds.right - viewport.right
            : 0;
      if (delta) {
        scroller.scrollLeft = Math.max(
          0,
          Math.min(scroller.scrollLeft + delta, scroller.scrollWidth - scroller.clientWidth),
        );
      }
    },
    [tabButtonRefs],
  );

  useLayoutEffect(() => {
    const cluster = clusterRef.current;
    if (!cluster || !isOpen || !tabCount) return;
    let frame = 0;
    const measure = () => {
      if (cluster.clientWidth <= 0) return;
      const availableWidth = Math.max(
        0,
        cluster.clientWidth - (actionsRef.current?.getBoundingClientRect().width ?? 0),
      );
      // Decide before reserving the list button so it cannot cause its own overflow.
      const hasOverflow = tabCount * DISPLAY_TAB_MIN_WIDTH > availableWidth;
      const tabWidth = Math.min(
        DISPLAY_TAB_MAX_WIDTH,
        Math.max(
          DISPLAY_TAB_MIN_WIDTH,
          Math.floor(
            (availableWidth - (hasOverflow ? DISPLAY_TAB_LIST_BUTTON_WIDTH : 0)) / tabCount,
          ),
        ),
      );
      setLayout(current =>
        current.tabWidth === tabWidth && current.hasOverflow === hasOverflow
          ? current
          : { tabWidth, hasOverflow },
      );
      ownerWindow.cancelAnimationFrame(frame);
      frame = ownerWindow.requestAnimationFrame(() => revealTab(activeTabId));
    };
    measure();
    const observer = ownerWindow.ResizeObserver ? new ownerWindow.ResizeObserver(measure) : null;
    observer?.observe(cluster);
    if (actionsRef.current) observer?.observe(actionsRef.current);
    ownerWindow.addEventListener('resize', measure);
    return () => {
      ownerWindow.cancelAnimationFrame(frame);
      observer?.disconnect();
      ownerWindow.removeEventListener('resize', measure);
    };
  }, [
    activeTabId,
    hasActions,
    isOpen,
    isWorkspaceFullscreen,
    ownerWindow,
    revealTab,
    tabCount,
    width,
  ]);

  useLayoutEffect(() => {
    if (isOpen) revealTab(activeTabId);
  }, [activeTabId, isOpen, layout, revealTab, tabCount]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !isOpen || !layout.hasOverflow) return;
    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.deltaX || !event.deltaY) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientWidth : 1;
      const previousOffset = scroller.scrollLeft;
      scroller.scrollLeft = Math.max(
        0,
        Math.min(previousOffset + event.deltaY * unit, scroller.scrollWidth - scroller.clientWidth),
      );
      if (scroller.scrollLeft !== previousOffset) event.preventDefault();
    };
    scroller.addEventListener('wheel', handleWheel, { passive: false });
    return () => scroller.removeEventListener('wheel', handleWheel);
  }, [isOpen, layout.hasOverflow]);

  return { clusterRef, scrollerRef, actionsRef, revealTab, ...layout };
}
