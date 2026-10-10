import { useSyncExternalStore } from 'react';

export type DockedWorkspaceSurface = {
  document: Document;
  x: number;
  y: number;
};

let surface: DockedWorkspaceSurface | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** Main owns overlay state and coordinates; its docked native view only paints a projection. */
export const setDockedWorkspaceSurface = (next: DockedWorkspaceSurface | null): void => {
  if (surface?.document === next?.document && surface?.x === next?.x && surface?.y === next?.y) return;
  surface = next;
  listeners.forEach(listener => listener());
};

export const useDockedWorkspaceSurface = (): DockedWorkspaceSurface | null =>
  useSyncExternalStore(subscribe, () => surface);
