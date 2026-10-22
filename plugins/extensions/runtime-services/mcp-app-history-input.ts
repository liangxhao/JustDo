type JsonRecord = Record<string, unknown>;
const record = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Compare recorded inputs, accepting explicit schema defaults but never new queries. */
export function matchesMcpAppHistoryInput(
  original: unknown,
  requested: unknown,
  schema: unknown,
): boolean {
  let nodes = 0;
  const normalize = (value: unknown, shape: unknown, depth = 0): unknown => {
    if (depth > 16 || ++nodes > 8192 || (typeof value === 'string' && value.length > 65536))
      throw new Error('Historical input is too large');
    if (Array.isArray(value))
      return value.map(item => normalize(item, record(shape) ? shape.items : undefined, depth + 1));
    if (record(value)) {
      const properties = record(shape) && record(shape.properties) ? shape.properties : {};
      const entries = new Map(Object.entries(value));
      for (const [key, property] of Object.entries(properties))
        if (!entries.has(key) && record(property) && Object.hasOwn(property, 'default'))
          entries.set(key, property.default);
      return Object.fromEntries(
        [...entries]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, item]) => [key, normalize(item, properties[key], depth + 1)]),
      );
    }
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    )
      return value;
    throw new Error('Historical input is not JSON');
  };
  try {
    if (!record(original) || !record(requested)) return false;
    if (JSON.stringify(original).length > 65536 || JSON.stringify(requested).length > 65536)
      return false;
    const first = JSON.stringify(normalize(original, schema));
    const second = JSON.stringify(normalize(requested, schema));
    return first.length <= 65536 && second.length <= 65536 && first === second;
  } catch {
    return false;
  }
}
