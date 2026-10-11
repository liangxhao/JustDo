/** Per-batch FIFO. The caller releases only after dispatch cleanup AND native terminal evidence. */
export class DiscussionPermits {
  private active = 0;
  private failure?: Error;
  private readonly waiting: {
    resolve: (release: () => void) => void;
    reject: (error: unknown) => void;
  }[] = [];
  constructor(
    private readonly capacity: number,
    private readonly signal: AbortSignal,
  ) {
    signal.addEventListener('abort', this.abort, { once: true });
  }
  private abort = () => this.close(new Error('teamDiscussionCancelled'));
  close(error: Error): void {
    this.failure ??= error;
    for (const waiter of this.waiting.splice(0)) waiter.reject(this.failure);
  }
  dispose(): void {
    this.signal.removeEventListener('abort', this.abort);
  }
  assertOpen(): void {
    if (this.signal.aborted) throw new Error('teamDiscussionCancelled');
    if (this.failure) throw this.failure;
  }
  acquire(): Promise<() => void> {
    try {
      this.assertOpen();
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject });
      this.drain();
    });
  }
  private drain(): void {
    while (
      !this.failure &&
      !this.signal.aborted &&
      this.active < this.capacity &&
      this.waiting.length
    ) {
      const waiter = this.waiting.shift()!;
      this.active++;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.active--;
        this.drain();
      });
    }
  }
}
