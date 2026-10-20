import './WindowHeader.css';

import React from 'react';

import EngineStartupStatusBar from '@/app/shell/EngineStartupStatusBar';

import WindowTitleBar from './WindowTitleBar';

/** Shared window chrome, independent of page navigation and scrolling content. */
const WindowHeader: React.FC<{
  controls?: Window['electron']['window'];
  showEngineStatus?: boolean;
}> = ({ controls, showEngineStatus = false }) => (
  <div
    className="window-header draggable flex h-[1.875rem] shrink-0 select-none items-center justify-end gap-3 border-b border-border px-4"
    data-window-header="true"
  >
    {showEngineStatus && <EngineStartupStatusBar />}
    <WindowTitleBar inline compact controls={controls} className="shrink-0" />
  </div>
);

export default WindowHeader;
