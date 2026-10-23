import type { WorkspaceWindowGrant } from '@shared/cowork/workspaceWindow';
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { observeChatContentWidth } from '@/app/chatContentWidth';
import { setDockedWorkspaceSurface } from '@/app/shell/dockedWorkspaceSurface';
import { setWorkspaceNotificationDocument } from '@/app/shell/WorkspaceNotifications';
import { i18nService } from '@/services/i18n';
import { copyDocumentAppearance } from '@/shared/dom/copyDocumentAppearance';
import { forwardSurfaceKeyboard } from '@/shared/dom/surfaceKeyboard';
import { registerWorkspacePresentation } from '@/shared/dom/workspacePresentation';

import { readWorkspaceOcclusion as readOcclusion } from './workspaceOcclusion';
import { createWorkspaceWindowControls } from './workspaceWindowControls';

export const WORKSPACE_PRESENTATION_EVENT = 'cowork:workspace-presentation-changed';

export { surfaceKeyboardDocument as workspaceKeyboardDocument } from '@/shared/dom/surfaceKeyboard';

const copyAppearance = (target: Document, controls: Window['electron']['window']): (() => void) => {
  const widthObserver = observeChatContentWidth(target.documentElement, controls);
  const cleanup = copyDocumentAppearance(document, target, () => widthObserver.update());
  return () => {
    cleanup();
    widthObserver.dispose();
  };
};

/** The portal target never changes during presentation moves. Only its native view moves. */
export function useWorkspacePortal(slot: RefObject<HTMLElement>, open: boolean, enabled = true) {
  const api = enabled ? window.electron?.workspaceWindow : undefined;
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
  useEffect(() => {
    if (!target) return;
    return registerWorkspacePresentation(target.ownerDocument, () => ({
      ...latestRef.current,
      slot: slot.current,
    }));
  }, [target, slot]);

  const windowControls = useMemo<Window['electron']['window'] | undefined>(() => {
    const generation = grantRef.current?.generation;
    if (!api || !target || !generation) return undefined;
    return createWorkspaceWindowControls(api, generation);
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
          cleanupAppearance = copyAppearance(
            targetDocument,
            createWorkspaceWindowControls(api, grant.generation),
          );
          const keydown = (event: KeyboardEvent) =>
            forwardSurfaceKeyboard(event, targetDocument, document);
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
      // Native visibility alone does not revoke a retained viewer's bridge.
      // Mirror presentation admission into the owning document as well.
      target.inert =
        blocked ||
        (!latest.detached && (!latest.open || occluded || element.getClientRects().length === 0));
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
    if (target)
      target.inert =
        currentBlocked ||
        (!detached && (!open || occluded || element.getClientRects().length === 0));
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
