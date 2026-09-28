const pendingOperations = new Map<string, Promise<unknown>>();

/** Order config reconciliation and user selections for the same native session. */
export function enqueueSessionModelOperation<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const result = (pendingOperations.get(key) ?? Promise.resolve())
    .catch((): undefined => undefined)
    .then(operation);
  pendingOperations.set(key, result);
  const clear = () => {
    if (pendingOperations.get(key) === result) pendingOperations.delete(key);
  };
  void result.then(clear, clear);
  return result;
}
