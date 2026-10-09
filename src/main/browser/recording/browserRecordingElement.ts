import {
  type BrowserRecordingTarget,
  recordingText,
  recordingUrl,
} from '../../../shared/browser/browserRecording';
import {
  LocatorKind,
  RecordingDetailLimits,
  type RecordingLocator,
  type RecordingScope,
} from '../../../shared/browser/recordingDetails';

const attrNames = [
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
];
const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const cssValue = (text: string) =>
  `"${text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n\f]/g, ' ')}"`;
const rootFor = (element: Element) => element.getRootNode() as Document | ShadowRoot;

export function recordingElementRole(element: Element): string {
  if (element.getAttribute('role')) return recordingText(element.getAttribute('role'), 40);
  const tag = element.localName;
  const type = element.getAttribute('type') ?? 'text';
  if (tag === 'button' || (tag === 'input' && ['button', 'submit', 'reset'].includes(type)))
    return 'button';
  if (tag === 'a' && element.hasAttribute('href')) return 'link';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'select') return (element as HTMLSelectElement).multiple ? 'listbox' : 'combobox';
  if (tag === 'input')
    return ['checkbox', 'radio'].includes(type)
      ? type
      : type === 'search'
        ? 'searchbox'
        : type === 'number'
          ? 'spinbutton'
          : type === 'range'
            ? 'slider'
            : ['text', 'email', 'url', 'tel', 'password'].includes(type)
              ? 'textbox'
              : '';
  return (
    (
      { img: 'img', option: 'option', dialog: 'dialog', tr: 'row', table: 'table' } as Record<
        string,
        string
      >
    )[tag] ?? ''
  );
}

