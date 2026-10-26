import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  installWidgetImageLoading,
  WIDGET_IMAGE_SOURCE_ATTRIBUTE,
} from '../document/image-loading';

type Request = {
  url: string;
  options: RequestInit;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};
const documents: JSDOM[] = [];

function fixture(html = '', beforeInstall?: (dom: JSDOM) => void) {
  const dom = new JSDOM(html, {
    url: 'http://sandbox.example/mcp-app-sandbox',
    runScripts: 'outside-only',
    virtualConsole: new VirtualConsole(),
  });
  documents.push(dom);
  const requests: Request[] = [];
  const assigned: { image: HTMLImageElement; value: string }[] = [];
  const source = Object.getOwnPropertyDescriptor(dom.window.HTMLImageElement.prototype, 'src')!;
  Object.defineProperty(dom.window.HTMLImageElement.prototype, 'src', {
    ...source,
    set(this: HTMLImageElement, value: string) {
      assigned.push({ image: this, value });
      source.set!.call(this, value);
    },
  });
  const nativeDecode = vi.fn((): Promise<void> => Promise.resolve());
  Object.defineProperty(dom.window.HTMLImageElement.prototype, 'decode', {
    configurable: true,
    writable: true,
    value: nativeDecode,
  });
  const complete = Object.getOwnPropertyDescriptor(
    dom.window.HTMLImageElement.prototype,
    'complete',
  )!;
  const nativeComplete = vi.fn(function (this: HTMLImageElement): boolean {
    return complete.get!.call(this);
  });
  Object.defineProperty(dom.window.HTMLImageElement.prototype, 'complete', {
    ...complete,
    get: nativeComplete,
  });
  // The fixture intentionally allows a response after abort, so race tests prove
  // that a late source cannot overwrite a newer assignment.
  const fetch = vi.fn(
    (url: string, options: RequestInit) =>
      new Promise((resolve, reject) => {
        requests.push({ url, options, resolve, reject });
      }),
  );
  Object.defineProperty(dom.window, 'fetch', { value: fetch, configurable: true });
  const install = () => dom.window.eval(`(${installWidgetImageLoading.toString()})();`);
  const respond = (request: Request, body = 'pixels', status = 200) =>
    request.resolve({
      ok: status >= 200 && status < 300,
      blob: async () => new dom.window.Blob([body], { type: 'image/png' }),
    });
  beforeInstall?.(dom);
  install();
  return { dom, requests, assigned, fetch, install, respond, nativeDecode, nativeComplete };
}

afterEach(() => {
  documents.splice(0).forEach(dom => dom.window.close());
});

