export class LatestSerialTaskQueue {
  private tail: Promise<void> = Promise.resolve();
  private latestTaskId = 0;

  enqueue<T>(task: () => Promise<T>): { taskId: number; completion: Promise<T> } {
    const taskId = ++this.latestTaskId;
    const completion = this.tail.then(task);
    this.tail = completion.then(
      () => undefined,
      () => undefined,
    );
    return { taskId, completion };
  }

  invalidate(): void {
    this.latestTaskId += 1;
  }

  isLatest(taskId: number): boolean {
    return taskId === this.latestTaskId;
  }
}
