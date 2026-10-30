const runtimeKey = Symbol.for('app-plugin.browser-runtime.v1');
let active;

/** Install caller-supplied public SDK ports; this does not emulate host behavior. */
export function installBrowserRuntime(runtime) {
  if (!runtime || typeof runtime !== 'object' || !runtime.React || !runtime.services)
    throw new Error('A complete public browser runtime fixture is required');
  const previous = Object.getOwnPropertyDescriptor(globalThis, runtimeKey);
  const lease = {
    runtime,
    previous,
    parent: active?.runtime === previous?.value ? active : undefined,
    live: true,
  };
  active = lease;
  Object.defineProperty(globalThis, runtimeKey, {
    configurable: true,
    writable: true,
    value: runtime,
  });
  return () => {
    if (!lease.live) return;
    lease.live = false;
    if (active !== lease || globalThis[runtimeKey] !== runtime) return;
    let prior = lease;
    while (prior.parent && !prior.parent.live) prior = prior.parent;
    active = prior.parent;
    if (active)
      Object.defineProperty(globalThis, runtimeKey, {
        configurable: true,
        writable: true,
        value: active.runtime,
      });
    else if (prior.previous) Object.defineProperty(globalThis, runtimeKey, prior.previous);
    else delete globalThis[runtimeKey];
  };
}
