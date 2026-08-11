import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';

import AppUpdateToast from './AppUpdateToast';

describe('AppUpdateToast', () => {
  test('renders a compact non-modal update reminder', () => {
    const html = renderToStaticMarkup(
      React.createElement(AppUpdateToast, {
        availableVersion: 'v2026.8.11',
        installing: false,
        installError: false,
        onInstall: vi.fn(),
        onDismiss: vi.fn(),
      }),
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('bottom-4 right-4');
    expect(html).toContain('v2026.8.11');
    expect(html).not.toContain('modal-backdrop');
    expect(html).not.toContain('inset-0');
    expect(html).not.toContain('autofocus');
  });
});
