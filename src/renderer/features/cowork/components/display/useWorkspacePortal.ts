import {
  type WorkspaceNativeWindowState,
  WorkspaceWindowControl,
  type WorkspaceWindowGrant,
} from '@shared/cowork/workspaceWindow';
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { setDockedWorkspaceSurface } from '@/app/shell/dockedWorkspaceSurface';
import { setWorkspaceNotificationDocument } from '@/app/shell/WorkspaceNotifications';
import { i18nService } from '@/services/i18n';

export const WORKSPACE_PRESENTATION_EVENT = 'cowork:workspace-presentation-changed';

export const workspaceKeyboardDocument = new WeakMap<Event, Document>();

const readOcclusion = (rect: DOMRect) => {
  const blocked = Array.from(document.querySelectorAll('[data-workspace-overlay="true"]')).some(
    overlay => overlay.getClientRects().length > 0,
  );
  const occluded =
    blocked ||
    Array.from(
      document.querySelectorAll(
        '[role="menu"], [role="listbox"], [role="tooltip"], [data-workspace-occlusion="true"]',
      ),
    ).some(element => {
      if (!element.getClientRects().length) return false;
      const popup = element.getBoundingClientRect();
      return (
        popup.right > rect.left &&
        popup.left < rect.right &&
        popup.bottom > rect.top &&
        popup.top < rect.bottom
      );
    });
  return { blocked, occluded };
};

const copyAppearance = (target: Document): (() => void) => {
  const copies = new Map<Element, Element>();
  const sync = () => {
    const sources = new Set(document.head.querySelectorAll('style, link[rel="stylesheet"]'));
    for (const [source, copy] of copies) {
      if (!sources.has(source)) {
        copy.remove();
        copies.delete(source);
      }
    }
    for (const source of sources) {
      let copy = copies.get(source);
      if (!copy) {
        copy = target.importNode(source, true);
        if (source.tagName === 'LINK')
          (copy as HTMLLinkElement).href = (source as HTMLLinkElement).href;
        target.head.appendChild(copy);
        copies.set(source, copy);
      }
      if (source.tagName === 'STYLE') {
        const sheet = (source as HTMLStyleElement).sheet;
        copy.textContent = sheet
          ? Array.from(sheet.cssRules, rule => rule.cssText).join('\n')
          : source.textContent;
      }
    }
    target.documentElement.className = document.documentElement.className;
    target.documentElement.style.cssText = document.documentElement.style.cssText;
    target.documentElement.lang = document.documentElement.lang;
    target.documentElement.dir = document.documentElement.dir;
    // Theme tokens and appearance switches are selected by root data attributes.
    for (const attribute of Array.from(target.documentElement.attributes)) {
      if (
        attribute.name.startsWith('data-') &&
        !document.documentElement.hasAttribute(attribute.name)
      ) {
        target.documentElement.removeAttribute(attribute.name);
      }
    }
    for (const attribute of Array.from(document.documentElement.attributes)) {
      if (attribute.name.startsWith('data-')) {
        target.documentElement.setAttribute(attribute.name, attribute.value);
      }
    }
  };
  sync();
  const observer = new MutationObserver(sync);
  observer.observe(document.head, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
  });
  observer.observe(document.documentElement, { attributes: true });
  return () => {
    observer.disconnect();
    copies.forEach(copy => copy.remove());
  };
};

