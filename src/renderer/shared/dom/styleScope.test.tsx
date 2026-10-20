// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import Modal from '@/shared/components/ui/Modal';

import { createStyleScopedPortal, UiStyleScopeBoundary } from './styleScope';

afterEach(cleanup);

test('preserves the original DOM for an unscoped Core surface', () => {
  const view = render(
    <UiStyleScopeBoundary>
      <Modal onClose={vi.fn()} className="core-dialog">
        Core
      </Modal>
    </UiStyleScopeBoundary>,
  );
  expect(view.container.firstElementChild?.getAttribute('data-workspace-overlay')).toBe('true');
  expect(view.container.querySelector('[data-ui-style-scope]')).toBeNull();
});

test('keeps sibling surface markers independent without adding layout boxes', () => {
  render(
    <>
      <UiStyleScopeBoundary scope="first">
        <button>First</button>
      </UiStyleScopeBoundary>
      <UiStyleScopeBoundary scope="second">
        <button>Second</button>
      </UiStyleScopeBoundary>
      <button>Core</button>
    </>,
  );
  for (const [label, scope] of [
    ['First', 'first'],
    ['Second', 'second'],
  ]) {
    const marker = screen
      .getByRole('button', { name: label })
      .closest<HTMLElement>('[data-ui-style-scope]');
    expect(marker?.dataset.uiStyleScope).toBe(scope);
    expect(marker?.style.display).toBe('contents');
  }
  expect(screen.getByRole('button', { name: 'Core' }).closest('[data-ui-style-scope]')).toBeNull();
});

test('inherits the render owner in a portal created outside a component, including modal root classes', () => {
  const iframe = document.createElement('iframe');
  document.body.append(iframe);
  const ownerDocument = iframe.contentDocument!;
  const portal = createStyleScopedPortal(
    <Modal onClose={vi.fn()} className="plugin-dialog" overlayClassName="plugin-backdrop">
      <button>Portal action</button>
    </Modal>,
    ownerDocument.body,
    'stable-portal',
  );
  const view = render(<UiStyleScopeBoundary scope="owner">{portal}</UiStyleScopeBoundary>);
  const action = within(ownerDocument.body).getByRole('button', { name: 'Portal action' });
  expect(action.ownerDocument).toBe(ownerDocument);
  for (const selector of ['.plugin-dialog', '.plugin-backdrop']) {
    expect(
      ownerDocument.querySelector(selector)?.closest<HTMLElement>('[data-ui-style-scope]')?.dataset
        .uiStyleScope,
    ).toBe('owner');
  }
  expect(document.querySelector('.plugin-dialog')).toBeNull();
  view.unmount();
  expect(ownerDocument.querySelector('[data-ui-style-scope]')).toBeNull();
  iframe.remove();
});
