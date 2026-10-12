import {
  COMPUTER_ACTIVITY_LEASE_MS,
  parseComputerActivity,
} from '../../../../shared/security/computerActivity';

export interface ComputerOverlayView {
  show(cursor: boolean, click: boolean): void;
  hide(): void;
}

const SETTLE_MS = 650;
const MAX_ACTIVE = 32;
const MAX_RETIRED = 256;

/** Presentation leases only. Expiration never establishes an execution outcome. */
export class ComputerOverlayController {
  private active = new Map<string, { cursor: boolean; expiresAt: number }>();
  private retired = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private lastSequence = -1;

  constructor(private readonly view: ComputerOverlayView) {}

  receive(payload: unknown, sequence?: number): void {
    const event = parseComputerActivity(payload);
    if (!event) return;
    if (sequence !== undefined) {
      if (!Number.isSafeInteger(sequence) || sequence <= this.lastSequence) return;
      this.lastSequence = sequence;
    }
    if (this.retired.has(event.id)) return;
    if (event.phase === 'start') {
      if (!this.active.has(event.id) && this.active.size >= MAX_ACTIVE) return;
      clearTimeout(this.settleTimer);
      this.settleTimer = undefined;
      this.active.set(event.id, {
        cursor: event.cursor,
        expiresAt: Date.now() + COMPUTER_ACTIVITY_LEASE_MS,
      });
      this.view.show(this.hasCursor(), false);
    } else {
      const previous = this.active.get(event.id);
      this.active.delete(event.id);
      this.retire(event.id);
      if (previous) {
        this.view.show(
          this.hasCursor() || (previous.cursor && event.click),
          previous.cursor && event.click,
        );
        clearTimeout(this.settleTimer);
        if (!this.active.size || (previous.cursor && event.click)) {
          this.settleTimer = setTimeout(() => {
            this.settleTimer = undefined;
            if (this.active.size) this.view.show(this.hasCursor(), false);
            else this.view.hide();
          }, SETTLE_MS);
        }
      }
    }
    this.scheduleExpiry();
  }

  clear(): void {
    clearTimeout(this.timer);
    clearTimeout(this.settleTimer);
    this.timer = undefined;
    this.settleTimer = undefined;
    this.active.clear();
    this.retired.clear();
    this.lastSequence = -1;
    this.view.hide();
  }

  private hasCursor(): boolean {
    return [...this.active.values()].some(value => value.cursor);
  }

  private retire(id: string): void {
    this.retired.add(id);
    if (this.retired.size > MAX_RETIRED) this.retired.delete(this.retired.values().next().value!);
  }

  private scheduleExpiry(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.active.size) return;
    const earliest = Math.min(...[...this.active.values()].map(value => value.expiresAt));
    this.timer = setTimeout(
      () => {
        for (const [id, value] of this.active) {
          if (value.expiresAt <= Date.now()) {
            this.active.delete(id);
            this.retire(id);
          }
        }
        if (this.active.size) this.view.show(this.hasCursor(), false);
        else this.view.hide();
        this.scheduleExpiry();
      },
      Math.max(0, earliest - Date.now()),
    );
    this.timer.unref?.();
  }
}
