import type {
  WidgetViewerBridge,
  WidgetViewerInitialize,
  WidgetViewerState,
} from '@shared/widgets/viewer';

import { acceptWidgetDraft } from './draft';
import { MAX_WIDGET_BYTES, NativeWidgetSandboxHost } from './host';
import { postNativeWidgetMessage } from './messaging';

// This entry has no application preload, Gateway client, Redux or product APIs.
const bridge = window.widgetViewer;
let state: WidgetViewerState | undefined;
let frame: HTMLIFrameElement | undefined;
let host: NativeWidgetSandboxHost | undefined;
let port: MessagePort | undefined;
let mountId = '';
let failed = false;
const nonce = crypto.randomUUID();
const emit = (event: Parameters<WidgetViewerBridge['emit']>[0]) => bridge?.emit(event);
const sendState = () => {
  if (!host || !state) return;
  if (state.layout) host.setLayout(state.layout);
  const origin = new URL(host.url).origin;
  postNativeWidgetMessage(host.frame, { type: 'openclaw:widget-theme', ...state.theme }, origin);
  postNativeWidgetMessage(host.frame, { type: 'openclaw:widget-chat-host' }, origin);
  postNativeWidgetMessage(host.frame, { type: 'openclaw:widget-board-host', nonce }, origin);
  postNativeWidgetMessage(
    host.frame,
    {
      type: 'openclaw:scenario-draft-policy',
      available:
        !failed && Boolean(port) && state.draftAllowed && document.visibilityState !== 'hidden',
    },
    origin,
  );
};
const fail = (runtime: boolean) => {
  if (failed) return;
  failed = true;
  port?.close();
  port = undefined;
  host?.disableLinks();
  sendState();
  if (!runtime) host?.dispose();
  emit({ mountId, type: 'failure', runtime });
};

bridge?.onState(value => {
  state = value;
  sendState();
});
bridge?.onInitialize((value: WidgetViewerInitialize) => {
  if (host || frame) return;
  mountId = value.mountId;
  state ??= { draftAllowed: value.draftAllowed, theme: value.theme, layout: value.layout };
  if (
    new URL(location.href).searchParams.get('mount') !== mountId ||
    typeof value.html !== 'string' ||
    new TextEncoder().encode(value.html).byteLength > MAX_WIDGET_BYTES
  ) {
    fail(false);
    return;
  }
  // The parent authenticated and validated this exact native sandbox URL. No URL
  // comes from the generated widget or a transcript descriptor.
  const style = document.createElement('style');
  style.textContent =
    'html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}justdo-native-widget{display:block;width:100%;height:100%}iframe{display:block;border:0;width:100%;height:100%}';
  document.head.append(style);
  const element = document.createElement('justdo-native-widget');
  const root = element.attachShadow({ mode: 'open' });
  frame = document.createElement('iframe');
  frame.sandbox.add('allow-scripts', 'allow-same-origin', 'allow-forms');
  frame.referrerPolicy = 'origin';
  frame.style.cssText = 'display:block;border:0;width:100%;height:100%';
  root.append(frame);
  document.body.append(element);
  host = new NativeWidgetSandboxHost(
    frame,
    value.url,
    value.html,
    () => {
      if (!failed) {
        emit({ mountId, type: 'ready' });
        sendState();
      }
    },
    () => fail(false),
    url => {
      if (!failed) emit({ mountId, type: 'link', url });
    },
  );
  window.addEventListener('message', event => {
    if (!host || event.source !== frame?.contentWindow || event.origin !== new URL(host.url).origin)
      return;
    if (event.data?.type === 'openclaw:widget-prompt-offer') {
      const offered = event.ports[0];
      if (!offered || failed || port || !host.loaded || event.ports.length !== 1) {
        for (const extra of event.ports) extra.close();
        return;
      }
      port = offered;
      port.onmessage = message => {
        if (
          failed ||
          !state?.draftAllowed ||
          port !== offered ||
          message.data?.type !== 'openclaw:widget-prompt'
        )
          return;
        const text = acceptWidgetDraft(host!.frame, message.data.prompt, mountId);
        if (text) emit({ mountId, type: 'draft', text });
      };
      port.start();
      port.postMessage({ type: 'openclaw:widget-prompt-host-ready' });
      sendState();
      return;
    }
    const size = host.handleMessage(event);
    if (size) emit({ mountId, type: 'height', ...size });
    if (event.data?.type === 'openclaw:widget-runtime-error') fail(true);
    if (event.data?.type === 'openclaw:widget-bridge-ready') sendState();
    if (
      event.data?.type === 'openclaw:widget-scroll' &&
      host.loaded &&
      event.data.nonce === nonce &&
      Number.isFinite(event.data.deltaY)
    )
      emit({ mountId, type: 'scroll', deltaY: Math.max(-8000, Math.min(8000, event.data.deltaY)) });
  });
  document.addEventListener('visibilitychange', sendState);
  window.addEventListener(
    'pagehide',
    () => {
      port?.close();
      host?.dispose();
    },
    { once: true },
  );
  frame.src = value.url;
});
