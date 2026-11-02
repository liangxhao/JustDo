// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

import PluginActivityStatus from './PluginActivityStatus';
import { getPluginOperationOwner } from './pluginOperationService';
import {
  PluginOperationStatusContent,
  PluginOperationStatusSlot,
} from './PluginOperationStatusSlot';

afterEach(cleanup);

test('shares and releases one standalone progress host without creating a native operation', () => {
  const bridge = {};
  Object.defineProperty(window, 'electron', { configurable: true, value: bridge });
  const refresh = vi.fn();
  function Activities({ loading }: { loading: boolean }) {
    return (
      <StrictMode>
        {loading && <PluginActivityStatus message="Loading extensions" />}
        <PluginOperationStatusContent>
          <button onClick={refresh}>Refresh known installation</button>
        </PluginOperationStatusContent>
      </StrictMode>
    );
  }
  const view = render(<Activities loading />);
  const host = screen.getByText('Loading extensions').closest('.fixed')!;
  const button = screen.getByRole('button', { name: 'Refresh known installation' });
  expect(button.closest('.fixed')).toBe(host);
  expect(host.classList.contains('bottom-4')).toBe(true);
  expect(host.classList.contains('right-4')).toBe(true);
  expect(view.container.textContent).toBe('');
  expect(getPluginOperationOwner(bridge).snapshot()).toEqual([]);
  fireEvent.click(button);
  expect(refresh).toHaveBeenCalledOnce();

  view.rerender(<Activities loading={false} />);
  expect(screen.queryByText('Loading extensions')).toBeNull();
  expect(button.closest('.fixed')).toBe(host);
  expect(host.isConnected).toBe(true);
  view.unmount();
  expect(host.isConnected).toBe(false);
});

test('waits for the supplied slot instead of creating a second progress root', () => {
  const notice = <PluginActivityStatus message="Waiting for the engine" />;
  const view = render(
    <PluginOperationStatusSlot.Provider value={null}>{notice}</PluginOperationStatusSlot.Provider>,
  );
  expect(screen.queryByText('Waiting for the engine')).toBeNull();
  expect(document.body.querySelector('.fixed.bottom-4.right-4')).toBeNull();

  const slot = document.createElement('div');
  document.body.append(slot);
  view.rerender(
    <PluginOperationStatusSlot.Provider value={slot}>{notice}</PluginOperationStatusSlot.Provider>,
  );
  expect(slot.textContent).toBe('Waiting for the engine');
  expect(document.body.querySelector('.fixed.bottom-4.right-4')).toBeNull();
  view.unmount();
  expect(slot.textContent).toBe('');
  slot.remove();
});
