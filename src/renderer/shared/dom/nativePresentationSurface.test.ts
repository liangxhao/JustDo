// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';

import { NativePresentationSurface } from './nativePresentationSurface';

const surfaces: NativePresentationSurface[] = [];
afterEach(() => {
  surfaces.splice(0).forEach(surface => surface.dispose());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture() {
  const carrier = document.createElement('iframe');
  document.body.append(carrier);
  const doc = carrier.contentDocument!;
  const grant = {
    id: 'receipt',
    url: `${location.origin}/workspace.html?surface=receipt`,
    frameName: 'surface-receipt',
  };
  Object.defineProperty(doc, 'URL', { configurable: true, value: grant.url });
  const root = doc.createElement('div');
  root.id = 'workspace-root';
  doc.body.append(root);
  const layer = document.createElement('div');
  const viewer = document.createElement('div');
  layer.append(viewer);
  const updateSurface = vi.fn();
  const closeSurface = vi.fn();
  let invalidate: (value: { id: string }) => void = () => undefined;
  const prepareSurface = vi.fn().mockResolvedValue(grant);
  vi.stubGlobal('electron', {
    workspaceWindow: {
      prepareSurface,
      updateSurface,
      closeSurface,
      onSurfaceInvalidated: (listener: typeof invalidate) => {
        invalidate = listener;
        return vi.fn();
      },
    },
  });
  const open = vi.spyOn(window, 'open').mockReturnValue(carrier.contentWindow!);
  const changed = vi.fn();
  const create = () => {
    const surface = NativePresentationSurface.create(layer, changed)!;
    surfaces.push(surface);
    return surface;
  };
  const layout = {
    x: 10,
    y: 20,
    width: 400,
    height: 300,
    clip: { x: 10, y: 40, width: 400, height: 280 },
    visible: true,
    occluded: false,
  };
  return {
    grant,
    doc,
    root,
    layer,
    viewer,
    create,
    changed,
    open,
    updateSurface,
    closeSurface,
    prepareSurface,
    layout,
    invalidate: (id = grant.id) => invalidate({ id }),
  };
}

test('creates the viewer only in its granted document and changes presentation without adopting it again', async () => {
  const f = fixture();
  const surface = f.create();
  expect(f.viewer.isConnected).toBe(false);
  await Promise.resolve();
  expect(surface.ready).toBe(true);
  expect(f.open).toHaveBeenCalledExactlyOnceWith(f.grant.url, f.grant.frameName);
  expect(f.viewer.ownerDocument).toBe(f.doc);
  expect(f.layer.parentElement).toBe(f.root);
  const mainTarget = document.createElement('div');
  document.body.append(mainTarget);
  surface.present(mainTarget, f.layout);
  expect(f.updateSurface).toHaveBeenLastCalledWith({ ...f.layout, id: 'receipt', target: 'main' });

  const workspace = document.createElement('iframe');
  document.body.append(workspace);
  Object.defineProperty(workspace.contentDocument!, 'URL', {
    configurable: true,
    value: `${location.origin}/workspace.html?generation=current`,
  });
  const target = workspace.contentDocument!.createElement('div');
  workspace.contentDocument!.body.append(target);
  surface.present(target, f.layout);
  expect(f.updateSurface).toHaveBeenLastCalledWith({
    ...f.layout,
    id: 'receipt',
    target: 'workspace',
    workspaceGeneration: 'current',
  });
  surface.present(target, f.layout);
  expect(f.updateSurface).toHaveBeenCalledTimes(2);
  surface.hide();
  expect(f.updateSurface.mock.lastCall?.[0].visible).toBe(false);
  surface.present(mainTarget, f.layout);
  expect(f.viewer.ownerDocument).toBe(f.doc);
  expect(f.layer.parentElement).toBe(f.root);
  expect(f.prepareSurface).toHaveBeenCalledTimes(1);
});

test('late grants close their own receipt without mounting after disposal', async () => {
  const f = fixture();
  const surface = f.create();
  surface.dispose();
  await Promise.resolve();
  expect(f.open).not.toHaveBeenCalled();
  expect(f.viewer.isConnected).toBe(false);
  expect(f.closeSurface).toHaveBeenCalledExactlyOnceWith(f.grant.id);
});

test('only the current carrier failure disconnects the viewer and never silently recreates it', async () => {
  const f = fixture();
  const surface = f.create();
  await Promise.resolve();
  f.invalidate('stale-receipt');
  expect(f.viewer.isConnected).toBe(true);
  f.invalidate();
  expect(surface.failed).toBe(true);
  expect(surface.ready).toBe(false);
  expect(f.viewer.isConnected).toBe(false);
  expect(f.closeSurface).toHaveBeenCalledExactlyOnceWith(f.grant.id);
  await Promise.resolve();
  expect(f.prepareSurface).toHaveBeenCalledTimes(1);
});

test('invalidation while booting cancels late mounting until an explicit retry', async () => {
  const f = fixture();
  f.root.remove();
  const surface = f.create();
  await Promise.resolve();
  expect(surface.ready).toBe(false);
  f.invalidate();
  f.doc.body.append(f.root);
  await new Promise(resolve => setTimeout(resolve, 35));
  expect(surface.failed).toBe(true);
  expect(f.viewer.isConnected).toBe(false);
  expect(f.prepareSurface).toHaveBeenCalledTimes(1);
});
