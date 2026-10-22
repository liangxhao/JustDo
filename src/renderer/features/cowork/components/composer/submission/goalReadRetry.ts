/** Retry failed Goal reads; a successful read returns ownership to native events. */
export function createGoalReadRetry(retry: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = 1_500;
  let disposed = false;
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return {
    failed() {
      if (disposed) return;
      clear();
      timer = setTimeout(() => {
        timer = undefined;
        if (!disposed) retry();
      }, delay);
      delay = Math.min(delay * 2, 30_000);
    },
    succeeded() {
      clear();
      delay = 1_500;
    },
    dispose() {
      disposed = true;
      clear();
    },
  };
}