/** The portal target never changes during presentation moves. Only its native view moves. */
export function useWorkspacePortal(slot: RefObject<HTMLElement>, open: boolean) {
  const api = window.electron?.workspaceWindow;
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [detached, setDetached] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [failed, setFailed] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [hostVersion, setHostVersion] = useState(0);
  const restoreDetachedRef = useRef(false);
  const grantRef = useRef<WorkspaceWindowGrant | null>(null);
  const latestRef = useRef({ open, detached });
  latestRef.current = { open, detached };
  const transitionRef = useRef(false);

  const windowControls = useMemo<Window['electron']['window'] | undefined>(() => {
    const generation = grantRef.current?.generation;
    if (!api || !target || !generation) return undefined;
    return {
      minimize: () => api.control(generation, WorkspaceWindowControl.Minimize),
      toggleMaximize: () => api.control(generation, WorkspaceWindowControl.ToggleMaximize),
      close: () => api.control(generation, WorkspaceWindowControl.Close),
      showSystemMenu: position =>
        api.control(generation, WorkspaceWindowControl.ShowSystemMenu, position),
      isMaximized: async () => (await api.getWindowState(generation))?.isMaximized ?? false,
      onStateChanged: (callback: (state: WorkspaceNativeWindowState) => void) =>
        api.onStateChanged(state => {
          if (state.generation === generation && state.windowState) callback(state.windowState);
        }),
    };
  }, [api, target]);

  const publishDetached = useCallback((value: boolean) => {
    setDetached(value);
    window.dispatchEvent(new CustomEvent(WORKSPACE_PRESENTATION_EVENT, { detail: value }));
  }, []);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    let cleanupAppearance: (() => void) | undefined;
    let cleanupKeyboard: (() => void) | undefined;
    let retryTimer: number | undefined;
    const unsubscribe = api.onStateChanged(state => {
      if (state.generation === grantRef.current?.generation) publishDetached(state.detached);
    });
    const unsubscribeInvalidation = api.onInvalidated(state => {
      if (state.generation !== grantRef.current?.generation) return;
      restoreDetachedRef.current = state.detached;
      grantRef.current = null;
      setTarget(null);
      setFailed(false);
      publishDetached(false);
      setHostVersion(version => version + 1);
      window.dispatchEvent(
        new CustomEvent('app:showToast', { detail: i18nService.t('coworkDisplayWindowRecovered') }),
      );
    });
    void api
      .prepare()
      .then(grant => {
        if (cancelled) return;
        if (!grant) throw new Error('Workspace owner is unavailable');
        grantRef.current = grant;
        const host = window.open(grant.existing ? '' : grant.url, grant.frameName);
        if (!host) throw new Error('Workspace document was not created');
        let attempts = 0;
        const ready = () => {
          if (cancelled) return;
          let root: HTMLElement | null = null;
          try {
            root = host.document.getElementById('workspace-root');
          } catch {
            /* Initial navigation. */
          }
          if (!root) {
            if (++attempts > 250) {
              setFailed(true);
              return;
            }
            retryTimer = window.setTimeout(ready, 20);
            return;
          }
          const targetDocument = root.ownerDocument;
          cleanupAppearance = copyAppearance(targetDocument);
          const keydown = (event: KeyboardEvent) => {
            if (event.defaultPrevented || event.isComposing) return;
            const forwarded = new KeyboardEvent('keydown', {
              key: event.key,
              code: event.code,
              altKey: event.altKey,
              ctrlKey: event.ctrlKey,
              metaKey: event.metaKey,
              shiftKey: event.shiftKey,
              repeat: event.repeat,
              bubbles: true,
              cancelable: true,
            });
            workspaceKeyboardDocument.set(forwarded, targetDocument);
            document.dispatchEvent(forwarded);
            if (forwarded.defaultPrevented) event.preventDefault();
          };
          targetDocument.addEventListener('keydown', keydown);
          cleanupKeyboard = () => targetDocument.removeEventListener('keydown', keydown);
          publishDetached(grant.detached);
          setTarget(root);
          if (restoreDetachedRef.current) {
            restoreDetachedRef.current = false;
            void api
              .setDetached(grant.generation, true)
              .then(result => {
                if (
                  !cancelled &&
                  result.success &&
                  result.state.generation === grantRef.current?.generation
                ) {
                  publishDetached(result.state.detached);
                }
              })
              .catch(() => undefined);
          }
        };
        ready();
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      cleanupKeyboard?.();
      cleanupAppearance?.();
      unsubscribe();
      unsubscribeInvalidation();
      const grant = grantRef.current;
      if (grant)
        api.update({
          generation: grant.generation,
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          visible: false,
          occluded: false,
        });
    };
  }, [api, publishDetached, hostVersion]);

  useEffect(() => {
    if (!api || !target) return;
    let frame: number | null = null;
    const update = () => {
      frame = null;
      const grant = grantRef.current;
      const element = slot.current;
      if (!grant || !element) return;
      const rect = element.getBoundingClientRect();
      const { blocked, occluded } = readOcclusion(rect);
      setBlocked(blocked);
      const latest = latestRef.current;
      setWorkspaceNotificationDocument(
        !blocked &&
          (latest.detached || (!occluded && latest.open && element.getClientRects().length > 0))
          ? target.ownerDocument
          : null,
      );
      setDockedWorkspaceSurface(
        !latest.detached && !occluded && latest.open && element.getClientRects().length > 0
          ? { document: target.ownerDocument, x: Math.max(0, rect.x), y: Math.max(0, rect.y) }
          : null,
      );
      api.update({
        generation: grant.generation,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        visible: latest.open && element.getClientRects().length > 0,
        occluded,
      });
    };
    // Main's compositor can stop RAF while minimized even though the detached
    // surface remains visible. Keep geometry/blocking updates independent of it.
    const schedule = () => {
      if (frame === null) frame = window.setTimeout(update, 16);
    };
    const resize = new ResizeObserver(schedule);
    if (slot.current) {
      resize.observe(slot.current);
      if (slot.current.parentElement) resize.observe(slot.current.parentElement);
    }
    const mutation = new MutationObserver(schedule);
    mutation.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ['class', 'style', 'data-workspace-overlay'],
    });
    window.addEventListener('resize', schedule);
    const targetWindow = target.ownerDocument.defaultView;
    targetWindow?.addEventListener('resize', schedule);
    update();
    return () => {
      setWorkspaceNotificationDocument(null);
      setDockedWorkspaceSurface(null);
      resize.disconnect();
      mutation.disconnect();
      window.removeEventListener('resize', schedule);
      targetWindow?.removeEventListener('resize', schedule);
      if (frame !== null) window.clearTimeout(frame);
    };
  }, [api, target, slot]);

  useEffect(() => {
    const grant = grantRef.current;
    const element = slot.current;
    if (!api || !grant || !element) return;
    const rect = element.getBoundingClientRect();
    const { blocked: currentBlocked, occluded } = readOcclusion(rect);
    api.update({
      generation: grant.generation,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      visible: open && element.getClientRects().length > 0,
      occluded,
    });
    setWorkspaceNotificationDocument(
      !currentBlocked && (detached || (!occluded && open && element.getClientRects().length > 0))
        ? (target?.ownerDocument ?? null)
        : null,
    );
    setDockedWorkspaceSurface(
      target && !detached && !occluded && open && element.getClientRects().length > 0
        ? { document: target.ownerDocument, x: Math.max(0, rect.x), y: Math.max(0, rect.y) }
        : null,
    );
  }, [api, open, detached, blocked, slot, target]);

  useEffect(() => {
    if (!target || !detached || !blocked) return;
    // Menus may portal into body outside the workspace content's inert subtree.
    const body = target.ownerDocument.body;
    const previous = new Map<HTMLElement, boolean>();
    const blockPortals = () => {
      for (const child of Array.from(body.children)) {
        if (child === target || child.nodeType !== 1) continue;
        const element = child as HTMLElement;
        if (!previous.has(element)) previous.set(element, element.inert);
        element.inert = true;
      }
    };
    blockPortals();
    const observer = new MutationObserver(blockPortals);
    observer.observe(body, { childList: true });
    return () => {
      observer.disconnect();
      previous.forEach((inert, element) => {
        element.inert = inert;
      });
    };
  }, [target, detached, blocked]);

  const toggleDetached = useCallback(async () => {
    const grant = grantRef.current;
    if (!api || !grant || transitionRef.current) return;
    transitionRef.current = true;
    setTransitioning(true);
    try {
      const result = await api.setDetached(grant.generation, !latestRef.current.detached);
      if (!result.success || result.state.generation !== grantRef.current?.generation)
        throw new Error('Workspace presentation rejected');
      publishDetached(result.state.detached);
    } catch {
      window.dispatchEvent(
        new CustomEvent('app:showToast', { detail: i18nService.t('coworkDisplayWindowFailed') }),
      );
    } finally {
      transitionRef.current = false;
      setTransitioning(false);
    }
  }, [api, publishDetached]);

  return {
    native: !!api && !failed,
    target,
    detached,
    blocked,
    transitioning,
    windowControls,
    toggleDetached,
    focusMain: () => api?.focusMain(),
  };
}
