import { EventEmitter } from 'node:events';

import { beforeEach, expect, it, vi } from 'vitest';

import {
  WorkspaceSurfaceTarget,
  type WorkspaceSurfaceUpdate,
  WorkspaceWindowIpc,
} from '../../../shared/cowork/workspaceWindow';

const mocks = vi.hoisted(() => ({ instances: [] as unknown[] }));

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class View {
    children: View[] = [];
    bounds = { x: 0, y: 0, width: 900, height: 700 };
    visible = true;
    addChildView(view: View) { this.children.push(view); }
    removeChildView(view: View) { this.children = this.children.filter(child => child !== view); }
    setBounds(bounds: typeof this.bounds) { this.bounds = bounds; }
    getBounds() { return this.bounds; }
    setVisible(visible: boolean) { this.visible = visible; }
  }
  class WebContentsView extends View {
    webContents = Object.assign(new EventEmitter(), {
      id: mocks.instances.length + 100,
      session: new EventEmitter(),
      destroyed: false,
      setBackgroundThrottling: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      setZoomFactor: vi.fn(),
      isDestroyed() { return this.destroyed; },
      close: vi.fn(() => {
        this.webContents.destroyed = true;
        this.webContents.emit('destroyed');
      }),
    });
    constructor() {
      super();
      mocks.instances.push(this);
    }
  }
  return { View, WebContentsView };
});

import { View } from 'electron';

import { WorkspaceSurfaceManager } from './workspaceSurfaceManager';

type NativeView = View & {
  visible: boolean;
  bounds: { x: number; y: number; width: number; height: number };
};
type Carrier = NativeView & {
  webContents: EventEmitter & {
    id: number;
    close: ReturnType<typeof vi.fn>;
    isDestroyed: () => boolean;
    setWindowOpenHandler: ReturnType<typeof vi.fn>;
    session: EventEmitter;
  };
};

beforeEach(() => { mocks.instances.length = 0; });

function fixture() {
  const owner = {
    isDestroyed: () => false,
    getContentSize: () => [800, 600],
    contentView: new View(),
    webContents: { getZoomFactor: () => 1.25, isDestroyed: () => false, send: vi.fn() },
  };
  let workspace: { generation: string; root: View; window: typeof owner } | undefined;
  const configureHost = vi.fn();
  const manager = new WorkspaceSurfaceManager(owner as never, {
    url: 'http://127.0.0.1:1234/workspace.html',
    configureHost,
    workspace: () => workspace as never,
  });
  const grant = manager.prepare()!;
  const details = { url: grant.url, frameName: grant.frameName };
  const open = () => {
    const response = manager.handleOpen(details as never)!;
    expect(response.action).toBe('allow');
    if (response.action !== 'allow' || !response.createWindow) throw new Error('Missing carrier');
    response.createWindow({});
    return mocks.instances.at(-1) as Carrier;
  };
  const update: WorkspaceSurfaceUpdate = {
    id: grant.id,
    target: WorkspaceSurfaceTarget.Main,
    x: 10, y: -80, width: 300, height: 500,
    clip: { x: 10, y: 40, width: 300, height: 320 },
    visible: true, occluded: false,
  };
  return { owner, configureHost, manager, grant, details, open, update,
    setWorkspace: (next: typeof workspace) => { workspace = next; } };
}

it('requires the exact one-use passive document grant and never inherits a privileged preload', () => {
  const f = fixture();
  for (const wrong of [
    { ...f.details, url: `${f.details.url}&extra=1` },
    { ...f.details, frameName: 'unowned' },
    { ...f.details, postBody: { data: [] } },
  ]) expect(f.manager.handleOpen(wrong as never)).toBeNull();
  const response = f.manager.handleOpen(f.details as never)!;
  expect(response).toMatchObject({
    overrideBrowserWindowOptions: { webPreferences: {
      preload: undefined, nodeIntegration: false, contextIsolation: true, sandbox: true,
    } },
  });
  expect(f.manager.handleOpen(f.details as never)).toBeNull();
  if (response.action !== 'allow' || !response.createWindow) throw new Error('Missing carrier');
  response.createWindow({});
  const carrier = mocks.instances[0] as Carrier;
  expect(f.configureHost).toHaveBeenCalledExactlyOnceWith(carrier.webContents);
  expect(carrier.webContents.setWindowOpenHandler.mock.calls[0][0]({})).toEqual({ action: 'deny' });
  const preventDefault = vi.fn();
  carrier.webContents.emit('will-navigate', { url: 'https://outside.example', preventDefault });
  carrier.webContents.emit('did-finish-load');
  carrier.webContents.emit('will-navigate', { url: f.grant.url, preventDefault });
  expect(preventDefault).toHaveBeenCalledTimes(2);
  const download = { preventDefault: vi.fn() };
  carrier.webContents.session.emit('will-download', download, {}, {});
  expect(download.preventDefault).not.toHaveBeenCalled();
  carrier.webContents.session.emit('will-download', download, {}, carrier.webContents);
  expect(download.preventDefault).toHaveBeenCalledOnce();
});

