export class LatestSerialTaskQueue {
  private tail: Promise<void> = Promise.resolve();
  private latestTaskId = 0;
  private readonly pendingTaskIds = new Map<string, number>();
  private readonly contextTails = new Map<string, Promise<void>>();
  private readonly latestScopeTaskIds = new Map<string, number>();

  enqueue<T>(task: () => Promise<T>): { taskId: number; completion: Promise<T> } {
    const taskId = ++this.latestTaskId;
    const completion = this.tail.then(task);
    this.tail = completion.then(
      () => undefined,
      () => undefined,
    );
    return { taskId, completion };
  }

  /** Replace only work that has not started for this selection context. */
  enqueueLatest<T>(key: string, task: () => Promise<T>, scope = key) {
    const taskId = ++this.latestTaskId;
    const completion = (this.contextTails.get(key) ?? Promise.resolve()).then(async () => {
      if (this.pendingTaskIds.get(key) !== taskId) return undefined;
      this.pendingTaskIds.delete(key);
      return task();
    });
    const tail = completion.then(
      () => undefined,
      () => undefined,
    );
    this.contextTails.set(key, tail);
    void tail.then(() => {
      if (this.contextTails.get(key) === tail) this.contextTails.delete(key);
    });
    this.pendingTaskIds.set(key, taskId);
    this.latestScopeTaskIds.set(scope, taskId);
    return { taskId, completion };
  }

  invalidate(): void {
    this.latestTaskId += 1;
    this.latestScopeTaskIds.clear();
  }

  isLatest(taskId: number): boolean {
    return taskId === this.latestTaskId;
  }

  isLatestInScope(scope: string, taskId: number): boolean {
    return this.latestScopeTaskIds.get(scope) === taskId;
  }
}
