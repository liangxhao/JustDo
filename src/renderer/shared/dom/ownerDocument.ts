import { createContext, useContext } from 'react';

/** DOM operations follow their surface; application IPC/events stay in the source window. */
export const OwnerDocumentContext = createContext<Document | null>(null);

export const useOwnerDocument = (): Document => useContext(OwnerDocumentContext) ?? document;

export const useOwnerWindow = (): Window & typeof globalThis =>
  (useOwnerDocument().defaultView ?? window) as Window & typeof globalThis;

export const isDomNode = (value: unknown): value is Node =>
  !!value && typeof value === 'object' && typeof (value as Node).nodeType === 'number';

export const isDomElement = (value: unknown): value is Element =>
  isDomNode(value) && value.nodeType === 1;

export const isDomHTMLElement = (value: unknown): value is HTMLElement =>
  isDomElement(value) && typeof (value as HTMLElement).focus === 'function';