it('clips native drawing without shrinking the carrier viewport or changing the content instance', () => {
  const f = fixture();
  const carrier = f.open();
  f.manager.update(f.update);
  const group = f.owner.contentView.children[0] as NativeView;
  expect(group.bounds).toEqual({ x: 13, y: 50, width: 375, height: 400 });
  expect(carrier.bounds).toEqual({ x: 0, y: -150, width: 375, height: 625 });
  expect(group.visible).toBe(true);
  f.manager.update({ ...f.update, width: NaN });
  f.manager.update({ ...f.update, clip: { ...f.update.clip, height: -1 } });
  expect(group.visible).toBe(true);
  f.manager.update({ ...f.update, occluded: true });
  expect(group.visible).toBe(false);
  f.manager.update(f.update);
  expect(group.children).toEqual([carrier]);
  expect(carrier.webContents.close).not.toHaveBeenCalled();
});

it('joins the workspace group only for its current generation and retains the carrier through workspace loss', () => {
  const f = fixture();
  const carrier = f.open();
  const root = new View();
  f.setWorkspace({ generation: 'current', root, window: f.owner });
  const update = { ...f.update, target: WorkspaceSurfaceTarget.Workspace, workspaceGeneration: 'current' };
  f.manager.update({ ...update, workspaceGeneration: 'stale' });
  expect(root.children).toHaveLength(0);
  f.manager.update(update);
  const group = root.children[0] as NativeView;
  expect(group.children).toEqual([carrier]);
  f.manager.update({ ...f.update, id: 'another-owner' });
  expect(root.children).toEqual([group]);
  f.setWorkspace(undefined);
  f.manager.suspendWorkspace();
  expect(root.children).toHaveLength(0);
  expect(group.visible).toBe(false);
  expect(carrier.webContents.close).not.toHaveBeenCalled();
  const replacement = new View();
  f.setWorkspace({ generation: 'replacement', root: replacement, window: f.owner });
  f.manager.applyLayout();
  expect(replacement.children).toHaveLength(0);
  f.manager.update({ ...update, workspaceGeneration: 'replacement' });
  expect(replacement.children).toEqual([group]);
  expect(group.children).toEqual([carrier]);
  f.manager.update(f.update);
  expect(replacement.children).toHaveLength(0);
  expect(f.owner.contentView.children).toEqual([group]);
});

it('invalidates a crashed owned surface once and explicit close never publishes a crash', () => {
  const f = fixture();
  const carrier = f.open();
  f.manager.update(f.update);
  f.manager.close('unknown');
  expect(carrier.webContents.close).not.toHaveBeenCalled();
  carrier.webContents.emit('render-process-gone');
  expect(f.owner.webContents.send).toHaveBeenCalledExactlyOnceWith(
    WorkspaceWindowIpc.SurfaceInvalidated, { id: f.grant.id },
  );
  expect(f.owner.contentView.children).toHaveLength(0);
  expect(f.manager.handleOpen(f.details as never)).toBeNull();
  f.manager.closeAll();
  expect(f.owner.webContents.send).toHaveBeenCalledOnce();
  const next = fixture();
  const nextCarrier = next.open();
  next.manager.close(next.grant.id);
  expect(nextCarrier.webContents.close).toHaveBeenCalledOnce();
  expect(next.owner.webContents.send).not.toHaveBeenCalled();
});
