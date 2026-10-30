/** Local resources only. Cancellation never establishes a Native execution outcome. */
export interface AppResourceScope {
  readonly signal: AbortSignal;
  defer(dispose: () => void): () => void;
  child(): AppResourceScope;
  setTimeout(callback: () => void, delayMs: number): () => void;
  setInterval(callback: () => void, delayMs: number): () => void;
  listen(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): () => void;
  /** Cooperative work; only the optional result callback is guarded after awaiting. */
  run<T>(
    operation: (signal: AbortSignal) => T | PromiseLike<T>,
    onResult?: (result: T) => void,
  ): () => void;
  dispose(): void;
}

export interface AppResourceScopeOptions {
  signal?: AbortSignal;
  onError?: (error: unknown) => void;
}

/** Process-neutral lifecycle ownership. It grants no application or Native authority. */
export function createResourceScope(options: AppResourceScopeOptions = {}): AppResourceScope {
  const controller = new AbortController();
  const releases = new Set<() => void>();
  let disposed = false;
  const report = (error: unknown) => {
    try {
      if (options.onError) {
        void Promise.resolve(options.onError(error)).catch(() => {
          console.warn('[AppResourceScope] Error observer failed.');
        });
      } else {
        // Do not log task arguments, event payloads, or arbitrary exception text.
        console.warn('[AppResourceScope] Resource callback failed.');
      }
    } catch {
      console.warn('[AppResourceScope] Error observer failed.');
    }
  };
  const observe = (operation: () => unknown) => {
    try {
      void Promise.resolve(operation()).catch(report);
    } catch (error) {
      report(error);
    }
  };
  const defer = (release: () => void): (() => void) => {
    let active = true;
    const once = () => {
      if (!active) return;
      active = false;
      releases.delete(once);
      observe(release);
    };
    if (disposed) once();
    else releases.add(once);
    return once;
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    options.signal?.removeEventListener('abort', dispose);
    controller.abort();
    [...releases].reverse().forEach(release => release());
  };
  const delay = (value: number) => {
    if (!Number.isFinite(value) || value < 0 || value > 2_147_483_647)
      throw new TypeError('Resource timer delay is invalid.');
    return value;
  };
  const scope: AppResourceScope = {
    signal: controller.signal,
    defer,
    child() {
      const child = createResourceScope({ onError: report });
      const release = defer(child.dispose);
      if (!child.signal.aborted) child.signal.addEventListener('abort', release, { once: true });
      return child;
    },
    setTimeout(callback, delayMs) {
      delay(delayMs);
      if (disposed) return () => undefined;
      let active = true;
      const timer = globalThis.setTimeout(() => {
        if (!active || disposed) return;
        release();
        observe(callback);
      }, delayMs);
      const release = defer(() => {
        active = false;
        globalThis.clearTimeout(timer);
      });
      return release;
    },
    setInterval(callback, delayMs) {
      delay(delayMs);
      if (disposed) return () => undefined;
      let active = true;
      const timer = globalThis.setInterval(() => {
        if (active && !disposed) observe(callback);
      }, delayMs);
      return defer(() => {
        active = false;
        globalThis.clearInterval(timer);
      });
    },
    listen(target, type, listener, listenerOptions) {
      const suppliedSignal =
        typeof listenerOptions === 'object' ? listenerOptions.signal : undefined;
      if (disposed || suppliedSignal?.aborted) return () => undefined;
      const capture =
        typeof listenerOptions === 'boolean' ? listenerOptions : listenerOptions?.capture;
      const once = typeof listenerOptions === 'object' && listenerOptions.once;
      let active = true;
      const callback: EventListener = event => {
        if (!active || disposed) return;
        if (once) release();
        observe(() =>
          typeof listener === 'function'
            ? listener.call(target, event)
            : listener.handleEvent(event),
        );
      };
      target.addEventListener(type, callback, listenerOptions);
      const release = defer(() => {
        active = false;
        suppliedSignal?.removeEventListener('abort', release);
        target.removeEventListener(type, callback, capture);
      });
      suppliedSignal?.addEventListener('abort', release, { once: true });
      return release;
    },
    run<T>(operation: (signal: AbortSignal) => T | PromiseLike<T>, onResult?: (result: T) => void) {
      const task = scope.child();
      void Promise.resolve()
        .then(() => {
          if (!task.signal.aborted) return operation(task.signal);
        })
        .then(result => {
          if (!task.signal.aborted) return onResult?.(result as T);
        })
        .catch(error => {
          if (!task.signal.aborted) report(error);
        })
        .finally(task.dispose);
      return task.dispose;
    },
    dispose,
  };
  options.signal?.addEventListener('abort', dispose, { once: true });
  if (options.signal?.aborted) dispose();
  return scope;
}
