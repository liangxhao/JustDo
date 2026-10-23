import { randomUUID } from 'crypto';
import { type BrowserWindow, View, WebContentsView } from 'electron';

import {
  type WorkspaceSurfaceGrant,
  WorkspaceSurfaceTarget,
  type WorkspaceSurfaceUpdate,
  WorkspaceWindowIpc,
} from '../../../shared/cowork/workspaceWindow';

type WorkspaceSurfaceOptions = {
  url: string;
  configureHost: (host: Electron.WebContents) => void;
  workspace: () => { generation: string; root: View; window: BrowserWindow } | undefined;
};

type Surface = {
  grant: WorkspaceSurfaceGrant;
  granted: boolean;
  group?: View;
  view?: WebContentsView;
  parent?: View;
  update?: WorkspaceSurfaceUpdate;
};

const downloadGuards = new WeakMap<Electron.Session, {
  contents: Set<Electron.WebContents>;
  listener: (event: Electron.Event, item: Electron.DownloadItem, source: Electron.WebContents) => void;
}>();

function guardDownloads(contents: Electron.WebContents): void {
  const session = contents.session;
  let guard = downloadGuards.get(session);
  if (!guard) {
    const owners = new Set<Electron.WebContents>();
    const listener = (event: Electron.Event, _item: Electron.DownloadItem, source: Electron.WebContents) => {
      if (owners.has(source)) event.preventDefault();
    };
    guard = { contents: owners, listener };
    downloadGuards.set(session, guard);
    session.on('will-download', listener);
  }
  const current = guard;
  current.contents.add(contents);
  contents.once('destroyed', () => {
    current.contents.delete(contents);
    if (!current.contents.size) {
      session.removeListener('will-download', current.listener);
      downloadGuards.delete(session);
    }
  });
}

const validBounds = (value: unknown): value is WorkspaceSurfaceUpdate['clip'] => {
  if (!value || typeof value !== 'object') return false;
  const bounds = value as WorkspaceSurfaceUpdate['clip'];
  return (
    [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) &&
    bounds.width >= 0 &&
    bounds.height >= 0
  );
};

/** Stable documents whose native clipping groups can belong to the full workspace. */
export class WorkspaceSurfaceManager {
  private readonly entries = new Map<string, Surface>();

  constructor(
    private readonly owner: BrowserWindow,
    private readonly options: WorkspaceSurfaceOptions,
  ) {}

  prepare(): WorkspaceSurfaceGrant | null {
    if (this.owner.isDestroyed() || this.entries.size >= 256) return null;
    const id = randomUUID();
    const url = new URL(this.options.url);
    url.search = '';
    url.searchParams.set('surface', id);
    const grant = { id, url: url.href, frameName: `workspace-surface-${id}` };
    this.entries.set(id, { grant, granted: true });
    return { ...grant };
  }

