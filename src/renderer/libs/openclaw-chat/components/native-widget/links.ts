export const WIDGET_LINK_OFFER = 'openclaw:widget-bridge-port-offer';
export const WIDGET_LINK_READY = 'widget-view:links-ready';
export const WIDGET_LINK_OPEN = 'widget-view:open-link';

export function normalizeWidgetLink(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > 8192 || /[\u0000-\u0020\u007f]/u.test(raw)) return;
  try {
    const url = new URL(raw);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password)
      return url.href;
  } catch {
    // Relative paths, fragment links and non-web schemes have no host authority.
  }
}

// Runs before widget scripts in the opaque document. The private port carries
// only real anchor activations; it never adopts native dashboard capabilities.
function installLinks(id: string, offerType: string, readyType: string, openType: string) {
  const apply = Reflect.apply;
  const descriptor = Object.getOwnPropertyDescriptor;
  const parent = window.parent;
  const post = parent.postMessage.bind(parent);
  const listen = window.addEventListener.bind(window);
  const unlisten = window.removeEventListener.bind(window);
  const listenDocument = document.addEventListener.bind(document);
  const later = window.setTimeout.bind(window);
  const cancel = window.clearTimeout.bind(window);
  const path = Event.prototype.composedPath;
  const prevent = Event.prototype.preventDefault;
  const prevented = descriptor(Event.prototype, 'defaultPrevented')!.get!;
  const localName = descriptor(Element.prototype, 'localName')!.get!;
  const getAttribute = Element.prototype.getAttribute;
  const trim = String.prototype.trim;
  const test = RegExp.prototype.test;
  const web = /^https?:\/\//iu;
  const channel = new MessageChannel();
  const send = channel.port1.postMessage.bind(channel.port1);
  const activation = navigator.userActivation;
  const active = activation && descriptor(Object.getPrototypeOf(activation), 'isActive')?.get;
  let ready = false;
  channel.port1.onmessage = event => {
    if (event.data?.type === readyType) ready = true;
  };
  channel.port1.start();
  const activate = (event: MouseEvent) => {
    if (
      !ready ||
      !event.isTrusted ||
      apply(prevented, event, []) ||
      event.shiftKey ||
      event.altKey ||
      !active ||
      apply(active, activation, []) !== true ||
      !(
        (event.type === 'click' && event.button === 0) ||
        (event.type === 'auxclick' && event.button === 1)
      )
    )
      return;
    const entries = apply(path, event, []);
    for (let index = 0; index < entries.length; index++) {
      const node = entries[index];
      try {
        if (apply(localName, node, []) !== 'a') continue;
        const raw =
          apply(getAttribute, node, ['href']) ?? apply(getAttribute, node, ['xlink:href']);
        if (raw === null || apply(getAttribute, node, ['download']) !== null) return;
        const url = apply(trim, raw, []);
        if (!apply(test, web, [url])) return;
        apply(prevent, event, []);
        send({ type: openType, url });
        return;
      } catch {
        // A composed path also contains non-Element nodes.
      }
    }
  };
  const finishActivation = (event: MouseEvent) => {
    if (!ready || !event.isTrusted) return;
    const type = event.type as 'click' | 'auxclick';
    const complete = (candidate: MouseEvent) => {
      if (candidate !== event) return;
      unlisten(type, complete);
      cancel(cleanup);
      activate(event);
    };
    // Append after the widget's existing window delegates. A timer also removes
    // this listener when a later local handler stops propagation before window.
    const cleanup = later(() => unlisten(type, complete), 0);
    listen(type, complete);
  };
  listenDocument('click', finishActivation);
  listenDocument('auxclick', finishActivation);
  post({ type: offerType, linkId: id }, '*', [channel.port2]);
}

/** Precede every widget script, preserving the native document and its CSP. */
export function withWidgetLinks(html: string, id: string): string {
  const args = [id, WIDGET_LINK_OFFER, WIDGET_LINK_READY, WIDGET_LINK_OPEN];
  const script = `<script>(${installLinks.toString()})(${args.map(value => JSON.stringify(value).replace(/</gu, '\\u003c')).join(',')});</script>`;
  const doctype = /^(?:\uFEFF)?(?:\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/iu.exec(html);
  const at = doctype?.[0].length ?? 0;
  return html.slice(0, at) + script + html.slice(at);
}
