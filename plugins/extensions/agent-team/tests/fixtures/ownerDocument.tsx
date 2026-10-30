import { createContext, useContext } from 'react';

export const OwnerDocumentContext = createContext<Document | null>(null);
export const OwnerDocumentProvider = OwnerDocumentContext.Provider;
export const useOwnerDocument = () => useContext(OwnerDocumentContext) ?? document;
export const useOwnerWindow = () => useOwnerDocument().defaultView ?? window;
