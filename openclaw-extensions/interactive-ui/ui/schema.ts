/** Versioned local UI source; native core owns document admission and storage. */
export const UI_KIND = 'interactive-answer';
export const UI_RESOURCE = '/__interactive_ui__/ui.js';
export const UI_MAX_SOURCE_BYTES = 65_536;
export const UI_MAX_NUMBER = 1_000_000_000_000;

export type UiCell = string | number;
export type UiBlockBase = { id: string; title: string; note?: string };
export type UiTableColumn = { id: string; label: string; type: 'text' | 'number' };
export type UiTableBlock = UiBlockBase & {
  type: 'table';
  columns: UiTableColumn[];
  rows: UiCell[][];
};
export type UiCompareItem = { id: string; title: string; values: UiCell[] };
export type UiCompareBlock = UiBlockBase & {
  type: 'compare';
  metrics: string[];
  items: UiCompareItem[];
};
export type UiChartSeries = { id: string; label: string; values: number[] };
export type UiChartBlock = UiBlockBase & {
  type: 'chart';
  chartType: 'line' | 'bar';
  labels: string[];
  series: UiChartSeries[];
  unit?: string;
};
export type UiFieldBase = { id: string; label: string };
export type UiTextField = UiFieldBase & {
  type: 'text';
  value: string;
  required: boolean;
  maxLength: number;
};
export type UiNumberField = UiFieldBase & {
  type: 'number';
  value: number | null;
  required: boolean;
  min?: number;
  max?: number;
};
export type UiSelectField = UiFieldBase & {
  type: 'select';
  value: string;
  options: string[];
};
export type UiCheckboxField = UiFieldBase & {
  type: 'checkbox';
  value: boolean;
  required: boolean;
};
export type UiFormField = UiTextField | UiNumberField | UiSelectField | UiCheckboxField;
export type UiFormBlock = UiBlockBase & { type: 'form'; fields: UiFormField[] };
export type UiStep = { title: string; body: string };
export type UiStepsBlock = UiBlockBase & { type: 'steps'; items: UiStep[] };
export type UiBlock = UiTableBlock | UiCompareBlock | UiChartBlock | UiFormBlock | UiStepsBlock;
export type UiDocument = {
  version: 1;
  language: 'zh' | 'en';
  summary: string;
  note?: string;
  blocks: UiBlock[];
};

/** Error messages contain fixed rules and structural paths, never source values. */
export class UiSourceError extends Error {
  constructor(path: string, rule: string) {
    super(`${path}: ${rule}`);
    this.name = 'UiSourceError';
  }
}

function reject(path: string, rule: string): never {
  throw new UiSourceError(path, rule);
}

function object(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return reject(path, 'expected an object');
  const data = value as Record<string, unknown>;
  const keys = [...required, ...optional];
  if (Object.keys(data).some(key => !keys.includes(key)))
    return reject(path, `unexpected field; allowed fields: ${keys.join(', ')}`);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(data, key))
      return reject(`${path}.${key}`, 'required');
  }
  return data;
}

function list(value: unknown, path: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    return reject(path, `expected an array with ${min}-${max} entries`);
  return value;
}

function string(value: unknown, path: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maximum)
    return reject(path, `expected plain text of at most ${maximum} UTF-16 code units`);
  if (!allowEmpty && !value.trim()) return reject(path, 'expected non-empty plain text');
  // Values retain their exact text. Labels are normalized for deterministic matching.
  return allowEmpty ? value : value.trim();
}

function identifier(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(value))
    return reject(
      path,
      'expected a lowercase letter followed by 0-39 lowercase letters, digits or hyphens',
    );
  return value;
}

function numeric(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > UI_MAX_NUMBER)
    return reject(path, 'expected a finite number with absolute value at most 1000000000000');
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') return reject(path, 'expected a boolean');
  return value;
}

function requiredFlag(data: Record<string, unknown>, path: string): boolean {
  return data.required === undefined ? false : boolean(data.required, `${path}.required`);
}

function uniqueIds<T extends { id: string }>(values: T[], path: string): T[] {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value.id)) reject(`${path}[${index}].id`, 'must be unique within this array');
    seen.add(value.id);
  });
  return values;
}

function cell(value: unknown, path: string): UiCell {
  return typeof value === 'string' ? string(value, path, 400, true) : numeric(value, path);
}

function blockBase(data: Record<string, unknown>, path: string): UiBlockBase {
  return {
    id: identifier(data.id, `${path}.id`),
    title: string(data.title, `${path}.title`, 80),
    ...(data.note === undefined ? {} : { note: string(data.note, `${path}.note`, 400) }),
  };
}

