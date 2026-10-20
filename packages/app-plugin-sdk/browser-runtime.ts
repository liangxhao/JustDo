import type * as React from 'react';
import type * as ReactDom from 'react-dom';

/** This module is resolved by the independent plugin compiler to the host's live singleton. */
export interface AppBrowserRuntime {
  React: typeof React;
  createPortal: typeof ReactDom.createPortal;
  flushSync: typeof ReactDom.flushSync;
  jsx: typeof import('react/jsx-runtime').jsx;
  jsxs: typeof import('react/jsx-runtime').jsxs;
  /** Matches React's development runtime, including its standard production undefined export. */
  jsxDEV: typeof import('react/jsx-dev-runtime').jsxDEV;
  services: {
    ui: import('./ui').AppUiServices;
    primitives: import('./presentation').AppPrimitives;
    composerStyles: {
      COMPOSER_FRAME_CLASS: string;
      COMPOSER_SURFACE_CLASS: string;
      COMPOSER_TEXTAREA_CLASS: string;
      COMPOSER_TEXTAREA_MAX_HEIGHT: number;
      COMPOSER_TEXTAREA_MIN_HEIGHT: number;
      resizeComposerTextarea(textarea: HTMLTextAreaElement): void;
    };
    rendering: import('./presentation').AppRendering;
  };
}
export const runtime = (globalThis as typeof globalThis & { [key: symbol]: AppBrowserRuntime })[
  Symbol.for('app-plugin.browser-runtime.v1')
];
