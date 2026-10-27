import type { WebpageEmbedProxyState } from '@shared/browser/webpageEmbed';

// This fixed shell receives only a URL. The nested website has no Electron API.
const bridge = window.webpageEmbedViewer;
let mountId = '';
let targetUrl = '';
let frame: HTMLIFrameElement | undefined;
let failed = false;
bridge?.onNativeFailure(() => {
  failed = true;
  if (mountId) bridge.emit({ mountId, type: 'failure' });
});
let proxy: WebpageEmbedProxyState = { generation: -1, status: 'pending' };
const apply = (value: WebpageEmbedProxyState) => {
  if (value.generation < proxy.generation) return;
  proxy = value;
  if (!mountId) return;
  if (failed) {
    bridge?.emit({ mountId, type: 'failure' });
    return;
  }
  bridge?.emit({ mountId, type: `proxy-${value.status}` });
  if (value.status !== 'ready' || frame) return;
  frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute(
    'allow',
    "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'",
  );
  frame.style.cssText = 'width:100vw;height:100vh;border:0;display:block';
  frame.src = targetUrl;
  document.body.append(frame);
  // A cross-origin load is not evidence that the website permitted embedding.
  bridge?.emit({ mountId, type: 'initialized' });
};
bridge?.onProxyState(apply);
void bridge
  ?.initialize()
  .then(value => {
    mountId = value.mountId;
    targetUrl = value.targetUrl;
    if (value.proxy.generation >= proxy.generation) proxy = value.proxy;
    apply(proxy);
  })
  .catch(() => {
    mountId = new URL(location.href).searchParams.get('mount') ?? '';
    bridge?.emit({ mountId, type: 'failure' });
  });
