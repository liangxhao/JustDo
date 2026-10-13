import {
  COMPUTER_ACTIVITY_LEASE_MS,
  parseComputerActivity,
} from '../../../../shared/security/computerActivity';

export type ComputerOverlayPresentation = {
  waiting: boolean;
  hold: boolean;
  capture: boolean;
};

export interface ComputerOverlayView {
  show(cursor: boolean, click: boolean, presentation: ComputerOverlayPresentation): void;
  hide(animate?: boolean): void;
}

const FEEDBACK_MS = 4_000;
const IDLE_MS = 12_000;
const MAX_ACTIVE = 32;
const MAX_RETIRED = 256;

/** Visual idle deadlines are independent of native execution ownership. */
export class ComputerOverlayController {
  private active = new Map<string, { execution: string; cursor: boolean; expiresAt: number }>();
  private idle = new Map<string, number>();
  private retired = new Set<string>();
  private closed = new Set<string>();
  private feedback: { execution: string; until: number } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastSequence = -1;

  constructor(private readonly view: ComputerOverlayView) {}

  receive(payload: unknown, sequence?: number): void {
    const event = parseComputerActivity(payload);
    if (!event) return;
    if (sequence !== undefined) {
      if (!Number.isSafeInteger(sequence) || sequence <= this.lastSequence) return;
      this.lastSequence = sequence;
    }
    if (this.closed.has(event.execution)) return;
    if (event.phase === 'close') {
      this.remember(this.closed, event.execution);
      for (const [id, value] of this.active) {
        if (value.execution === event.execution) {
          this.active.delete(id);
          this.remember(this.retired, id);
        }
      }
      this.idle.delete(event.execution);
      if (this.feedback?.execution === event.execution) this.feedback = undefined;
      this.render();
      this.schedule();
      return;
    }
    if (this.retired.has(event.id)) return;
    const previous = this.active.get(event.id);
    if (previous && previous.execution !== event.execution) return;
    if (event.phase === 'start') {
      if (!previous && this.active.size >= MAX_ACTIVE) return;
      this.idle.delete(event.execution);
      this.active.set(event.id, {
        execution: event.execution,
        cursor: event.cursor,
        expiresAt: Date.now() + COMPUTER_ACTIVITY_LEASE_MS,
      });
      if (event.cursor) this.feedback = undefined;
      this.render();
    } else {
      this.active.delete(event.id);
      this.remember(this.retired, event.id);
      if (!previous) return;
      this.idle.set(event.execution, Date.now() + IDLE_MS);
      if (this.idle.size > MAX_ACTIVE) this.idle.delete(this.idle.keys().next().value!);
      if (previous.cursor)
        this.feedback = { execution: event.execution, until: Date.now() + FEEDBACK_MS };
      this.render(previous.cursor && event.click, previous.cursor);
    }
    this.schedule();
  }

  clear(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.active.clear();
    this.idle.clear();
    this.retired.clear();
    this.closed.clear();
    this.feedback = undefined;
    this.lastSequence = -1;
    this.view.hide();
  }

  private render(click = false, capture = false): void {
    if (!this.active.size && !this.idle.size) {
      this.view.hide(true);
      return;
    }
    const live = [...this.active.values()].some(value => value.cursor);
    this.view.show(live || !!this.feedback, click, {
      waiting: !this.active.size,
      hold: !live,
      capture,
    });
  }

  private remember(values: Set<string>, id: string): void {
    values.add(id);
    if (values.size > MAX_RETIRED) values.delete(values.values().next().value!);
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const deadlines = [
      ...[...this.active.values()].map(value => value.expiresAt),
      ...this.idle.values(),
      ...(this.feedback ? [this.feedback.until] : []),
    ];
    if (!deadlines.length) return;
    this.timer = setTimeout(
      () => {
        const now = Date.now();
        for (const [id, value] of this.active) {
          if (value.expiresAt <= now) {
            this.active.delete(id);
            this.remember(this.retired, id);
          }
        }
        for (const [id, deadline] of this.idle) if (deadline <= now) this.idle.delete(id);
        if (this.feedback && this.feedback.until <= now) this.feedback = undefined;
        this.render();
        this.schedule();
      },
      Math.max(0, Math.min(...deadlines) - Date.now()),
    );
    this.timer.unref?.();
  }
}