function table(value: unknown, path: string): UiTableBlock {
  const data = object(value, path, ['type', 'id', 'title', 'columns', 'rows'], ['note']);
  const columns = uniqueIds(
    list(data.columns, `${path}.columns`, 1, 8).map((entry, index): UiTableColumn => {
      const fieldPath = `${path}.columns[${index}]`;
      const item = object(entry, fieldPath, ['id', 'label', 'type']);
      if (item.type !== 'text' && item.type !== 'number')
        return reject(`${fieldPath}.type`, 'expected text or number');
      return {
        id: identifier(item.id, `${fieldPath}.id`),
        label: string(item.label, `${fieldPath}.label`, 80),
        type: item.type,
      };
    }),
    `${path}.columns`,
  );
  const rows = list(data.rows, `${path}.rows`, 1, 100).map((entry, rowIndex) =>
    list(entry, `${path}.rows[${rowIndex}]`, columns.length, columns.length).map(
      (value, columnIndex) => {
        const cellPath = `${path}.rows[${rowIndex}][${columnIndex}]`;
        return columns[columnIndex].type === 'number'
          ? numeric(value, cellPath)
          : string(value, cellPath, 400, true);
      },
    ),
  );
  return { ...blockBase(data, path), type: 'table', columns, rows };
}

function compare(value: unknown, path: string): UiCompareBlock {
  const data = object(value, path, ['type', 'id', 'title', 'metrics', 'items'], ['note']);
  const metrics = list(data.metrics, `${path}.metrics`, 1, 8).map((entry, index) =>
    string(entry, `${path}.metrics[${index}]`, 80),
  );
  const items = uniqueIds(
    list(data.items, `${path}.items`, 2, 6).map((entry, index): UiCompareItem => {
      const itemPath = `${path}.items[${index}]`;
      const item = object(entry, itemPath, ['id', 'title', 'values']);
      return {
        id: identifier(item.id, `${itemPath}.id`),
        title: string(item.title, `${itemPath}.title`, 80),
        values: list(item.values, `${itemPath}.values`, metrics.length, metrics.length).map(
          (value, valueIndex) => cell(value, `${itemPath}.values[${valueIndex}]`),
        ),
      };
    }),
    `${path}.items`,
  );
  return { ...blockBase(data, path), type: 'compare', metrics, items };
}

function chart(value: unknown, path: string): UiChartBlock {
  const data = object(
    value,
    path,
    ['type', 'id', 'title', 'chartType', 'labels', 'series'],
    ['note', 'unit'],
  );
  if (data.chartType !== 'line' && data.chartType !== 'bar')
    return reject(`${path}.chartType`, 'expected line or bar');
  const labels = list(data.labels, `${path}.labels`, 2, 40).map((entry, index) =>
    string(entry, `${path}.labels[${index}]`, 80),
  );
  const series = uniqueIds(
    list(data.series, `${path}.series`, 1, 4).map((entry, index): UiChartSeries => {
      const seriesPath = `${path}.series[${index}]`;
      const item = object(entry, seriesPath, ['id', 'label', 'values']);
      return {
        id: identifier(item.id, `${seriesPath}.id`),
        label: string(item.label, `${seriesPath}.label`, 80),
        values: list(item.values, `${seriesPath}.values`, labels.length, labels.length).map(
          (value, valueIndex) => numeric(value, `${seriesPath}.values[${valueIndex}]`),
        ),
      };
    }),
    `${path}.series`,
  );
  return {
    ...blockBase(data, path),
    type: 'chart',
    chartType: data.chartType,
    labels,
    series,
    ...(data.unit === undefined ? {} : { unit: string(data.unit, `${path}.unit`, 80) }),
  };
}

