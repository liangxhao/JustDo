// @vitest-environment jsdom

import type { SessionRunTiming } from '@shared/cowork/sessionRun';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { CoworkPet } from './CoworkPet';

vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => key },
}));
vi.mock('@/services/config', () => ({
  configService: {
    getConfig: () => ({ appearance: {} }),
    updateConfig: vi.fn().mockResolvedValue(undefined),
  },
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
  vi.restoreAllMocks();
  delete document.documentElement.dataset.coworkPet;
  delete document.documentElement.dataset.coworkPetMotion;
  delete document.documentElement.dataset.coworkPetHome;
  delete document.documentElement.dataset.coworkPetChat;
  delete document.documentElement.dataset.coworkPetVariety;
  delete document.documentElement.dataset.coworkPetSpeed;
  delete document.documentElement.dataset.coworkPetRestAfter;
  delete document.documentElement.dataset.coworkPetFloating;
  delete document.documentElement.dataset.coworkPetCats;
  window.localStorage.clear();
});

describe('CoworkPet', () => {
  test('starts an inline drag from the right-aligned pet rather than the row left edge', () => {
    render(<CoworkPet running={false} waiting={false} />);
    const pet = screen.getByRole('status');
    vi.spyOn(pet, 'getBoundingClientRect').mockReturnValue({
      x: 100, y: 100, left: 100, top: 100, right: 650, bottom: 148,
      width: 550, height: 48, toJSON: () => ({}),
    });
    fireEvent.pointerDown(pet, { button: 0, pointerId: 7, clientX: 600, clientY: 110 });
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 640, clientY: 150 });
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 640, clientY: 150 });
    expect(JSON.parse(window.localStorage.getItem('justdo-pet-floating-position')!)).toEqual({ x: 626, y: 132 });
  });

  test.each(['pointercancel', 'blur'])('cancels a drag on %s without saving a new position', eventName => {
    render(<CoworkPet running={false} waiting={false} />);
    fireEvent.pointerDown(screen.getByRole('status'), { button: 0, pointerId: 8, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(window, { pointerId: 8, clientX: 120, clientY: 100 });
    if (eventName === 'pointercancel') fireEvent.pointerCancel(window, { pointerId: 8 });
    else fireEvent.blur(window);
    expect(screen.getByRole('status').classList.contains('cowork-pet--floating')).toBe(false);
    expect(window.localStorage.getItem('justdo-pet-floating-position')).toBeNull();
    expect(document.documentElement.dataset.coworkPetFloating).not.toBe('on');
  });

  test('supports keyboard single and double interaction feedback', () => {
    render(<CoworkPet running={false} waiting={false} />);
    const button = screen.getByRole('button', { name: 'coworkPetInteract' });
    fireEvent.keyDown(button, { key: 'Enter' });
    expect(screen.getByRole('status').classList.contains('cowork-pet--tap')).toBe(true);
    fireEvent.keyDown(button, { key: ' ', shiftKey: true });
    expect(screen.getByRole('status').classList.contains('cowork-pet--double')).toBe(true);
  });

  test('responds to a single click then returns to the working animation', () => {
    vi.useFakeTimers();
    render(<CoworkPet running waiting={false} />);
    fireEvent.click(screen.getByRole('status'));
    act(() => vi.advanceTimersByTime(260));
    expect(screen.getByRole('status').classList.contains('cowork-pet--tap')).toBe(true);
    act(() => vi.advanceTimersByTime(1_500));
    expect(screen.getByRole('status').classList.contains('cowork-pet--tap')).toBe(false);
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('coworkPetWorking');
  });

  test('double clicking replaces a pending single click with a distinct response', () => {
    vi.useFakeTimers();
    render(<CoworkPet running={false} waiting={false} />);
    const pet = screen.getByRole('status');
    fireEvent.click(pet);
    fireEvent.click(pet);
    fireEvent.doubleClick(pet);
    expect(pet.classList.contains('cowork-pet--double')).toBe(true);
    act(() => vi.advanceTimersByTime(300));
    expect(pet.classList.contains('cowork-pet--tap')).toBe(false);
    act(() => vi.advanceTimersByTime(2_000));
    expect(pet.classList.contains('cowork-pet--double')).toBe(false);
  });

  test('does not respond to the click generated after dragging', () => {
    vi.useFakeTimers();
    render(<CoworkPet running={false} waiting={false} />);
    const pet = screen.getByRole('status');
    fireEvent.pointerDown(pet, { button: 0, pointerId: 3, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(window, { pointerId: 3, clientX: 120, clientY: 100 });
    fireEvent.pointerUp(window, { pointerId: 3, clientX: 120, clientY: 100 });
    fireEvent.click(screen.getByRole('status'));
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByRole('status').classList.contains('cowork-pet--tap')).toBe(false);
  });

  test('chooses a different feedback for consecutive clicks of the same kind', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    render(<CoworkPet running={false} waiting={false} />);
    const pet = screen.getByRole('status');
    fireEvent.doubleClick(pet);
    expect(pet.classList.contains('cowork-pet--feedback-hop')).toBe(true);
    act(() => vi.advanceTimersByTime(1_500));
    fireEvent.doubleClick(pet);
    expect(pet.classList.contains('cowork-pet--feedback-wiggle')).toBe(true);
    expect(pet.classList.contains('cowork-pet--feedback-hop')).toBe(false);
  });

  test.each(['white', 'black', 'both'])('plays the new sprite frames for %s cats and resumes idle afterward', cats => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.4);
    document.documentElement.dataset.coworkPetCats = cats;
    const { container } = render(<CoworkPet running={false} waiting={false} />);
    fireEvent.click(screen.getByRole('status'));
    act(() => vi.advanceTimersByTime(260));
    const sprite = container.querySelector('.cowork-pet__sprite') as HTMLElement;
    expect(sprite.style.backgroundImage).toContain('interaction-spritesheet.webp');
    const firstPosition = sprite.style.backgroundPosition;
    act(() => vi.advanceTimersByTime(200));
    expect(sprite.style.backgroundPosition).not.toBe(firstPosition);
    act(() => vi.advanceTimersByTime(1_500));
    expect(sprite.style.backgroundImage).not.toContain('interaction-spritesheet.webp');
    expect(screen.getByRole('status').classList.contains('cowork-pet--tap')).toBe(false);
  });

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

  test('stays awake when resting is disabled', () => {
    vi.useFakeTimers();
    document.documentElement.dataset.coworkPetRestAfter = 'never';
    render(<CoworkPet running={false} waiting={false} />);
    act(() => vi.advanceTimersByTime(120_000));
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('coworkPetIdle');
  });

  test('plays a different idle rhythm on the next loop', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { container } = render(<CoworkPet running={false} waiting={false} />);
    const sprite = container.querySelector('.cowork-pet__sprite') as HTMLElement;
    const initialPosition = sprite.style.backgroundPosition;

    act(() => vi.advanceTimersByTime(6_500));
    expect(sprite.style.backgroundPosition).not.toBe(initialPosition);

    act(() => vi.advanceTimersByTime(300));
    expect(sprite.style.backgroundPosition).toBe(initialPosition);
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

  test('dragging from the inline position floats the pet and remembers its location', () => {
    const { container, unmount } = render(<CoworkPet running={false} waiting={false} />);
    const pet = container.querySelector('.cowork-pet') as HTMLElement;

    fireEvent.pointerDown(pet, { button: 0, pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 120, clientY: 100 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 120, clientY: 100 });

    expect(document.body.querySelector('.cowork-pet--floating')).not.toBeNull();
    expect(document.documentElement.dataset.coworkPetFloating).toBe('on');
    expect(window.localStorage.getItem('justdo-pet-floating-position')).not.toBeNull();
    const left = (document.body.querySelector('.cowork-pet--floating') as HTMLElement).style.left;

    unmount();
    render(<CoworkPet running={false} waiting={false} />);
    expect((document.body.querySelector('.cowork-pet--floating') as HTMLElement).style.left).toBe(left);
  });

  test('keeps the same sprite size on home and chat before and after dragging', () => {
    const { container } = render(<CoworkPet running={false} waiting={false} placement="home" />);
    const pet = container.querySelector('.cowork-pet') as HTMLElement;
    expect((pet.querySelector('.cowork-pet__sprite') as HTMLElement).style.backgroundSize).toBe('384px 256px');

    fireEvent.pointerDown(pet, { button: 0, pointerId: 2, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 120, clientY: 100 });
    fireEvent.pointerUp(window, { pointerId: 2, clientX: 120, clientY: 100 });

    const floated = document.body.querySelector('.cowork-pet--floating .cowork-pet__sprite') as HTMLElement;
    expect(floated.style.backgroundSize).toBe('384px 256px');
  });

  test('switches between white cat, black cat, and both cats immediately', async () => {
    document.documentElement.dataset.coworkPetCats = 'white';
    const { container } = render(<CoworkPet running={false} waiting={false} />);
    const sprite = container.querySelector('.cowork-pet__sprite') as HTMLElement;
    expect(sprite.classList.contains('cowork-pet__sprite--white')).toBe(true);

    document.documentElement.dataset.coworkPetCats = 'black';
    await act(async () => Promise.resolve());
    expect(sprite.classList.contains('cowork-pet__sprite--black')).toBe(true);

    document.documentElement.dataset.coworkPetCats = 'both';
    await act(async () => Promise.resolve());
    expect(sprite.className).toBe('cowork-pet__sprite');
  });

  test('uses a solo completion motion instead of a clipped high five', () => {
    document.documentElement.dataset.coworkPetCats = 'white';
    const { rerender } = render(<CoworkPet running waiting={false} latestRun={run('running')} />);
    rerender(<CoworkPet running={false} waiting={false} latestRun={run('completed')} />);
    expect(screen.getByRole('status').classList.contains('cowork-pet--solo-complete')).toBe(true);
  });
});
