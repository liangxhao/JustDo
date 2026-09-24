// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import PluginStateButton, { PluginLockedIndicator } from './PluginStateButton';

describe('PluginStateButton', () => {
  afterEach(cleanup);

  test('keeps switch semantics while using a compact status symbol', () => {
    const onToggle = vi.fn();
    render(<PluginStateButton checked label="Disable plugin" onToggle={onToggle} />);

    const control = screen.getByRole('switch', { name: 'Disable plugin' });
    expect(control.getAttribute('aria-checked')).toBe('true');
    expect(control.className).toContain('text-emerald-600');
    expect(control.className).not.toContain('bg-emerald');
    fireEvent.click(control);
    expect(onToggle).toHaveBeenCalledOnce();
  });

  test('uses a distinct warm color for the disabled state', () => {
    render(<PluginStateButton checked={false} label="Enable plugin" onToggle={vi.fn()} />);

    expect(screen.getByRole('switch', { name: 'Enable plugin' }).className).toContain(
      'text-amber-600',
    );
    expect(screen.getByRole('switch', { name: 'Enable plugin' }).className).not.toContain(
      'bg-amber',
    );
  });

  test('dims a disabled checked state and blocks interaction', () => {
    const onToggle = vi.fn();
    render(<PluginStateButton checked disabled label="Disable plugin" onToggle={onToggle} />);

    const control = screen.getByRole('switch', { name: 'Disable plugin' });
    expect(control.className).toContain('opacity-40');
    fireEvent.click(control);
    expect(onToggle).not.toHaveBeenCalled();
  });

  test('dismisses the tooltip after toggling and moving the pointer away', async () => {
    render(<PluginStateButton checked={false} label="Enable plugin" onToggle={vi.fn()} />);

    const control = screen.getByRole('switch', { name: 'Enable plugin' });
    fireEvent.mouseEnter(control);
    control.focus();
    await waitFor(() => {
      expect(screen.getByRole('tooltip')).not.toBeNull();
    });

    fireEvent.mouseUp(control);
    fireEvent.click(control);
    fireEvent.mouseLeave(control);

    expect(document.activeElement).not.toBe(control);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  test('aligns the locked indicator and exposes its explanation on hover', async () => {
    render(<PluginLockedIndicator label="Managed plugin" />);

    const indicator = screen.getByRole('img', { name: 'Managed plugin' });
    expect(indicator.className).toContain('h-6');
    expect(indicator.className).toContain('w-6');
    expect(indicator.className).toContain('items-center');
    expect(indicator.className).toContain('justify-center');
    expect(indicator.parentElement?.className).toContain('pointer-events-auto');

    fireEvent.mouseEnter(indicator);
    await waitFor(() => {
      expect(screen.getByRole('tooltip').textContent).toBe('Managed plugin');
    });
  });
});
