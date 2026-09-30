// @vitest-environment jsdom

import type { SessionRunTiming } from '@shared/cowork/sessionRun';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { CoworkPet } from './CoworkPet';

vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => key },
}));

const run = (state: SessionRunTiming['state']): SessionRunTiming => ({
  id: 'run-1',
  sessionId: 'session-1',
  clientTurnId: 'turn-1',
  startedAt: 1,
  state,
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete document.documentElement.dataset.coworkPet;
  delete document.documentElement.dataset.coworkPetMotion;
});

describe('CoworkPet', () => {
  test('celebrates a live successful transition once, then returns to idle', () => {
    vi.useFakeTimers();
    const { rerender } = render(<CoworkPet running waiting={false} latestRun={run('running')} />);
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('coworkPetWorking');

    rerender(<CoworkPet running={false} waiting={false} latestRun={run('completed')} />);
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('coworkPetCompleted');
    act(() => vi.advanceTimersByTime(4_000));
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('coworkPetIdle');
  });

  test('does not celebrate an already completed historical run', () => {
    render(<CoworkPet running={false} waiting={false} latestRun={run('completed')} />);
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('coworkPetIdle');
  });

  test('waves while waiting, then returns to work when the question is answered', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <CoworkPet running waiting latestRun={run('running')} />,
    );
    const sprite = container.querySelector('.cowork-pet__sprite') as HTMLElement;
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('coworkPetWaiting');
    expect(sprite.style.backgroundImage).toContain('extra-spritesheet.webp');
    const firstPosition = sprite.style.backgroundPosition;
    act(() => vi.advanceTimersByTime(600));
    expect(sprite.style.backgroundPosition).not.toBe(firstPosition);

    rerender(<CoworkPet running waiting={false} latestRun={run('running')} />);
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('coworkPetWorking');
  });

  test('reacts once to a live failed run without replaying historical failures', () => {
    vi.useFakeTimers();
    const { rerender } = render(<CoworkPet running waiting={false} latestRun={run('running')} />);
    rerender(<CoworkPet running={false} waiting={false} latestRun={run('failed')} />);
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('coworkPetFailed');
    act(() => vi.advanceTimersByTime(3_500));
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('coworkPetIdle');
    rerender(<CoworkPet running={false} waiting={false} latestRun={run('failed')} />);
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('coworkPetIdle');
  });

  test('rests only after a sustained idle interval', () => {
    vi.useFakeTimers();
    render(<CoworkPet running={false} waiting={false} />);
    act(() => vi.advanceTimersByTime(44_000));
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('coworkPetIdle');
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('coworkPetResting');
  });

  test('stops animating when motion is disabled in appearance settings', async () => {
    vi.useFakeTimers();
    const { container } = render(<CoworkPet running waiting={false} latestRun={run('running')} />);
    const sprite = container.querySelector('.cowork-pet__sprite') as HTMLElement;
    document.documentElement.dataset.coworkPetMotion = 'off';
    await act(async () => Promise.resolve());
    const position = sprite.style.backgroundPosition;
    act(() => vi.advanceTimersByTime(2_000));
    expect(sprite.style.backgroundPosition).toBe(position);
  });
});
