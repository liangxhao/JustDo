import type { OfflineLibraryId } from './schema';

export type OfflineLibraryScript = { id: OfflineLibraryId; scriptId: string };

/** Serialized before the blocking library scripts; resource errors need an ErrorEvent. */
export function installOfflineLibraryBootstrap(scripts: OfflineLibraryScript[]): void {
  const getElement = document.getElementById.bind(document);
  let failed = false;
  const ready = (id: OfflineLibraryId): boolean => {
    const globals = globalThis as typeof globalThis & {
      THREE?: { WebGLRenderer?: unknown; OrbitControls?: unknown };
      echarts?: { init?: unknown };
      katex?: { render?: unknown };
      renderMathInElement?: unknown;
      katexFontsReady?: { then?: unknown };
      mermaid?: { initialize?: unknown; render?: unknown };
      d3?: { select?: unknown; scaleLinear?: unknown };
      Matter?: { Engine?: { create?: unknown }; Render?: { create?: unknown } };
    };
    switch (id) {
      case 'three':
        return (
          typeof globals.THREE?.WebGLRenderer === 'function' &&
          typeof globals.THREE?.OrbitControls === 'function'
        );
      case 'echarts':
        return typeof globals.echarts?.init === 'function';
      case 'katex':
        return (
          typeof globals.katex?.render === 'function' &&
          typeof globals.renderMathInElement === 'function' &&
          typeof globals.katexFontsReady?.then === 'function'
        );
      case 'mermaid':
        return (
          typeof globals.mermaid?.initialize === 'function' &&
          typeof globals.mermaid?.render === 'function'
        );
      case 'd3':
        return (
          typeof globals.d3?.select === 'function' && typeof globals.d3?.scaleLinear === 'function'
        );
      case 'matter':
        return (
          typeof globals.Matter?.Engine?.create === 'function' &&
          typeof globals.Matter?.Render?.create === 'function'
        );
    }
  };
  const fail = (): void => {
    if (failed) return;
    failed = true;
    // Native error reporting uses this fixed message; never expose resource URLs.
    throw new Error('Offline widget library initialization failed');
  };
  const libraryEvent = (event: Event): OfflineLibraryScript | undefined =>
    scripts.find(script => event.target === getElement(script.scriptId));
  window.addEventListener(
    'error',
    event => {
      if (libraryEvent(event)) fail();
    },
    true,
  );
  document.addEventListener(
    'load',
    event => {
      const script = libraryEvent(event);
      if (script && !ready(script.id)) fail();
    },
    true,
  );
}
