import './WindowHeader.css';

import React from 'react';

import WindowTitleBar from './WindowTitleBar';

/** Shared window chrome, independent of page navigation and scrolling content. */
const WindowHeader: React.FC<{ controls?: Window['electron']['window'] }> = ({ controls }) => (
  <div
    className="window-header draggable flex h-[1.875rem] shrink-0 select-none items-center justify-end border-b border-border px-4"
    data-window-header="true"
  >
    <WindowTitleBar inline compact controls={controls} />
  </div>
);

export default WindowHeader;