describe('widget image loading compatibility', () => {
  it.each(['property', 'attribute', 'prototype attribute'] as const)(
    'converts HTTPS assigned through %s without changing native load events',
    async method => {
      const { dom, requests, assigned, respond } = fixture();
      const image = new dom.window.Image();
      const load = vi.fn();
      image.addEventListener('load', load);
      const url = 'https://assets.example/earth.jpg';
      if (method === 'property') image.src = url;
      else if (method === 'attribute') image.setAttribute('SRC', url);
      else dom.window.Element.prototype.setAttribute.call(image, 'src', url);

      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe(url);
      expect(requests[0].options).toEqual({
        credentials: 'omit',
        signal: expect.any(dom.window.AbortSignal),
      });
      expect(assigned).toEqual([]);
      respond(requests[0]);
      await vi.waitFor(() => expect(assigned).toHaveLength(1));
      expect(assigned[0]).toEqual({ image, value: 'data:image/png;base64,cGl4ZWxz' });
      expect(image.src).toBe(assigned[0].value);
      expect(image.getAttribute('src')).toBe(assigned[0].value);
      expect(load).not.toHaveBeenCalled();
    },
  );

  it.each([
    'data:image/png;base64,cGl4ZWxz',
    'blob:http://sandbox.example/image',
    'http://assets.example/image.png',
    '/relative.png',
    '',
  ])('leaves non-HTTPS source %j to the native image loader', value => {
    const { dom, requests, assigned } = fixture();
    const image = new dom.window.Image();
    image.src = value;
    expect(assigned).toEqual([{ image, value }]);
    expect(requests).toEqual([]);
  });

  it('does not intercept another element, srcset, CSS or namespaced attributes', () => {
    const { dom, requests } = fixture();
    const source = dom.window.document.createElement('source');
    const image = new dom.window.Image();
    source.setAttribute('src', 'https://assets.example/video.mp4');
    image.srcset = 'https://assets.example/a.png 2x';
    image.setAttributeNS(null, 'src', 'https://assets.example/namespaced.png');
    image.style.backgroundImage = 'url(https://assets.example/background.png)';
    expect(source.getAttribute('src')).toBe('https://assets.example/video.mp4');
    expect(image.getAttribute('src')).toBe('https://assets.example/namespaced.png');
    expect(requests).toEqual([]);
  });

  it('restores static marked images present before installation', async () => {
    const { dom, requests, assigned, respond } = fixture(
      `<img id="earth" ${WIDGET_IMAGE_SOURCE_ATTRIBUTE}="https://assets.example/earth.jpg">`,
    );
    const image = dom.window.document.getElementById('earth') as HTMLImageElement;
    expect(requests).toHaveLength(1);
    expect(image.hasAttribute(WIDGET_IMAGE_SOURCE_ATTRIBUTE)).toBe(true);
    expect(image.hasAttribute('src')).toBe(false);
    respond(requests[0]);
    await vi.waitFor(() => expect(assigned).toHaveLength(1));
    expect(image.src).toBe('data:image/png;base64,cGl4ZWxz');
    expect(image.hasAttribute(WIDGET_IMAGE_SOURCE_ATTRIBUTE)).toBe(false);
  });

  it('restores marked descendants added later and avoids duplicate loads on reparenting', async () => {
    const { dom, requests, assigned, respond } = fixture();
    const container = dom.window.document.createElement('div');
    container.innerHTML = `<section><img ${WIDGET_IMAGE_SOURCE_ATTRIBUTE}="https://assets.example/late.png"></section>`;
    dom.window.document.body.append(container);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    container.remove();
    dom.window.document.body.append(container);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(requests).toHaveLength(1);
    respond(requests[0]);
    await vi.waitFor(() => expect(assigned).toHaveLength(1));
  });

  it('restores non-HTTPS static markup through the native setter', () => {
    const { dom, requests, assigned } = fixture(
      `<img ${WIDGET_IMAGE_SOURCE_ATTRIBUTE}="data:image/png;base64,cGl4ZWxz">`,
    );
    expect(assigned).toHaveLength(1);
    expect(
      dom.window.document.querySelector('img')?.hasAttribute(WIDGET_IMAGE_SOURCE_ATTRIBUTE),
    ).toBe(false);
    expect(requests).toEqual([]);
  });

  it('is idempotent and supports images that never join the DOM', async () => {
    const { dom, requests, assigned, respond, install } = fixture();
    install();
    install();
    const image = new dom.window.Image();
    expect(image.isConnected).toBe(false);
    image.src = 'https://assets.example/detached.png';
    expect(requests).toHaveLength(1);
    respond(requests[0]);
    await vi.waitFor(() => expect(assigned).toHaveLength(1));
  });

  it('dispatches one image error so a loader can settle its loading manager', async () => {
    const { dom, requests, assigned } = fixture();
    const image = new dom.window.Image();
    let outstanding = 1;
    const load = vi.fn(() => outstanding--);
    const error = vi.fn((_event: Event) => outstanding--);
    image.addEventListener('load', load);
    image.addEventListener('error', error);
    image.src = 'https://assets.example/failed.png';
    requests[0].reject(new Error('private-network-detail'));
    await vi.waitFor(() => expect(outstanding).toBe(0));
    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0][0]).toBeInstanceOf(dom.window.Event);
    expect(error.mock.calls[0][0]).not.toHaveProperty('message');
    expect(load).not.toHaveBeenCalled();
    expect(assigned).toEqual([]);
  });

  it.each(['http failure', 'blob failure', 'invalid blob'] as const)(
    'reports %s as an image error without assigning a remote source',
    async failure => {
      const { dom, requests, assigned, respond } = fixture();
      const image = new dom.window.Image();
      const error = vi.fn();
      image.addEventListener('error', error);
      image.src = 'https://assets.example/failure.png';
      if (failure === 'http failure') respond(requests[0], 'missing', 404);
      else
        requests[0].resolve({
          ok: true,
          blob: async () => {
            if (failure === 'blob failure') throw new Error('private-body-detail');
            return 'not a Blob';
          },
        });
      await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
      expect(assigned).toEqual([]);
    },
  );

  it('aborts a previous request and discards its response after a newer HTTPS assignment', async () => {
    const { dom, requests, assigned, respond } = fixture();
    const image = new dom.window.Image();
    const error = vi.fn();
    image.addEventListener('error', error);
    image.src = 'https://assets.example/slow.png';
    image.src = 'https://assets.example/fast.png';
    expect(requests[0].options.signal?.aborted).toBe(true);
    respond(requests[1], 'new');
    await vi.waitFor(() => expect(assigned).toHaveLength(1));
    respond(requests[0], 'old');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(assigned.map(entry => entry.value)).toEqual(['data:image/png;base64,bmV3']);
    expect(error).not.toHaveBeenCalled();
  });

  it('does not let a failed old request report an error for the current image', async () => {
    const { dom, requests, assigned } = fixture();
    const image = new dom.window.Image();
    const error = vi.fn();
    image.addEventListener('error', error);
    image.src = 'https://assets.example/slow.png';
    image.src = 'data:image/png;base64,bmV3';
    expect(requests[0].options.signal?.aborted).toBe(true);
    requests[0].reject(new Error('late failure'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(assigned.map(entry => entry.value)).toEqual(['data:image/png;base64,bmV3']);
    expect(error).not.toHaveBeenCalled();
  });

  it.each(['reading', 'decoded'] as const)(
    'invalidates an old FileReader while %s before a newer source is assigned',
    async phase => {
      const readers: ControlledReader[] = [];
      class ControlledReader {
        result: string | null = null;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        onabort: (() => void) | null = null;
        aborted = false;
        constructor() {
          readers.push(this);
        }
        readAsDataURL(): void {}
        abort(): void {
          this.aborted = true;
          this.onabort?.();
        }
        finish(): void {
          this.result = 'data:image/png;base64,b2xk';
          this.onload?.();
        }
      }
      const { dom, requests, assigned, respond } = fixture('', dom => {
        Object.defineProperty(dom.window, 'FileReader', { value: ControlledReader });
      });
      const image = new dom.window.Image();
      const error = vi.fn();
      image.addEventListener('error', error);
      image.src = 'https://assets.example/old.png';
      respond(requests[0]);
      await vi.waitFor(() => expect(readers).toHaveLength(1));
      if (phase === 'decoded') readers[0].finish();
      image.src = 'data:image/png;base64,bmV3';
      expect(readers[0].aborted).toBe(true);
      readers[0].finish();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(assigned.map(entry => entry.value)).toEqual(['data:image/png;base64,bmV3']);
      expect(error).not.toHaveBeenCalled();
    },
  );

  it('cancels pending sources on removal and permits an explicit retry of the same URL', async () => {
    const { dom, requests, assigned, respond } = fixture();
    const image = new dom.window.Image();
    const url = 'https://assets.example/retry.png';
    image.src = url;
    image.removeAttribute('SRC');
    expect(requests[0].options.signal?.aborted).toBe(true);
    respond(requests[0], 'old');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(assigned).toEqual([]);
    image.src = url;
    respond(requests[1]);
    await vi.waitFor(() => expect(assigned).toHaveLength(1));
  });

  it('lets authored src replace a pending static marker and prevents its restoration', async () => {
    const { dom, requests, assigned, respond } = fixture(
      `<img ${WIDGET_IMAGE_SOURCE_ATTRIBUTE}="https://assets.example/static.png">`,
    );
    const image = dom.window.document.querySelector('img')!;
    image.src = 'data:image/png;base64,bmV3';
    expect(image.hasAttribute(WIDGET_IMAGE_SOURCE_ATTRIBUTE)).toBe(false);
    expect(requests[0].options.signal?.aborted).toBe(true);
    respond(requests[0], 'old');
    dom.window.document.body.append(image);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(requests).toHaveLength(1);
    expect(assigned.map(entry => entry.value)).toEqual(['data:image/png;base64,bmV3']);
  });

  it('handles marker changes and removal without restoring a stale source', async () => {
    const { dom, requests, assigned, respond } = fixture(
      `<img ${WIDGET_IMAGE_SOURCE_ATTRIBUTE}="https://assets.example/old.png">`,
    );
    const image = dom.window.document.querySelector('img')!;
    image.setAttribute(WIDGET_IMAGE_SOURCE_ATTRIBUTE, 'https://assets.example/new.png');
    expect(requests).toHaveLength(2);
    expect(requests[0].options.signal?.aborted).toBe(true);
    image.removeAttribute(WIDGET_IMAGE_SOURCE_ATTRIBUTE);
    expect(requests[1].options.signal?.aborted).toBe(true);
    respond(requests[0]);
    respond(requests[1]);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(assigned).toEqual([]);
  });

  it('waits for HTTPS conversion before native decode and reports pending completion', async () => {
    const { dom, requests, respond, nativeDecode, nativeComplete } = fixture();
    nativeComplete.mockReturnValue(true);
    const image = new dom.window.Image();
    image.src = 'https://assets.example/decode.png';
    const decoded = image.decode();
    expect(image.complete).toBe(false);
    expect(nativeComplete).not.toHaveBeenCalled();
    expect(nativeDecode).not.toHaveBeenCalled();
    respond(requests[0]);
    await decoded;
    expect(nativeDecode).toHaveBeenCalledOnce();
    expect(nativeDecode.mock.instances[0]).toBe(image);
    expect(image.complete).toBe(true);
    nativeComplete.mockReturnValue(false);
    expect(image.complete).toBe(false);
  });

  it.each(['decode', 'complete'] as const)(
    'initializes a new static marker through %s before its observer runs',
    async firstRead => {
      const { dom, requests, respond, nativeDecode } = fixture();
      const container = dom.window.document.createElement('div');
      container.innerHTML = `<img ${WIDGET_IMAGE_SOURCE_ATTRIBUTE}="https://assets.example/static-decode.png">`;
      dom.window.document.body.append(container);
      const image = container.querySelector('img')!;
      if (firstRead === 'complete') expect(image.complete).toBe(false);
      const decoded = image.decode();
      expect(requests).toHaveLength(1);
      expect(nativeDecode).not.toHaveBeenCalled();
      respond(requests[0]);
      await decoded;
      expect(requests).toHaveLength(1);
      expect(nativeDecode).toHaveBeenCalledOnce();
    },
  );

  it.each(['fetch', 'conversion'] as const)(
    'rejects decode on %s failure and settles completion without exposing request details',
    async failure => {
      const { dom, requests, nativeDecode } = fixture();
      const image = new dom.window.Image();
      const errors = vi.fn();
      image.addEventListener('error', errors);
      image.src = 'https://assets.example/failure.png';
      const rejected = expect(image.decode()).rejects.toMatchObject({ name: 'EncodingError' });
      if (failure === 'fetch') requests[0].reject(new Error('private-network-detail'));
      else requests[0].resolve({ ok: true, blob: async () => 'not a Blob' });
      await rejected;
      expect(nativeDecode).not.toHaveBeenCalled();
      expect(image.complete).toBe(true);
      expect(errors).toHaveBeenCalledOnce();
    },
  );

  it('preserves native decode failure after conversion and non-HTTPS decode promises', async () => {
    const { dom, requests, respond, nativeDecode } = fixture();
    const image = new dom.window.Image();
    const failure = new dom.window.DOMException('Invalid image bytes', 'EncodingError');
    nativeDecode.mockRejectedValueOnce(failure);
    image.src = 'https://assets.example/invalid.png';
    const rejected = expect(image.decode()).rejects.toBe(failure);
    respond(requests[0]);
    await rejected;
    const nativePromise = Promise.resolve();
    nativeDecode.mockReturnValueOnce(nativePromise);
    image.src = 'data:image/png;base64,cGl4ZWxz';
    expect(image.decode()).toBe(nativePromise);
    expect(nativeDecode).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(1);
  });

  it.each(['https', 'data', 'remove source', 'remove marker'] as const)(
    'rejects an old pending decode immediately on %s without a stale image error',
    async replacement => {
      const { dom, requests, assigned, respond, nativeDecode } = fixture();
      const image = new dom.window.Image();
      const errors = vi.fn();
      image.addEventListener('error', errors);
      if (replacement === 'remove marker')
        image.setAttribute(WIDGET_IMAGE_SOURCE_ATTRIBUTE, 'https://assets.example/old.png');
      else image.src = 'https://assets.example/old.png';
      const rejected = expect(image.decode()).rejects.toMatchObject({ name: 'EncodingError' });
      if (replacement === 'https') image.src = 'https://assets.example/new.png';
      else if (replacement === 'data') image.src = 'data:image/png;base64,bmV3';
      else
        image.removeAttribute(
          replacement === 'remove source' ? 'src' : WIDGET_IMAGE_SOURCE_ATTRIBUTE,
        );
      await rejected;
      expect(requests[0].options.signal?.aborted).toBe(true);
      expect(nativeDecode).not.toHaveBeenCalled();
      if (replacement === 'https') {
        expect(image.complete).toBe(false);
        const decoded = image.decode();
        respond(requests[1], 'new');
        await decoded;
        expect(nativeDecode).toHaveBeenCalledOnce();
      }
      respond(requests[0], 'old');
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(assigned.map(entry => entry.value)).not.toContain('data:image/png;base64,b2xk');
      expect(errors).not.toHaveBeenCalled();
    },
  );
});
