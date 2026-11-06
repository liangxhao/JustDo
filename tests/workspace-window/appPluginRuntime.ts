// Workspace DOM transfer uses host primitives without optional plugin sources.
import React from 'react';
import { createPortal, flushSync } from 'react-dom';

import { appJsxRuntime } from '@/features/plugins/app/jsxRuntime';
import { i18nService } from '@/services/i18n';
import { useOwnerWindow } from '@/shared/dom/ownerDocument';
export const runtime = {
  React,
  createPortal,
  flushSync,
  ...appJsxRuntime,
  services: {
    ui: { i18n: i18nService, useOwnerWindow },
    primitives: {},
    composerStyles: {},
    rendering: {},
  },
};
