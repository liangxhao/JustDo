export const WIDGET_IMAGE_SOURCE_ATTRIBUTE = 'data-widget-asset-src';

/** Serialized before authored code; downloads keep the document's native permissions. */
export function installWidgetImageLoading(): void {
  const imagePrototype = HTMLImageElement.prototype;
  const installed = Symbol.for('widget-kit.image-loading');
  if (Object.prototype.hasOwnProperty.call(imagePrototype, installed)) return;
  const source = Object.getOwnPropertyDescriptor(imagePrototype, 'src');
  if (!source?.set) return;
  Object.defineProperty(imagePrototype, installed, { value: true });

  // Keep this literal inside the serialized function rather than closing over it.
  const marker = 'data-widget-asset-src';
  const ImageElement = HTMLImageElement;
  const nativeSource = source.set;
  const nativeDecode = imagePrototype.decode;
  const complete = Object.getOwnPropertyDescriptor(imagePrototype, 'complete');
  const getAttribute = Element.prototype.getAttribute;
  const setAttribute = Element.prototype.setAttribute;
  const removeAttribute = Element.prototype.removeAttribute;
  const dispatch = EventTarget.prototype.dispatchEvent;
  const ImageEvent = Event;
  const ImageReader = FileReader;
  const ImageRequest = AbortController;
  const ImageUrl = URL;
  const fetchImage = globalThis.fetch?.bind(globalThis);
  const decodeError = (): DOMException =>
    new DOMException('The source image cannot be decoded.', 'EncodingError');
  type Loading = {
    request?: AbortController;
    reader?: FileReader;
    staticSource?: string;
    ready?: Promise<void>;
  };
  const loading = new WeakMap<HTMLImageElement, Loading>();

  const replace = (image: HTMLImageElement): Loading => {
    const previous = loading.get(image);
    const current: Loading = {};
    // Invalidate first: abort can synchronously invoke a FileReader listener.
    loading.set(image, current);
    previous?.request?.abort();
    previous?.reader?.abort();
    return current;
  };
  const assign = (image: HTMLImageElement, value: string, fromMarker = false): void => {
    const current = replace(image);
    if (fromMarker) current.staticSource = value;
    else removeAttribute.call(image, marker);
    let url: URL | undefined;
    try {
      url = new ImageUrl(value, document.baseURI);
    } catch {
      /* Let the native setter handle malformed and non-network sources. */
    }
    if (url?.protocol !== 'https:') {
      nativeSource.call(image, value);
      if (fromMarker) removeAttribute.call(image, marker);
      return;
    }

    // The remote URL must never reach img-src. Its existing connect-src grant,
    // CORS and Main's anonymous proxy path still decide whether fetch succeeds.
    removeAttribute.call(image, 'src');
    const request = new ImageRequest();
    current.request = request;
    const requestUrl = url.href;
    const active = (): boolean => loading.get(image) === current && !request.signal.aborted;
    current.ready = new Promise<void>((resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(decodeError()), { once: true });
      void (async () => {
        if (!fetchImage) throw new Error('Widget image request unavailable');
        const response = await fetchImage(requestUrl, {
          credentials: 'omit',
          signal: request.signal,
        });
        if (!active()) return;
        if (!response.ok) throw new Error('Widget image request failed');
        const blob = await response.blob();
        if (!active()) return;
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new ImageReader();
          current.reader = reader;
          reader.onload = () => {
            if (typeof reader.result === 'string') resolve(reader.result);
            else reject(new Error('Widget image decoding failed'));
          };
          reader.onerror = reader.onabort = () => reject(new Error('Widget image decoding failed'));
          reader.readAsDataURL(blob);
        });
        if (!active()) return;
        nativeSource.call(image, dataUrl);
        if (fromMarker && getAttribute.call(image, marker) === value)
          removeAttribute.call(image, marker);
      })().then(resolve, reject);
    });
    void current.ready
      .finally(() => {
        current.ready = undefined;
        current.request = undefined;
        current.reader = undefined;
      })
      .catch(() => {
        // ImageLoader/TextureLoader use this event to settle their own manager.
        // Successful loads are dispatched exclusively by the native image loader.
        if (active()) dispatch.call(image, new ImageEvent('error'));
      });
  };

  Object.defineProperty(imagePrototype, 'src', {
    ...source,
    set(this: HTMLImageElement, value: string) {
      assign(this, `${value}`);
    },
  });
  Object.defineProperty(Element.prototype, 'setAttribute', {
    ...Object.getOwnPropertyDescriptor(Element.prototype, 'setAttribute'),
    value(this: Element, name: string, value: string): void {
      const attribute = `${name}`;
      if (this instanceof ImageElement && attribute.toLowerCase() === 'src')
        assign(this, `${value}`);
      else {
        setAttribute.call(this, attribute, value);
        if (this instanceof ImageElement && attribute.toLowerCase() === marker)
          assign(this, `${value}`, true);
      }
    },
  });
  Object.defineProperty(Element.prototype, 'removeAttribute', {
    ...Object.getOwnPropertyDescriptor(Element.prototype, 'removeAttribute'),
    value(this: Element, name: string): void {
      const attribute = `${name}`;
      if (this instanceof ImageElement && attribute.toLowerCase() === 'src') {
        replace(this);
        removeAttribute.call(this, marker);
      } else if (this instanceof ImageElement && attribute.toLowerCase() === marker) replace(this);
      removeAttribute.call(this, attribute);
    },
  });

  const restore = (image: HTMLImageElement): void => {
    const value = getAttribute.call(image, marker);
    if (value !== null && loading.get(image)?.staticSource !== value) assign(image, value, true);
  };
  if (typeof nativeDecode === 'function')
    Object.defineProperty(imagePrototype, 'decode', {
      ...Object.getOwnPropertyDescriptor(imagePrototype, 'decode'),
      value(this: HTMLImageElement): Promise<void> {
        restore(this);
        const current = loading.get(this);
        if (!current?.ready) return nativeDecode.call(this);
        return current.ready.then(
          () => {
            if (loading.get(this) !== current) throw decodeError();
            return nativeDecode.call(this);
          },
          () => {
            throw decodeError();
          },
        );
      },
    });
  if (complete?.get)
    Object.defineProperty(imagePrototype, 'complete', {
      ...complete,
      get(this: HTMLImageElement): boolean {
        restore(this);
        return loading.get(this)?.ready ? false : complete.get!.call(this);
      },
    });
  const scan = (node: Node): void => {
    if (!(node instanceof Element)) return;
    if (node instanceof ImageElement) restore(node);
    node.querySelectorAll<HTMLImageElement>(`img[${marker}]`).forEach(restore);
  };
  document.querySelectorAll<HTMLImageElement>(`img[${marker}]`).forEach(restore);
  new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') scan(record.target);
      else record.addedNodes.forEach(scan);
    }
  }).observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [marker],
  });
}
