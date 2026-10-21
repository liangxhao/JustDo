import './WindowHeader.css';

import React, { lazy, Suspense } from 'react';

import WindowTitleBar from './WindowTitleBar';

// Startup chrome must not import the application's Redux/service graph.
const EngineStartupStatusBar = lazy(() => import('@/app/shell/EngineStartupStatusBar'));

/** Shared window chrome, independent of page navigation and scrolling content. */
const WindowHeader: React.FC<{
  controls?: Window['electron']['window'];
  showEngineStatus?: boolean;
}> = ({ controls, showEngineStatus = false }) => (
  <div
    className="window-header draggable flex h-[1.875rem] shrink-0 select-none items-center justify-end gap-3 border-b border-border px-4"
    data-window-header="true"
  >
    {showEngineStatus && (
      <Suspense fallback={null}>
        <EngineStartupStatusBar />
      </Suspense>
    )}
    <WindowTitleBar inline compact controls={controls} className="shrink-0" />
  </div>
);

export default WindowHeader;