export function createRecordingElementDescriber(sensitive: (element: Element) => boolean) {
  const safeText = (element: Element, max = 240): string => {
    let value = '';
    let visited = 0;
    const walk = (node: Node, depth: number) => {
      if (++visited > 80 || depth > 8 || value.length >= max) return;
      if (node.nodeType === 3) {
        value += node.textContent ?? '';
        return;
      }
      if (node.nodeType !== 1) return;
      const e = node as Element;
      if (sensitive(e) || e.matches('script,style,noscript,input,textarea,select')) return;
      for (const child of Array.from(e.childNodes).slice(0, 80)) walk(child, depth + 1);
    };
    walk(element, 0);
    return recordingText(value.replace(/\s+/g, ' ').trim(), max);
  };
  const name = (e: Element): string => {
    if (sensitive(e)) return '';
    const root = rootFor(e);
    const labelled = (e.getAttribute('aria-labelledby') ?? '')
      .split(/\s+/)
      .slice(0, 8)
      .map(id => {
        const label = id ? root.getElementById(id) : null;
        return label ? safeText(label) : '';
      })
      .join(' ')
      .trim();
    const labels = (e as HTMLInputElement).labels;
    return recordingText(
      e.getAttribute('aria-label') ||
        labelled ||
        (labels?.[0] ? safeText(labels[0]) : '') ||
        (e.matches('input,textarea') ? e.getAttribute('name') || e.id : '') ||
        e.getAttribute('placeholder') ||
        e.getAttribute('alt') ||
        e.getAttribute('title') ||
        safeText(e) ||
        e.getAttribute('name') ||
        e.id ||
        e.localName,
    );
  };
  const cssMatches = (e: Element, selector: string): Element[] => {
    try {
      return Array.from(rootFor(e).querySelectorAll(selector));
    } catch {
      return [];
    }
  };
  const locators = (e: Element, semantic = true): RecordingLocator[] => {
    const result: RecordingLocator[] = [];
    const add = (value: string, dynamic = false) => {
      if (
        !value ||
        value.length > RecordingDetailLimits.selector ||
        result.some(l => l.value === value)
      )
        return;
      const matches = cssMatches(e, value);
      if (matches.includes(e))
        result.push({
          kind: LocatorKind.Css,
          value,
          matches: matches.length,
          verified: true,
          ...(dynamic ? { dynamic: true } : {}),
        });
    };
    for (const attr of [
      'data-testid',
      'data-test',
      'data-cy',
      'id',
      'name',
      'aria-label',
      'placeholder',
    ]) {
      const value = e.getAttribute(attr);
      if (value && value.length <= 160)
        add(
          `${e.localName}[${attr}=${cssValue(value)}]`,
          attr === 'id' && /\d{4,}|[a-f\d]{8,}|^:r/i.test(value),
        );
    }
    for (const attr of ['href', 'type']) {
      const value = e.getAttribute(attr);
      if (attr === 'href' && value) {
        try {
          const url = new URL(value, e.ownerDocument.URL);
          if (url.password || /\[redacted\]/i.test(decodeURIComponent(recordingUrl(url.href))))
            continue;
        } catch {
          continue;
        }
      }
      if (value && value.length <= 160) add(`${e.localName}[${attr}=${cssValue(value)}]`);
    }
    const stableClasses = Array.from(e.classList)
      .filter(c => /^[a-z][a-z_-]{1,48}$/i.test(c))
      .slice(0, 2);
    if (stableClasses.length)
      add(`${e.localName}${stableClasses.map(c => `[class~=${cssValue(c)}]`).join('')}`);
    const role = recordingElementRole(e);
    const label = name(e);
    // Role/name are semantic hints computed from DOM, not a browser AX-tree snapshot.
    if (semantic && role && label) {
      const peers = Array.from(
        rootFor(e).querySelectorAll('button,a,input,textarea,select,img,option,dialog,[role]'),
      ).slice(0, 2000);
      const matches = peers.filter(
        p => !sensitive(p) && recordingElementRole(p) === role && name(p) === label,
      );
      result.push({
        kind: LocatorKind.Role,
        value: role,
        name: label,
        matches: matches.length,
        verified: matches.includes(e) && peers.length < 2000,
      });
    }
    if (semantic && (e as HTMLInputElement).labels?.length) {
      const peers = Array.from(rootFor(e).querySelectorAll('input,textarea,select')).slice(0, 2000);
      const matches = peers.filter(p => !sensitive(p) && name(p) === label);
      result.push({
        kind: LocatorKind.Label,
        value: label,
        matches: matches.length,
        verified: matches.includes(e) && peers.length < 2000,
      });
    }
    const text = semantic ? safeText(e, 160) : '';
    if (text && !e.matches('html,body')) {
      const peers = Array.from(rootFor(e).querySelectorAll(e.localName)).slice(0, 500);
      const matches = peers.filter(p => safeText(p, 160) === text);
      result.push({
        kind: LocatorKind.Text,
        value: text,
        matches: matches.length,
        verified: matches.includes(e) && peers.length < 500,
      });
    }
    let current: Element | null = e;
    const parts: string[] = [];
    let dynamicPath = false;
    while (current && parts.length < 16) {
      const id = current.getAttribute('id');
      if (id && id.length <= 160 && cssMatches(e, `[id=${cssValue(id)}]`).length === 1) {
        parts.unshift(`[id=${cssValue(id)}]`);
        dynamicPath = /\d{4,}|[a-f\d]{8,}|^:r/i.test(id);
        break;
      }
      const tag = current.localName;
      const siblings = current.parentElement
        ? Array.from(current.parentElement.children).filter(s => s.localName === tag)
        : [current];
      parts.unshift(
        siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(current) + 1})` : tag,
      );
      current = current.parentElement;
    }
    add(parts.join(' > '), dynamicPath);
    return result
      .sort(
        (a, b) =>
          Number(b.verified && b.matches === 1 && !b.dynamic) -
          Number(a.verified && a.matches === 1 && !a.dynamic),
      )
      .slice(0, RecordingDetailLimits.locators);
  };
  const selector = (e: Element): string =>
    locators(e, false).find(l => l.kind === LocatorKind.Css && l.verified && l.matches === 1)
      ?.value ?? '';
  const state = (e: Element): Record<string, string | boolean> => {
    if (sensitive(e)) return {};
    const result: Record<string, string | boolean> = {};
    for (const key of [
      'checked',
      'disabled',
      'required',
      'readOnly',
      'selected',
      'open',
    ] as const) {
      const value = (e as unknown as Record<string, unknown>)[key];
      if (typeof value === 'boolean') result[key] = value;
    }
    for (const key of ['expanded', 'selected', 'pressed', 'invalid']) {
      const value = e.getAttribute(`aria-${key}`);
      if (value !== null) result[key] = recordingText(value, 40);
    }
    if (e.matches('input:not([type=file]),textarea,select'))
      result.value = recordingText((e as HTMLInputElement).value, 240);
    return result;
  };
  const attributes = (e: Element): Record<string, string> => {
    if (sensitive(e)) return {};
    return Object.fromEntries(
      attrNames.flatMap(attr => {
        const value = e.getAttribute(attr);
        if (value === null) return [];
        if (attr === 'href' || attr === 'src') {
          try {
            return [[attr, recordingUrl(new URL(value, e.ownerDocument.URL).href)]];
          } catch {
            return [];
          }
        }
        return [[attr, recordingText(value, 160)]];
      }),
    );
  };
  const describe = (e: Element): BrowserRecordingTarget => {
    if (sensitive(e)) return { tag: e.localName, role: '', name: '', selector: '' };
    const limitations = new Set<string>();
    const candidates = locators(e);
    if (candidates.some(l => l.kind !== LocatorKind.Css)) limitations.add('semantic-approximate');
    const scopes: RecordingScope[] = [];
    let scoped: Element | null = e;
    for (let i = 0; scoped && i < RecordingDetailLimits.scopes; i++) {
      const root = rootFor(scoped);
      if ('host' in root) {
        scopes.unshift({ kind: 'shadow', selector: selector(root.host) });
        scoped = root.host;
      } else {
        const frame = root.defaultView?.frameElement;
        if (!frame) {
          scoped = null;
          break;
        }
        scopes.unshift({ kind: 'frame', selector: selector(frame), url: recordingUrl(root.URL) });
        scoped = frame;
      }
    }
    if (scoped) limitations.add('scope-limit');
    if (scopes.some(scope => !scope.selector)) limitations.add('scope-unresolved');
    let nodes = 0;
    let budget = RecordingDetailLimits.html as number;
    const html = (node: Node, depth: number): string => {
      if (++nodes > RecordingDetailLimits.nodes || depth > RecordingDetailLimits.depth) {
        limitations.add('html-truncated');
        return '';
      }
      if (node.nodeType === 3) {
        const value = escapeHtml(recordingText(node.textContent, 240));
        if (value.length > budget) {
          limitations.add('html-truncated');
          return '';
        }
        budget -= value.length;
        return value;
      }
      if (node.nodeType !== 1) return '';
      const el = node as Element;
      if (sensitive(el)) return '';
      if (el.matches('script,style,noscript,template')) return '';
      if (el.localName === 'iframe') {
        limitations.add(
          (el as HTMLIFrameElement).contentDocument
            ? 'frame-content-separate'
            : 'cross-origin-frame',
        );
      }
      if (el.localName.includes('-') && !el.shadowRoot) limitations.add('shadow-unavailable');
      if (el.shadowRoot) limitations.add('shadow-content-separate');
      const attrs = Object.entries(attributes(el))
        .map(([key, value]) => ` ${key}="${escapeHtml(value)}"`)
        .join('');
      const open = `<${el.localName}${attrs}>`;
      const close = el.matches('input,img,area,br,hr,meta,link,source,wbr,embed')
        ? ''
        : `</${el.localName}>`;
      if (open.length + close.length > budget) {
        limitations.add('html-truncated');
        return '';
      }
      budget -= open.length + close.length;
      const children = el.matches('input,textarea,select') ? [] : Array.from(el.childNodes);
      if (children.length > RecordingDetailLimits.nodes) limitations.add('html-truncated');
      return (
        open +
        children
          .slice(0, RecordingDetailLimits.nodes)
          .map(child => html(child, depth + 1))
          .join('') +
        close
      );
    };
    const context: NonNullable<BrowserRecordingTarget['context']> = [];
    let parent = e.parentElement;
    for (let i = 0; parent && i < 8 && context.length < 3; i++, parent = parent.parentElement) {
      if (
        parent.matches('form,dialog,tr,li,section,article,[role=dialog],[role=row],[role=listitem]')
      )
        context.push({ tag: parent.localName, name: name(parent), selector: selector(parent) });
    }
    const bounds = e.getBoundingClientRect();
    const markup = html(e, 0);
    const primary =
      candidates.find(l => l.kind === LocatorKind.Css && l.verified && l.matches === 1)?.value ??
      '';
    if (!primary) limitations.add('selector-unresolved');
    return {
      tag: e.localName,
      role: recordingElementRole(e),
      name: name(e),
      selector: primary,
      html: markup,
      attributes: attributes(e),
      state: state(e),
      locators: candidates,
      scopes,
      context,
      bounds: {
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      },
      ...(e.ownerDocument !== document ? { frameUrl: recordingUrl(e.ownerDocument.URL) } : {}),
      ...(limitations.size ? { limitations: [...limitations] } : {}),
    };
  };
  return { describe, selector, state, safeText };
}
