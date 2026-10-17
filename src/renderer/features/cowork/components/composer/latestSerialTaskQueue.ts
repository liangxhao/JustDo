export class LatestSerialTaskQueue {
  private tail: Promise<void> = Promise.resolve();
  private latestTaskId = 0;
  private readonly pendingTaskIds = new Map<string, number>();

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
  enqueueLatest<T>(key: string, task: () => Promise<T>) {
    const { taskId, completion } = this.enqueue(async () => {
      if (this.pendingTaskIds.get(key) !== taskId) return undefined;
      this.pendingTaskIds.delete(key);
      return task();
    });
    this.pendingTaskIds.set(key, taskId);
    return { taskId, completion };
  }

  invalidate(): void {
    this.latestTaskId += 1;
  }

  isLatest(taskId: number): boolean {
    return taskId === this.latestTaskId;
  }
}
