import { sanitizeRecordingLocation } from './browserRecordingNetwork';

/** Bounded recording evidence, not executable automation instructions. */
export const RecordingDetailLimits = {
  html: 4800,
  nodes: 40,
  depth: 3,
  locators: 8,
  scopes: 12,
  selector: 1000,
} as const;
export const LocatorKind = { Css: 'css', Role: 'role', Label: 'label', Text: 'text' } as const;
export type RecordingLocator = {
  kind: (typeof LocatorKind)[keyof typeof LocatorKind];
  value: string;
  name?: string;
  matches: number;
  verified: boolean;
  dynamic?: boolean;
};
export type RecordingScope = {
  kind: 'frame' | 'shadow';
  selector: string;
  url?: string;
};
export type RecordingElementDetails = {
  locators?: RecordingLocator[];
  scopes?: RecordingScope[];
  attributes?: Record<string, string>;
  state?: Record<string, string | boolean>;
  context?: { tag: string; name: string; selector: string }[];
  bounds?: { x: number; y: number; width: number; height: number };
  limitations?: string[];
};
export type RecordingInteraction = {
  modifiers?: string[];
  pointer?: { x: number; y: number; offsetX: number; offsetY: number; button: number };
  origin?: string;
  destination?: string;
  destinationElement?: RecordingElementDetails & { tag: string; name: string; selector: string };
  options?: { label: string; value: string; index: number }[];
  scroll?: { scope: 'page' | 'element'; x: number; y: number };
  observed?: { url?: string; state?: Record<string, string | boolean>; messages?: string[] };
};

export function recordingElementFrameUrls<T extends RecordingElementDetails>(element: T): T {
  if (!element.scopes?.some(scope => scope.kind === 'frame' && scope.url)) return element;
  return {
    ...element,
    scopes: element.scopes.map(scope =>
      scope.kind === 'frame' && scope.url
        ? { ...scope, url: sanitizeRecordingLocation(scope.url) }
        : scope,
    ),
  };
}

const text = (v: unknown, max = 240): string =>
  typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').slice(0, max) : '';
const object = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const array = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);
const selector = (v: unknown): string =>
  typeof v === 'string' && v.length <= RecordingDetailLimits.selector ? v : '';
const finite = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e8;
const states = new Set([
  'checked',
  'disabled',
  'expanded',
  'selected',
  'pressed',
  'required',
  'readOnly',
  'invalid',
  'open',
  'value',
]);
const attributes = new Set([
  'id',
  'name',
  'type',
  'role',
  'aria-label',
  'aria-labelledby',
  'placeholder',
  'title',
  'alt',
  'href',
  'src',
  'data-testid',
  'data-test',
  'data-cy',
  'class',
]);
function record(
  v: unknown,
  keys: Set<string>,
  booleans: boolean,
): Record<string, string | boolean> {
  return Object.fromEntries(
    Object.entries(object(v) ?? {})
      .filter(
        ([key, value]) =>
          keys.has(key) && (typeof value === 'string' || (booleans && typeof value === 'boolean')),
      )
      .map(([key, value]) => [key, typeof value === 'boolean' ? value : text(value)]),
  );
}
export function parseElementDetails(value: unknown): RecordingElementDetails {
  const v = object(value) ?? {};
  const result: RecordingElementDetails = {};
  if (Array.isArray(v.locators))
    result.locators = array(v.locators, RecordingDetailLimits.locators).flatMap(item => {
      const l = object(item);
      if (
        !l ||
        !Object.values(LocatorKind).includes(l.kind as 'css') ||
        !selector(l.value) ||
        !Number.isSafeInteger(l.matches) ||
        Number(l.matches) < 0
      )
        return [];
      return [
        {
          kind: l.kind as RecordingLocator['kind'],
          value: selector(l.value),
          ...(typeof l.name === 'string' ? { name: text(l.name) } : {}),
          matches: Math.min(Number(l.matches), 1e6),
          verified: l.verified === true,
          ...(l.dynamic === true ? { dynamic: true } : {}),
        },
      ];
    });
  if (Array.isArray(v.scopes))
    result.scopes = array(v.scopes, RecordingDetailLimits.scopes).flatMap(item => {
      const s = object(item);
      return s && (s.kind === 'frame' || s.kind === 'shadow')
        ? [
            {
              kind: s.kind,
              selector: selector(s.selector),
              ...(typeof s.url === 'string' ? { url: sanitizeRecordingLocation(s.url) } : {}),
            },
          ]
        : [];
    });
  if (v.attributes)
    result.attributes = record(v.attributes, attributes, false) as Record<string, string>;
  if (v.state) result.state = record(v.state, states, true);
  if (Array.isArray(v.context))
    result.context = array(v.context, 3).flatMap(item => {
      const c = object(item);
      return c
        ? [{ tag: text(c.tag, 40), name: text(c.name), selector: selector(c.selector) }]
        : [];
    });
  const b = object(v.bounds);
  if (b && ['x', 'y', 'width', 'height'].every(key => finite(b[key])))
    result.bounds = {
      x: b.x as number,
      y: b.y as number,
      width: b.width as number,
      height: b.height as number,
    };
  if (Array.isArray(v.limitations))
    result.limitations = array(v.limitations, 12).map(item => text(item, 80));
  return result;
}
export function parseInteraction(value: unknown): RecordingInteraction | undefined {
  const v = object(value);
  if (!v) return undefined;
  const result: RecordingInteraction = {};
  if (Array.isArray(v.modifiers))
    result.modifiers = array(v.modifiers, 4).filter(item =>
      ['Control', 'Alt', 'Shift', 'Meta'].includes(String(item)),
    ) as string[];
  const p = object(v.pointer);
  if (p && ['x', 'y', 'offsetX', 'offsetY', 'button'].every(key => finite(p[key])))
    result.pointer = {
      x: p.x as number,
      y: p.y as number,
      offsetX: p.offsetX as number,
      offsetY: p.offsetY as number,
      button: p.button as number,
    };
  if (typeof v.origin === 'string') result.origin = selector(v.origin);
  if (typeof v.destination === 'string') result.destination = selector(v.destination);
  const destination = object(v.destinationElement);
  if (destination)
    result.destinationElement = {
      ...parseElementDetails(destination),
      tag: text(destination.tag, 40),
      name: text(destination.name),
      selector: selector(destination.selector),
    };
  if (Array.isArray(v.options))
    result.options = array(v.options, 32).flatMap(item => {
      const o = object(item);
      return o && Number.isSafeInteger(o.index)
        ? [{ label: text(o.label), value: text(o.value, 2000), index: o.index as number }]
        : [];
    });
  const s = object(v.scroll);
  if (s && (s.scope === 'page' || s.scope === 'element') && finite(s.x) && finite(s.y))
    result.scroll = { scope: s.scope, x: s.x, y: s.y };
  const observed = object(v.observed);
  if (observed)
    result.observed = {
      ...(typeof observed.url === 'string' ? { url: sanitizeRecordingLocation(observed.url) } : {}),
      ...(observed.state ? { state: record(observed.state, states, true) } : {}),
      ...(Array.isArray(observed.messages)
        ? { messages: array(observed.messages, 5).map(item => text(item)) }
        : {}),
    };
  return result;
}
