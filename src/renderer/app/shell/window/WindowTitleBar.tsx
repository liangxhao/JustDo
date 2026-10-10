import React, { useEffect, useState } from 'react';

import { i18nService } from '@/services/i18n';

interface WindowTitleBarProps {
  controls?: Window['electron']['window'];
  compact?: boolean;
  isOverlayActive?: boolean;
  inline?: boolean;
  className?: string;
}

type WindowState = {
  isMaximized: boolean;
  isFullscreen: boolean;
  isFocused: boolean;
};

const DEFAULT_STATE: WindowState = {
  isMaximized: false,
  isFullscreen: false,
  isFocused: true,
};

const WindowTitleBar: React.FC<WindowTitleBarProps> = ({
  compact = false,
  isOverlayActive = false,
  inline = false,
  className = '',
  controls,
}) => {
  const api = controls ?? window.electron?.window;
  const [state, setState] = useState<WindowState>(DEFAULT_STATE);

  useEffect(() => {
    if (!api) return;
    let disposed = false;
    api
      .isMaximized()
      .then(isMaximized => {
        if (!disposed) {
          setState(prev => ({ ...prev, isMaximized }));
        }
      })
      .catch(error => {
        console.error('Failed to get initial maximize state:', error);
      });

    const unsubscribe = api.onStateChanged(nextState => {
      setState(nextState);
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [api]);

  const handleMinimize = () => {
    api?.minimize();
  };

  const handleToggleMaximize = () => {
    api?.toggleMaximize();
  };

  const handleClose = () => {
    api?.close();
  };

  const handleContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    api?.showSystemMenu({
      x: event.clientX,
      y: event.clientY,
    });
  };

  const handleDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (!state.isFullscreen) {
      handleToggleMaximize();
    }
  };

  if (window.electron?.platform !== 'win32') {
    return null;
  }

  const controlHeightClass = compact ? 'h-7' : 'h-8';
  const controlIconClass = compact ? 'h-3.5 w-3.5' : 'h-4 w-4';
  const containerClassName = inline
    ? `window-controls-floating non-draggable flex ${controlHeightClass} items-center gap-0.5 transition-colors ${!state.isFocused ? 'opacity-70' : 'opacity-100'} ${className}`.trim()
    : `window-controls-floating non-draggable absolute top-0 right-0 z-[55] flex h-full items-center gap-0.5 rounded-bl-xl pl-1 pb-1 pt-0.5 transition-colors ${
        !state.isFocused ? 'opacity-70' : 'opacity-100'
      } ${
        isOverlayActive ? 'bg-transparent' : 'bg-surface/35 backdrop-blur-sm'
      } ${className}`.trim();

  return (
    <div
      className={containerClassName}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
    >
      <button
        type="button"
        onClick={handleMinimize}
        className={`non-draggable ${controlHeightClass} w-8 inline-flex items-center justify-center rounded-lg transition-colors text-secondary hover:hover:bg-surface-raised`}
        aria-label={i18nService.t('windowMinimize')}
        title={i18nService.t('windowMinimize')}
        data-window-control="minimize"
      >
        <svg
          viewBox="0 0 12 12"
          className={controlIconClass}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2 6h8" />
        </svg>
      </button>
      <button
        type="button"
        onClick={handleToggleMaximize}
        className={`non-draggable ${controlHeightClass} w-8 inline-flex items-center justify-center rounded-lg transition-colors text-secondary hover:hover:bg-surface-raised`}
        aria-label={i18nService.t(state.isMaximized ? 'windowRestore' : 'windowMaximize')}
        title={i18nService.t(state.isMaximized ? 'windowRestore' : 'windowMaximize')}
        data-window-control="toggleMaximize"
      >
        {state.isMaximized ? (
          <svg
            viewBox="0 0 12 12"
            className={controlIconClass}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 2h6.5v6.5" />
            <path d="M1.5 4h7v7h-7z" />
          </svg>
        ) : (
          <svg
            viewBox="0 0 12 12"
            className={controlIconClass}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M2 2h8v8H2z" />
          </svg>
        )}
      </button>
      <button
        type="button"
        onClick={handleClose}
        className={`non-draggable ${controlHeightClass} w-8 inline-flex items-center justify-center rounded-lg transition-colors text-secondary hover:bg-red-500 hover:text-white dark:hover:bg-red-500`}
        aria-label={i18nService.t('windowClose')}
        title={i18nService.t('windowClose')}
        data-window-control="close"
      >
        <svg
          viewBox="0 0 12 12"
          className={controlIconClass}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 3l6 6" />
          <path d="M9 3L3 9" />
        </svg>
      </button>
    </div>
  );
};

export default WindowTitleBar;
