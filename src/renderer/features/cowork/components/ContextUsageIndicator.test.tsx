// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ContextUsageIndicator from './ContextUsageIndicator';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ContextUsageIndicator', () => {
  it('keeps context details hidden until the indicator is hovered', async () => {
    vi.useFakeTimers();
    render(
      <ContextUsageIndicator
        label="Context used / total context"
        detail="32k / 200k · 16%"
        percentage={16}
      />,
    );

    const indicator = screen.getByRole('img', {
      name: 'Context used / total context: 32k / 200k · 16%',
    });
    expect(screen.queryByText('32k / 200k · 16%')).toBeNull();

    fireEvent.mouseEnter(indicator.parentElement!);
    await vi.advanceTimersByTimeAsync(300);

    expect(screen.getByText('32k / 200k · 16%').parentElement).toBe(document.body);
  });

  it('shows context details when the indicator receives keyboard focus', async () => {
    vi.useFakeTimers();
    render(
      <ContextUsageIndicator
        label="Context used / total context"
        detail="32k / 200k · 16%"
        percentage={16}
      />,
    );

    const indicator = screen.getByRole('img');
    fireEvent.focus(indicator);
    await vi.advanceTimersByTimeAsync(300);

    expect(screen.getByRole('tooltip').textContent).toBe('32k / 200k · 16%');

    fireEvent.blur(indicator);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('keeps the tooltip visible while either hover or focus remains active', async () => {
    vi.useFakeTimers();
    render(
      <ContextUsageIndicator
        label="Context used / total context"
        detail="32k / 200k · 16%"
        percentage={16}
      />,
    );

    const indicator = screen.getByRole('img');
    const tooltipTrigger = indicator.parentElement!;
    fireEvent.mouseEnter(tooltipTrigger);
    fireEvent.focus(indicator);
    await vi.advanceTimersByTimeAsync(300);

    fireEvent.mouseLeave(tooltipTrigger);
    expect(screen.queryByRole('tooltip')).not.toBeNull();

    fireEvent.blur(indicator);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('cancels delayed display after hover and focus both end', async () => {
    vi.useFakeTimers();
    render(
      <ContextUsageIndicator
        label="Context used / total context"
        detail="32k / 200k · 16%"
        percentage={16}
      />,
    );

    const indicator = screen.getByRole('img');
    const tooltipTrigger = indicator.parentElement!;
    fireEvent.mouseEnter(tooltipTrigger);
    fireEvent.focus(indicator);
    fireEvent.mouseLeave(tooltipTrigger);
    fireEvent.blur(indicator);
    await vi.advanceTimersByTimeAsync(300);

    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it.each([
    [125, '100 100'],
    [-10, '0 100'],
    [Number.NaN, '0 100'],
  ])('normalizes a %s ring percentage', (percentage, expectedDasharray) => {
    const { container } = render(
      <ContextUsageIndicator
        label="Context usage"
        detail="Context usage detail"
        percentage={percentage}
      />,
    );

    expect(container.querySelectorAll('circle')[1]?.getAttribute('stroke-dasharray')).toBe(
      expectedDasharray,
    );
  });
});