function field(value: unknown, path: string): UiFormField {
  const tag = object(
    value,
    path,
    ['type', 'id', 'label', 'value'],
    ['required', 'maxLength', 'min', 'max', 'options'],
  );
  const common = {
    id: identifier(tag.id, `${path}.id`),
    label: string(tag.label, `${path}.label`, 80),
  };
  switch (tag.type) {
    case 'text': {
      const data = object(value, path, ['type', 'id', 'label', 'value'], ['required', 'maxLength']);
      const maxLength =
        data.maxLength === undefined ? 400 : numeric(data.maxLength, `${path}.maxLength`);
      if (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > 400)
        return reject(`${path}.maxLength`, 'expected an integer from 1 to 400');
      return {
        ...common,
        type: 'text',
        value: string(data.value, `${path}.value`, maxLength, true),
        required: requiredFlag(data, path),
        maxLength,
      };
    }
    case 'number': {
      const data = object(
        value,
        path,
        ['type', 'id', 'label', 'value'],
        ['required', 'min', 'max'],
      );
      const min = data.min === undefined ? undefined : numeric(data.min, `${path}.min`);
      const max = data.max === undefined ? undefined : numeric(data.max, `${path}.max`);
      if (min !== undefined && max !== undefined && min > max)
        return reject(`${path}.max`, 'must be greater than or equal to min');
      const numberValue = data.value === null ? null : numeric(data.value, `${path}.value`);
      if (
        numberValue !== null &&
        ((min !== undefined && numberValue < min) || (max !== undefined && numberValue > max))
      )
        return reject(`${path}.value`, 'must be within min and max');
      return {
        ...common,
        type: 'number',
        value: numberValue,
        required: requiredFlag(data, path),
        ...(min === undefined ? {} : { min }),
        ...(max === undefined ? {} : { max }),
      };
    }
    case 'select': {
      const data = object(value, path, ['type', 'id', 'label', 'value', 'options']);
      const options = list(data.options, `${path}.options`, 1, 12).map((entry, index) =>
        string(entry, `${path}.options[${index}]`, 80),
      );
      if (new Set(options).size !== options.length)
        return reject(`${path}.options`, 'expected unique non-empty option text');
      const selected = string(data.value, `${path}.value`, 80);
      if (!options.includes(selected)) return reject(`${path}.value`, 'must match an option');
      return { ...common, type: 'select', value: selected, options };
    }
    case 'checkbox': {
      const data = object(value, path, ['type', 'id', 'label', 'value'], ['required']);
      return {
        ...common,
        type: 'checkbox',
        value: boolean(data.value, `${path}.value`),
        required: requiredFlag(data, path),
      };
    }
    default:
      return reject(`${path}.type`, 'expected text, number, select or checkbox');
  }
}

function form(value: unknown, path: string): UiFormBlock {
  const data = object(value, path, ['type', 'id', 'title', 'fields'], ['note']);
  const fields = uniqueIds(
    list(data.fields, `${path}.fields`, 1, 12).map((entry, index) =>
      field(entry, `${path}.fields[${index}]`),
    ),
    `${path}.fields`,
  );
  return { ...blockBase(data, path), type: 'form', fields };
}

function steps(value: unknown, path: string): UiStepsBlock {
  const data = object(value, path, ['type', 'id', 'title', 'items'], ['note']);
  const items = list(data.items, `${path}.items`, 1, 12).map((entry, index): UiStep => {
    const itemPath = `${path}.items[${index}]`;
    const item = object(entry, itemPath, ['title', 'body']);
    return {
      title: string(item.title, `${itemPath}.title`, 80),
      body: string(item.body, `${itemPath}.body`, 400),
    };
  });
  return { ...blockBase(data, path), type: 'steps', items };
}

function block(value: unknown, path: string): UiBlock {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return reject(path, 'expected a block object');
  switch ((value as Record<string, unknown>).type) {
    case 'table':
      return table(value, path);
    case 'compare':
      return compare(value, path);
    case 'chart':
      return chart(value, path);
    case 'form':
      return form(value, path);
    case 'steps':
      return steps(value, path);
    default:
      return reject(`${path}.type`, 'expected table, compare, chart, form or steps');
  }
}

export function parseUiDocument(source: string): UiDocument {
  if (typeof source !== 'string') return reject('source', 'expected a JSON string');
  if (new TextEncoder().encode(source).byteLength > UI_MAX_SOURCE_BYTES)
    return reject('source', 'must not exceed 65536 UTF-8 bytes');
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return reject('source', 'expected valid JSON');
  }
  const data = object(value, 'document', ['version', 'language', 'summary', 'blocks'], ['note']);
  if (data.version !== 1) return reject('document.version', 'expected version 1');
  if (data.language !== 'zh' && data.language !== 'en')
    return reject('document.language', 'expected zh or en');
  return {
    version: 1,
    language: data.language,
    summary: string(data.summary, 'document.summary', 400),
    ...(data.note === undefined ? {} : { note: string(data.note, 'document.note', 400) }),
    blocks: uniqueIds(
      list(data.blocks, 'document.blocks', 1, 8).map((entry, index) =>
        block(entry, `document.blocks[${index}]`),
      ),
      'document.blocks',
    ),
  };
}
