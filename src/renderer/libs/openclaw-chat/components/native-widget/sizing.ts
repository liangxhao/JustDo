import type { WidgetViewportLayout } from '@shared/widgets/viewer';

import { createWidgetViewportFit } from './viewport-fit';

export const WIDGET_LAYOUT_REQUEST = 'widget-view:layout';
export const WIDGET_LAYOUT_READY = 'widget-view:layout-ready';
export const WIDGET_MEASURED_HEIGHT = 'widget-view:measured-height';

// Serialized into the authenticated document's opaque sandbox. Keep every
// runtime dependency local; this bridge measures layout and grants no APIs.
function installSizing(
  id: string,
  requestType: string,
  readyType: string,
  measuredType: string,
  createViewportFit: typeof createWidgetViewportFit,
) {
  const parent = window.parent;
  const post = parent.postMessage.bind(parent);
  const fitViewport = createViewportFit();
  let layout: WidgetViewportLayout | undefined;
  let queued = false;
  let last = '';
  const report = () => {
    queued = false;
    fitViewport(layout?.expanded === true);
    const body = document.body;
    if (
      !layout ||
      !body ||
      Math.abs(innerWidth - layout.width) > 1 ||
      Math.abs(innerHeight - layout.height) > 1
    )
      return;
    const height = Math.ceil(
      Math.max(body.scrollHeight, body.offsetHeight, body.getBoundingClientRect().height),
    );
    const signature = `${layout.revision}:${height}:${innerWidth}:${innerHeight}`;
    if (!height || signature === last) return;
    last = signature;
    post(
      {
        type: measuredType,
        id,
        revision: layout.revision,
        height,
        width: innerWidth,
        viewportHeight: innerHeight,
      },
      '*',
    );
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(report);
  };
  addEventListener('message', event => {
    const value = event.data;
    const next = value?.layout;
    if (
      event.source !== parent ||
      value?.type !== requestType ||
      value.id !== id ||
      !next ||
      !Number.isSafeInteger(next.revision) ||
      next.revision < 1 ||
      !Number.isFinite(next.width) ||
      next.width <= 0 ||
      !Number.isFinite(next.height) ||
      next.height <= 0 ||
      typeof next.expanded !== 'boolean' ||
      (layout && next.revision < layout.revision)
    )
      return;
    layout = next;
    fitViewport(next.expanded);
    schedule();
  });
  const observer = new ResizeObserver(schedule);
  observer.observe(document.documentElement);
  if (typeof MutationObserver !== 'undefined')
    new MutationObserver(schedule).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'width', 'height'],
    });
  const observeBody = () => {
    if (document.body) observer.observe(document.body);
    schedule();
  };
  if (document.readyState === 'loading')
    addEventListener('DOMContentLoaded', observeBody, { once: true });
  else observeBody();
  addEventListener('load', schedule);
  addEventListener('resize', schedule);
  post({ type: readyType, id }, '*');
}

/** Add the viewport adapter without rewriting native history, markup or CSP. */
export function withWidgetSizing(html: string, id: string): string {
  const args = [id, WIDGET_LAYOUT_REQUEST, WIDGET_LAYOUT_READY, WIDGET_MEASURED_HEIGHT];
  const script = `<script>(${installSizing.toString()})(${args.map(value => JSON.stringify(value).replace(/</gu, '\\u003c')).join(',')},${createWidgetViewportFit.toString()});</script>`;
  const body = /<body(?:\s[^>]*)?>/iu.exec(html);
  const doctype = /^\s*<!doctype[^>]*>/iu.exec(html);
  const at = body ? body.index + body[0].length : (doctype?.[0].length ?? 0);
  return html.slice(0, at) + script + html.slice(at);
}