  handleOpen(details: Electron.HandlerDetails): Electron.WindowOpenHandlerResponse | null {
    const entry = [...this.entries.values()].find(
      value =>
        value.granted &&
        value.grant.url === details.url &&
        value.grant.frameName === details.frameName,
    );
    if (!entry || details.postBody) return null;
    // Consume before Chromium creates any WebContents; a duplicate open is never admitted.
    entry.granted = false;
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        webPreferences: {
          preload: undefined,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          webviewTag: true,
          backgroundThrottling: false,
          navigateOnDragDrop: false,
          spellcheck: false,
        },
      },
      createWindow: options => {
        if (this.entries.get(entry.grant.id) !== entry || this.owner.isDestroyed())
          throw new Error('Workspace surface grant was revoked');
        const view = new WebContentsView(options);
        const contents = view.webContents;
        const group = new View();
        entry.view = view;
        entry.group = group;
        group.addChildView(view);
        group.setVisible(false);
        contents.setBackgroundThrottling(false);
        guardDownloads(contents);
        contents.setWindowOpenHandler(() => ({ action: 'deny' }));
        let initialNavigation = true;
        contents.once('did-finish-load', () => {
          initialNavigation = false;
        });
        contents.on('will-navigate', event => {
          if (!initialNavigation || event.url !== entry.grant.url) event.preventDefault();
        });
        contents.on('will-frame-navigate', event => {
          if (event.isMainFrame && (!initialNavigation || event.url !== entry.grant.url))
            event.preventDefault();
        });
        contents.on('will-redirect', event => {
          if (event.isMainFrame) event.preventDefault();
        });
        contents.once('render-process-gone', () => this.invalidate(entry));
        contents.once('destroyed', () => this.invalidate(entry));
        this.options.configureHost(contents);
        this.apply(entry);
        return contents;
      },
    };
  }

  update(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const update = raw as WorkspaceSurfaceUpdate;
    const entry = this.entries.get(update.id);
    if (
      !entry ||
      !validBounds(update) ||
      !validBounds(update.clip) ||
      typeof update.visible !== 'boolean' ||
      typeof update.occluded !== 'boolean' ||
      !Object.values(WorkspaceSurfaceTarget).includes(update.target)
    )
      return;
    if (update.target === WorkspaceSurfaceTarget.Workspace) {
      const workspace = this.options.workspace();
      if (!workspace || update.workspaceGeneration !== workspace.generation) return;
    }
    entry.update = { ...update, clip: { ...update.clip } };
    this.apply(entry);
  }

  applyLayout(): void {
    for (const entry of this.entries.values()) this.apply(entry);
  }

  private apply(entry: Surface): void {
    const { group, view, update } = entry;
    if (!group || !view || view.webContents.isDestroyed() || this.owner.isDestroyed()) return;
    const workspace = this.options.workspace();
    const parent =
      update?.target === WorkspaceSurfaceTarget.Workspace
        ? update.workspaceGeneration === workspace?.generation
          ? workspace?.root
          : undefined
        : this.owner.contentView;
    if (!parent || !update) {
      group.setVisible(false);
      entry.parent?.removeChildView(group);
      entry.parent = undefined;
      return;
    }
    if (entry.parent !== parent) {
      entry.parent?.removeChildView(group);
      parent.addChildView(group);
      entry.parent = parent;
    }
    const zoom = this.owner.webContents.getZoomFactor();
    view.webContents.setZoomFactor(zoom);
    const [ownerWidth, ownerHeight] = this.owner.getContentSize();
    const bounds = parent === this.owner.contentView
      ? { width: ownerWidth, height: ownerHeight }
      : parent.getBounds();
    const left = Math.max(0, Math.round(Math.max(update.x, update.clip.x) * zoom));
    const top = Math.max(0, Math.round(Math.max(update.y, update.clip.y) * zoom));
    const right = Math.min(
      bounds.width,
      Math.round(Math.min(update.x + update.width, update.clip.x + update.clip.width) * zoom),
    );
    const bottom = Math.min(
      bounds.height,
      Math.round(Math.min(update.y + update.height, update.clip.y + update.clip.height) * zoom),
    );
    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - top);
    group.setBounds({ x: left, y: top, width, height });
    view.setBounds({
      x: Math.round(update.x * zoom) - left,
      y: Math.round(update.y * zoom) - top,
      width: Math.max(0, Math.round(update.width * zoom)),
      height: Math.max(0, Math.round(update.height * zoom)),
    });
    group.setVisible(update.visible && !update.occluded && width > 0 && height > 0);
  }

  /** Losing a workspace never destroys or recreates a content document. */
  suspendWorkspace(): void {
    for (const entry of this.entries.values()) {
      if (entry.update?.target !== WorkspaceSurfaceTarget.Workspace || !entry.group) continue;
      entry.group.setVisible(false);
      entry.parent?.removeChildView(entry.group);
      entry.parent = undefined;
    }
  }

  presentationWindow(hostId: number): BrowserWindow | undefined {
    const entry = [...this.entries.values()].find(value => value.view?.webContents.id === hostId);
    if (!entry) return;
    const workspace = this.options.workspace();
    return entry.update?.target === WorkspaceSurfaceTarget.Workspace &&
      entry.update.workspaceGeneration === workspace?.generation
      ? workspace.window
      : this.owner;
  }

  close(id: unknown): void {
    if (typeof id !== 'string') return;
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    if (entry.group) {
      entry.group.setVisible(false);
      entry.parent?.removeChildView(entry.group);
    }
    if (entry.view && !entry.view.webContents.isDestroyed()) entry.view.webContents.close();
  }

  closeAll(): void {
    for (const id of this.entries.keys()) this.close(id);
  }

  private invalidate(entry: Surface): void {
    if (this.entries.get(entry.grant.id) !== entry) return;
    this.close(entry.grant.id);
    if (!this.owner.isDestroyed() && !this.owner.webContents.isDestroyed())
      this.owner.webContents.send(WorkspaceWindowIpc.SurfaceInvalidated, { id: entry.grant.id });
  }
}
