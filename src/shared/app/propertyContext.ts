type PropertyContextAccessors<T extends object> = {
  [K in keyof T]: {
    get: () => T[K];
    set?: (value: T[K]) => void;
  };
};

/** Expose an explicit set of live dependencies without copying their current values. */
export function createPropertyContext<T extends object>(accessors: PropertyContextAccessors<T>): T {
  const descriptors = Object.fromEntries(
    Object.entries(accessors).map(([name, accessor]) => [
      name,
      { ...(accessor as PropertyDescriptor), enumerable: true },
    ]),
  );
  return Object.defineProperties({}, descriptors) as T;
}
