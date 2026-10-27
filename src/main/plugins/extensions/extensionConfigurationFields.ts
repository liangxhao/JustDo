import type { OpenClawExtensionConfigurationField } from '../../../shared/plugins/extensions';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const getNestedValue = (value: unknown, dottedPath: string): unknown =>
  dottedPath.split('.').reduce<unknown>((current, segment) => {
    return isRecord(current) && Object.hasOwn(current, segment) ? current[segment] : undefined;
  }, value);

const FORBIDDEN_CONFIG_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
export const isSafeConfigPath = (dottedPath: string): boolean => {
  if (!dottedPath || dottedPath.length > 256) return false;
  return dottedPath
    .split('.')
    .every(
      segment =>
        /^[A-Za-z_][A-Za-z0-9_-]*$/.test(segment) && !FORBIDDEN_CONFIG_PATH_SEGMENTS.has(segment),
    );
};

export const setNestedValue = (
  target: Record<string, unknown>,
  dottedPath: string,
  value: unknown,
): void => {
  if (!isSafeConfigPath(dottedPath)) throw new Error('Unsupported extension configuration path.');
  const segments = dottedPath.split('.');
  let current = target;
  segments.forEach((segment, index) => {
    if (index === segments.length - 1) {
      current[segment] = value;
      return;
    }
    const next = isRecord(current[segment]) ? current[segment] : {};
    current[segment] = next;
    current = next;
  });
};

export const deleteNestedValue = (target: Record<string, unknown>, dottedPath: string): void => {
  if (!isSafeConfigPath(dottedPath)) throw new Error('Unsupported extension configuration path.');
  const segments = dottedPath.split('.');
  const parent =
    segments.length === 1 ? target : getNestedValue(target, segments.slice(0, -1).join('.'));
  if (isRecord(parent)) delete parent[segments.at(-1)!];
};

/** A protected object also protects its descendants; a wildcard matches one path segment. */
const pathsOverlap = (left: string, right: string): boolean => {
  const first = left.split('.');
  const second = right.split('.');
  return first
    .slice(0, Math.min(first.length, second.length))
    .every(
      (segment, index) => segment === second[index] || segment === '*' || second[index] === '*',
    );
};

const hasUnsupportedSchemaRules = (schema: Record<string, unknown>): boolean =>
  [
    '$ref',
    '$dynamicRef',
    'allOf',
    'anyOf',
    'oneOf',
    'not',
    'if',
    'then',
    'else',
    'dependentSchemas',
  ].some(key => Object.hasOwn(schema, key));

/** Only explicitly editable, schema-declared text crosses the plaintext inventory boundary. */
export const getTextConfigurationFields = (
  manifest: Record<string, unknown>,
  pluginConfig: unknown,
): OpenClawExtensionConfigurationField[] => {
  const hints = isRecord(manifest.uiHints) ? manifest.uiHints : {};
  const contracts = isRecord(manifest.configContracts) ? manifest.configContracts : {};
  const secretInputs = isRecord(contracts.secretInputs) ? contracts.secretInputs : {};
  const protectedPaths = [
    ...Object.entries(hints)
      .filter(([, hint]) => isRecord(hint) && hint.sensitive === true)
      .map(([fieldPath]) => fieldPath),
    ...[secretInputs.paths, contracts.dangerousFlags].flatMap(entries =>
      Array.isArray(entries)
        ? entries.flatMap(entry =>
            isRecord(entry) && typeof entry.path === 'string' ? [entry.path] : [],
          )
        : [],
    ),
  ];
  return Object.entries(hints).flatMap(([fieldPath, hint]) => {
    if (
      !isSafeConfigPath(fieldPath) ||
      !isRecord(hint) ||
      hint.configurable !== true ||
      protectedPaths.some(protectedPath => pathsOverlap(fieldPath, protectedPath))
    )
      return [];
    let schema: unknown = manifest.configSchema;
    let required = false;
    for (const segment of fieldPath.split('.')) {
      if (
        !isRecord(schema) ||
        schema.readOnly === true ||
        schema.writeOnly === true ||
        Object.hasOwn(schema, 'const') ||
        hasUnsupportedSchemaRules(schema) ||
        !isRecord(schema.properties) ||
        !Object.hasOwn(schema.properties, segment)
      )
        return [];
      required = Array.isArray(schema.required) && schema.required.includes(segment);
      schema = schema.properties[segment];
    }
    if (
      !isRecord(schema) ||
      schema.type !== 'string' ||
      schema.readOnly === true ||
      schema.writeOnly === true ||
      schema.format === 'password' ||
      Object.hasOwn(schema, 'const') ||
      hasUnsupportedSchemaRules(schema) ||
      (schema.enum !== undefined &&
        (!Array.isArray(schema.enum) || !schema.enum.every(item => typeof item === 'string')))
    )
      return [];
    const value = getNestedValue(pluginConfig, fieldPath);
    return [
      {
        path: fieldPath,
        label: typeof hint.label === 'string' ? hint.label : fieldPath,
        help: typeof hint.help === 'string' ? hint.help : undefined,
        labelKey: typeof hint.labelKey === 'string' ? hint.labelKey : undefined,
        helpKey: typeof hint.helpKey === 'string' ? hint.helpKey : undefined,
        type: 'string',
        sensitive: false,
        configured: typeof value === 'string',
        ...(typeof value === 'string' ? { value } : {}),
        ...(typeof schema.default === 'string' ? { defaultValue: schema.default } : {}),
        required,
        ...(typeof schema.minLength === 'number' ? { minLength: schema.minLength } : {}),
        ...(typeof schema.maxLength === 'number' ? { maxLength: schema.maxLength } : {}),
        ...(typeof schema.pattern === 'string' ? { pattern: schema.pattern } : {}),
        ...(Array.isArray(schema.enum) && schema.enum.every(item => typeof item === 'string')
          ? { enum: schema.enum as string[] }
          : {}),
        ...(typeof schema.format === 'string' ? { format: schema.format } : {}),
      },
    ];
  });
};

export const isValidTextConfigurationValue = (
  field: OpenClawExtensionConfigurationField,
  value: string,
): boolean => {
  // Blank optional text removes the override. Required fields may restore a valid default.
  if (value === '') {
    if (!field.required) return true;
    if (typeof field.defaultValue !== 'string') return false;
    value = field.defaultValue;
  }
  const length = [...value].length;
  if (
    (field.minLength !== undefined && length < field.minLength) ||
    (field.maxLength !== undefined && length > field.maxLength) ||
    (field.enum !== undefined && !field.enum.includes(value))
  )
    return false;
  try {
    if (field.pattern !== undefined && !new RegExp(field.pattern, 'u').test(value)) return false;
    if (field.format === 'uri' && !URL.canParse(value)) return false;
    if (field.format === 'uri-reference' && !URL.canParse(value, 'https://validation.invalid'))
      return false;
  } catch {
    return false;
  }
  return true;
};
