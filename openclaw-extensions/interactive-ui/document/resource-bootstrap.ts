/** Fixed bootstrap serialized inline; all executable helpers stay inside. */
export function widgetResourceBootstrap(settings: {
  rootId: string;
  rendererId: string;
  unavailable: string;
}): void {
  const root = document.getElementById(settings.rootId);
  let failed = false;
  const isRenderer = (event: Event): boolean =>
    event.target === document.getElementById(settings.rendererId);
  const fail = (): void => {
    if (failed) return;
    failed = true;
    if (root) {
      const notice = document.createElement('p');
      notice.className = 'ui-error';
      notice.setAttribute('role', 'alert');
      notice.textContent = settings.unavailable;
      root.replaceChildren(notice);
    }
    // Resource ErrorEvents have no message/error for the existing native bridge.
    // Emit only this fixed error, never a URL or underlying response content.
    throw new Error('interactive-ui renderer initialization failed');
  };
  window.addEventListener(
    'error',
    event => {
      if (isRenderer(event)) fail();
    },
    true,
  );
  document.addEventListener(
    'load',
    event => {
      if (isRenderer(event) && root?.getAttribute('data-interactive-ui-ready') !== 'true') fail();
    },
    true,
  );
}
