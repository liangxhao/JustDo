// Settings writes and model selection share one transaction order, including rollback.
let updateTail: Promise<unknown> = Promise.resolve();

export function enqueueAppConfigUpdate<T>(update: () => Promise<T>): Promise<T> {
  const result = updateTail.then(update);
  updateTail = result.catch((): undefined => undefined);
  return result;
}
