export const EXTENSION_OUTBOUND_HEADER_MANIFEST_FILE = 'outbound-header-policy.json';
export const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
export const HTTP_HEADER_VALUE_PATTERN = /^[\u0020-\u007e\u0080-\u00ff]*$/;

type OutboundHeaderObject =
  | Readonly<{ name: string; from: string }>
  | Readonly<{ name: string; value: string }>;

export type OutboundHeaderEntry = string | OutboundHeaderObject;

export const getOutboundHeaderName = (entry: OutboundHeaderEntry): string =>
  typeof entry === 'string' ? entry : entry.name;

export const mergeOutboundHeaderEntries = (entries: Iterable<OutboundHeaderEntry>): OutboundHeaderEntry[] => {
  const merged = new Map<string, OutboundHeaderEntry>();
  for (const entry of entries) {
    const name = getOutboundHeaderName(entry).toLowerCase();
    // Existing string-only declarations keep first-match precedence.
    if (typeof entry !== 'string' || !merged.has(name)) merged.set(name, entry);
  }
  return [...merged.values()];
};

export const parseOutboundHeaderObject = (value: unknown): OutboundHeaderObject | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(entry, 'name') || typeof entry.name !== 'string' ||
      !HTTP_HEADER_NAME_PATTERN.test(entry.name)) return null;

  const hasSource = Object.prototype.hasOwnProperty.call(entry, 'from');
  const hasLiteral = Object.prototype.hasOwnProperty.call(entry, 'value');
  if (hasSource === hasLiteral) return null;
  if (hasSource) {
    return typeof entry.from === 'string' && entry.from.trim() && !/[\u0000-\u001f\u007f]/.test(entry.from)
      ? { name: entry.name, from: entry.from }
      : null;
  }
  return typeof entry.value === 'string' && HTTP_HEADER_VALUE_PATTERN.test(entry.value)
    ? { name: entry.name, value: entry.value }
    : null;
};

export type ExtensionOutboundHeaderGroupV1 = {
  baseUrlWhitelist: string[];
  headerNames: OutboundHeaderEntry[];
};

export type ExtensionOutboundHeaderManifestV1 = {
  schemaVersion: 1;
  groups: ExtensionOutboundHeaderGroupV1[];
};
