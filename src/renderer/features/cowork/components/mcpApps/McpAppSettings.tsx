import { ArrowPathIcon, ArrowUpRightIcon } from '@heroicons/react/24/outline';
import { useState } from 'react';
import { z } from 'zod';

import { i18nService } from '@/services/i18n';

import { APP_BUTTON, APP_INPUT, APP_PRIMARY_BUTTON } from './mcpAppStyles';

const field = z.object({
  type: z.enum(['string', 'boolean', 'number', 'integer']),
  title: z.string(),
  description: z.string().optional(),
  enum: z.array(z.string()).optional(),
  minLength: z.number().optional(),
  maxLength: z.number().optional(),
  pattern: z.string().optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  multipleOf: z.number().positive().optional(),
});
export const appSettingsSchema = z.object({
  schema: z.object({
    type: z.literal('object'),
    properties: z.record(z.string(), field),
    required: z.array(z.string()).optional(),
  }),
  values: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean()])),
  layout: z
    .array(
      z.object({
        kind: z.literal('group'),
        title: z.string(),
        items: z.array(
          z.discriminatedUnion('kind', [
            z.object({ kind: z.literal('property'), property: z.string() }),
            z.object({
              kind: z.literal('tool'),
              tool: z.string(),
              title: z.string(),
              description: z.string().optional(),
            }),
          ]),
        ),
      }),
    )
    .optional(),
});
export type AppSettings = z.infer<typeof appSettingsSchema>;

export function McpAppSettings({
  settings,
  busy,
  save,
  tool,
  cancel,
}: {
  settings: AppSettings;
  busy: boolean;
  save: (changed: AppSettings['values']) => void;
  tool: (name: string) => void;
  cancel: () => void;
}) {
  // Keep a text draft for number inputs so clearing and entering a new value works.
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(
      Object.entries(settings.values).map(([key, value]) => [
        key,
        typeof value === 'boolean' ? value : String(value),
      ]),
    ),
  );
  const changed: AppSettings['values'] = {};
  let valid = true;
  for (const [key, value] of Object.entries(values)) {
    const schema = settings.schema.properties[key];
    if (!schema) continue;
    const numeric = schema.type === 'number' || schema.type === 'integer';
    if (
      numeric &&
      (typeof value !== 'string' || !value.trim() || !Number.isFinite(Number(value)))
    ) {
      valid = false;
      continue;
    }
    const parsed = numeric ? Number(value) : value;
    if (settings.values[key] !== parsed) changed[key] = parsed;
  }
  const renderField = (key: string) => {
    const schema = settings.schema.properties[key];
    if (!schema) return null;
    const set = (value: string | boolean) => setValues(previous => ({ ...previous, [key]: value }));
    const description = schema.description ? (
      <span className="block text-xs font-normal leading-5 text-secondary">
        {schema.description}
      </span>
    ) : null;
    return (
      <label
        className={
          schema.type === 'boolean'
            ? 'flex cursor-pointer items-center justify-between gap-4 py-1'
            : 'block space-y-1.5'
        }
        key={key}
      >
        <span className="min-w-0 text-xs font-medium text-foreground">
          {schema.title}
          {schema.type === 'boolean' && description}
        </span>
        {schema.type === 'boolean' ? (
          <input
            type="checkbox"
            className="h-4 w-4 shrink-0 accent-primary"
            checked={values[key] === true}
            onChange={event => set(event.target.checked)}
          />
        ) : schema.enum ? (
          <select
            className={APP_INPUT}
            value={String(values[key] ?? '')}
            required={settings.schema.required?.includes(key)}
            onChange={event => set(event.target.value)}
          >
            {!values[key] && <option value="" disabled />}
            {schema.enum.map(option => (
              <option key={option}>{option}</option>
            ))}
          </select>
        ) : (
          <input
            className={APP_INPUT}
            type={schema.type === 'string' ? 'text' : 'number'}
            required={settings.schema.required?.includes(key)}
            minLength={schema.minLength}
            maxLength={schema.maxLength}
            pattern={schema.pattern}
            min={schema.minimum}
            max={schema.maximum}
            step={schema.multipleOf ?? (schema.type === 'integer' ? 1 : 'any')}
            value={String(values[key] ?? '')}
            onChange={event => set(event.target.value)}
          />
        )}
        {schema.type !== 'boolean' && description}
      </label>
    );
  };
  const rendered = new Set(
    settings.layout?.flatMap(group =>
      group.items.flatMap(item => (item.kind === 'property' ? [item.property] : [])),
    ),
  );
  return (
    <form
      onSubmit={event => {
        event.preventDefault();
        if (valid && Object.keys(changed).length) save(changed);
      }}
    >
      <fieldset disabled={busy} className="space-y-4">
        {settings.layout?.map((group, index) => (
          <fieldset key={index} className="space-y-3 rounded-xl border border-border p-3">
            <legend className="px-1 text-xs font-medium text-secondary">{group.title}</legend>
            {group.items.map((item, itemIndex) =>
              item.kind === 'property' ? (
                renderField(item.property)
              ) : (
                <div key={itemIndex}>
                  <button
                    type="button"
                    className={`${APP_BUTTON} -ml-2`}
                    onClick={() => tool(item.tool)}
                  >
                    {item.title}
                    <ArrowUpRightIcon className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                  {item.description && (
                    <p className="text-xs leading-5 text-secondary">{item.description}</p>
                  )}
                </div>
              ),
            )}
          </fieldset>
        ))}
        {Object.keys(settings.schema.properties)
          .filter(key => !rendered.has(key))
          .map(renderField)}
        <div className="flex items-center justify-end gap-1 border-t border-border pt-3">
          <button type="button" className={APP_BUTTON} onClick={cancel}>
            {i18nService.t('mcpAppsCancel')}
          </button>
          <button
            type="submit"
            className={APP_PRIMARY_BUTTON}
            disabled={!valid || !Object.keys(changed).length}
          >
            {busy && <ArrowPathIcon className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            {i18nService.t('mcpAppsSave')}
          </button>
        </div>
      </fieldset>
    </form>
  );
}
