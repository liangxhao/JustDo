import { randomUUID } from 'crypto';
import { BrowserWindow, screen, WebContentsView } from 'electron';

import {
  WORKSPACE_WINDOW_FRAME_NAME,
  type WorkspaceWindowBounds,
  type WorkspaceWindowGrant,
  WorkspaceWindowIpc,
  type WorkspaceWindowResult,
  type WorkspaceWindowUpdate,
} from '../../../shared/cowork/workspaceWindow';
import {
  clipWorkspaceViewBounds,
  fitWorkspaceWindowBounds,
  isWorkspaceWindowBounds,
} from './workspaceWindowGeometry';

type WorkspaceWindowOptions = {
  url: string;
  icon?: string;
  backgroundColor: string;
  isQuitting: () => boolean;
  configureHost: (host: Electron.WebContents) => void;
  openExternal: (url: string) => void;
  readBounds: () => unknown;
  saveBounds: (bounds: WorkspaceWindowBounds) => void;
};

const managers = new Map<number, WorkspaceWindowManager>();

export const getWorkspaceWindowManager = (ownerId: number): WorkspaceWindowManager | undefined =>
  managers.get(ownerId);

export const isWorkspaceBrowserHost = (ownerId: number, hostId: number): boolean =>
  ownerId === hostId || managers.get(ownerId)?.ownsHost(hostId) === true;

export const getWorkspaceDialogOwner = (
  contents: Electron.WebContents,
): BrowserWindow | undefined =>
  managers.get(contents.id)?.focusedWindow() ??
  BrowserWindow.fromWebContents(contents) ??
  undefined;

/** Presentation ownership only. React, task execution and tool IPC stay with Main's renderer. */
export class WorkspaceWindowManager {
  private generation = randomUUID();
  private grant: WorkspaceWindowGrant | null = null;
  private view: WebContentsView | null = null;
  private contents: Electron.WebContents | null = null;
  private shell: BrowserWindow | null = null;
  private update: WorkspaceWindowUpdate | null = null;
  private hiddenWithOwner = false;
  private disposed = false;
  private readonly ownerId: number;

  constructor(
    private readonly owner: BrowserWindow,
    private readonly options: WorkspaceWindowOptions,
  ) {
    this.ownerId = owner.webContents.id;
    managers.set(this.ownerId, this);
    owner.on('resize', () => this.applyLayout());
    owner.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) this.reset();
    });
    owner.webContents.on('render-process-gone', () => this.reset());
    owner.once('closed', () => this.dispose());
    owner.on('hide', () => {
      // On Windows hide can precede the native minimize state change.
      queueMicrotask(() => {
        if (owner.isDestroyed() || owner.isMinimized() || owner.isVisible()) return;
        this.hideWithOwner();
      });
    });
    owner.on('show', () => {
      if (this.hiddenWithOwner && this.shell && !this.shell.isDestroyed()) this.shell.show();
      this.hiddenWithOwner = false;
    });
    screen.on('display-removed', this.recoverBounds);
    screen.on('display-metrics-changed', this.recoverBounds);
  }

  ownsHost(hostId: number): boolean {
    return (
      !this.disposed &&
      !!this.view &&
      !!this.contents &&
      !this.contents.isDestroyed() &&
      this.contents.id === hostId
    );
  }

  focusedWindow(): BrowserWindow | undefined {
    return this.shell?.isFocused() ? this.shell : undefined;
  }

  presentationWindow(hostId?: number): BrowserWindow {
    return this.shell && (hostId === undefined || this.ownsHost(hostId)) ? this.shell : this.owner;
  }

  captureFrame(): Electron.WebFrameMain | undefined {
    return this.contents && !this.contents.isDestroyed() ? this.contents.mainFrame : undefined;
  }

  prepare(): WorkspaceWindowGrant {
    if (!this.grant) {
      const url = new URL(this.options.url);
      url.searchParams.set('generation', this.generation);
      this.grant = {
        generation: this.generation,
        url: url.toString(),
        frameName: `${WORKSPACE_WINDOW_FRAME_NAME}-${this.generation}`,
        detached: this.shell !== null,
        existing: this.view !== null,
      };
    }
    return { ...this.grant, detached: this.shell !== null, existing: this.view !== null };
  }

  handleOpen(details: Electron.HandlerDetails): Electron.WindowOpenHandlerResponse | null {
    if (
      !this.grant ||
      this.view ||
      details.url !== this.grant.url ||
      details.frameName !== this.grant.frameName ||
      details.postBody
    )
      return null;
    // These overrides apply BEFORE Chromium creates options.webContents. The
    // child must never inherit the application's privileged preload.
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
        this.grant = null;
        const view = new WebContentsView(options);
        const contents = view.webContents;
        // window.open supplies an existing WebContents, so constructor preferences
        // do not initialize its runtime scheduler flag. Keep frames alive on moves.
        contents.setBackgroundThrottling(false);
        this.view = view;
        this.contents = contents;
        this.owner.contentView.addChildView(view);
        view.setVisible(false);
        contents.setWindowOpenHandler(details => {
          this.options.openExternal(details.url);
          return { action: 'deny' };
        });
        let initialNavigation = true;
        contents.once('did-finish-load', () => {
          initialNavigation = false;
        });
        contents.on('will-navigate', event => {
          if (!initialNavigation || event.url !== details.url) event.preventDefault();
        });
        contents.on('will-frame-navigate', event => {
          if (event.isMainFrame && (!initialNavigation || event.url !== details.url))
            event.preventDefault();
        });
        this.options.configureHost(contents);
        contents.once('render-process-gone', () => {
          this.invalidate(view);
        });
        contents.once('destroyed', () => {
          this.invalidate(view);
        });
        this.applyLayout();
        return contents;
      },
    };
  }

  updateLayout(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const update = raw as WorkspaceWindowUpdate;
    if (
      update.generation !== this.generation ||
      typeof update.visible !== 'boolean' ||
      typeof update.occluded !== 'boolean' ||
      ![update.x, update.y, update.width, update.height].every(Number.isFinite) ||
      update.width < 0 ||
      update.height < 0
    )
      return;
    this.update = { ...update };
    this.applyLayout();
  }

  private emitState(): void {
    if (!this.owner.isDestroyed() && !this.owner.webContents.isDestroyed()) {
      this.owner.webContents.send(WorkspaceWindowIpc.StateChanged, {
        generation: this.generation,
        detached: this.shell !== null,
      });
    }
  }

  private applyLayout(): void {
    const view = this.view;
    const contents = this.contents;
    if (!view || !contents || contents.isDestroyed() || this.owner.isDestroyed()) return;
    contents.setZoomFactor(this.owner.webContents.getZoomFactor());
    if (this.shell) {
      const [width, height] = this.shell.getContentSize();
      view.setBounds({ x: 0, y: 0, width, height });
      view.setVisible(true);
    } else if (this.update) {
      const [width, height] = this.owner.getContentSize();
      const bounds = clipWorkspaceViewBounds(
        this.update,
        { width, height },
        this.owner.webContents.getZoomFactor(),
      );
      view.setBounds(bounds);
      view.setVisible(
        this.update.visible && !this.update.occluded && bounds.width > 0 && bounds.height > 0,
      );
    }
  }

  setDetached(generation: unknown, detached: unknown): WorkspaceWindowResult {
    if (
      generation !== this.generation ||
      typeof detached !== 'boolean' ||
      !this.view ||
      !this.contents ||
      this.contents.isDestroyed() ||
      this.owner.isDestroyed()
    )
      return { success: false };
    const previousShell = this.shell;
    let createdShell: BrowserWindow | null = null;
    try {
      if (detached && !this.shell) {
        const saved = this.options.readBounds();
        const bounds = fitWorkspaceWindowBounds(
          isWorkspaceWindowBounds(saved)
            ? saved
            : { ...this.owner.getBounds(), width: 900, height: 720 },
          screen.getAllDisplays().map(display => display.workArea),
        );
        const shell = new BrowserWindow({
          ...bounds,
          minWidth: Math.min(480, bounds.width),
          minHeight: Math.min(320, bounds.height),
          show: false,
          frame: true,
          title: '',
          icon: this.options.icon,
          backgroundColor: this.options.backgroundColor,
          autoHideMenuBar: true,
          webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
        });
        createdShell = shell;
        shell.setMenu(null);
        shell.webContents.on('page-title-updated', event => event.preventDefault());
        shell.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        this.owner.contentView.removeChildView(this.view);
        shell.contentView.addChildView(this.view);
        this.shell = shell;
        shell.on('resize', () => this.applyLayout());
        const saveBounds = () => {
          if (!shell.isDestroyed() && !shell.isMaximized() && !shell.isMinimized()) {
            this.saveBounds(shell.getBounds());
          }
        };
        shell.on('resized', saveBounds);
        shell.on('moved', saveBounds);
        shell.on('close', event => {
          if (!this.options.isQuitting()) {
            event.preventDefault();
            this.setDetached(this.generation, false);
          }
        });
        this.applyLayout();
        shell.show();
        this.contents.focus();
      } else if (!detached && this.shell) {
        const shell = this.shell;
        if (!shell.isMaximized() && !shell.isMinimized()) this.saveBounds(shell.getBounds());
        shell.contentView.removeChildView(this.view);
        this.owner.contentView.addChildView(this.view);
        this.shell = null;
        this.hiddenWithOwner = false;
        this.applyLayout();
        shell.destroy();
        this.focusMain();
        this.contents.focus();
      }
      this.emitState();
      return {
        success: true,
        state: { generation: this.generation, detached: this.shell !== null },
      };
    } catch (error) {
      console.error('[WorkspaceWindow] Failed to change presentation:', error);
      // A failed move must leave the original presentation and its live contents intact.
      if (this.view && this.contents && !this.contents.isDestroyed()) {
        try {
          const destination = previousShell ?? this.owner;
          const other = previousShell ? this.owner : createdShell;
          if (other && !other.isDestroyed() && other.contentView.children.includes(this.view)) {
            other.contentView.removeChildView(this.view);
          }
          destination.contentView.addChildView(this.view);
          this.shell = previousShell;
          if (createdShell && !createdShell.isDestroyed()) createdShell.destroy();
          this.applyLayout();
        } catch (rollbackError) {
          console.error('[WorkspaceWindow] Failed to restore presentation:', rollbackError);
          this.reset();
        }
      }
      return { success: false };
    }
  }

  /** Close-to-tray must also work when Main was already minimized and emits no hide. */
  hideWithOwner(): void {
    if (this.shell?.isVisible()) {
      this.hiddenWithOwner = true;
      this.shell.hide();
    }
  }

  focusMain(): void {
    if (this.owner.isDestroyed()) return;
    if (this.owner.isMinimized()) this.owner.restore();
    this.owner.show();
    this.owner.focus();
  }

  focus(): void {
    if (!this.shell) {
      this.focusMain();
      return;
    }
    if (this.shell.isMinimized()) this.shell.restore();
    this.shell.show();
    this.shell.focus();
    if (this.contents && !this.contents.isDestroyed()) this.contents.focus();
  }

  private readonly recoverBounds = (): void => {
    if (!this.shell || this.shell.isDestroyed()) return;
    const bounds = fitWorkspaceWindowBounds(
      this.shell.getBounds(),
      screen.getAllDisplays().map(display => display.workArea),
    );
    this.shell.setMinimumSize(Math.min(480, bounds.width), Math.min(320, bounds.height));
    this.shell.setBounds(bounds);
    this.applyLayout();
  };

  private saveBounds(bounds: WorkspaceWindowBounds): void {
    try {
      this.options.saveBounds(bounds);
    } catch (error) {
      console.error('[WorkspaceWindow] Failed to save window bounds:', error);
    }
  }

  private invalidate(view: WebContentsView): void {
    if (this.view !== view) return;
    const state = { generation: this.generation, detached: this.shell !== null };
    const contents = this.contents;
    const notify = () => {
      if (
        !this.options.isQuitting() &&
        !this.owner.isDestroyed() &&
        !this.owner.webContents.isDestroyed() &&
        !this.owner.webContents.isCrashed()
      ) {
        this.owner.webContents.send(WorkspaceWindowIpc.Invalidated, state);
      }
    };
    // close() is asynchronous after process loss. Reopening the named document
    // before destruction can reacquire its dying WindowProxy and mount into it.
    const pendingClose = contents && !contents.isDestroyed();
    if (pendingClose) contents.once('destroyed', notify);
    this.reset();
    if (!pendingClose) notify();
  }

  private reset(): void {
    this.generation = randomUUID();
    this.grant = null;
    this.update = null;
    const view = this.view;
    const contents = this.contents;
    const shell = this.shell;
    this.view = null;
    this.contents = null;
    this.shell = null;
    if (shell && !shell.isDestroyed()) {
      if (view && shell.contentView.children.includes(view))
        shell.contentView.removeChildView(view);
      shell.destroy();
    } else if (view && !this.owner.isDestroyed()) {
      if (this.owner.contentView.children.includes(view))
        this.owner.contentView.removeChildView(view);
    }
    if (contents && !contents.isDestroyed()) contents.close();
    this.hiddenWithOwner = false;
  }

  private dispose(): void {
    try {
      this.reset();
    } finally {
      this.disposed = true;
      managers.delete(this.ownerId);
      screen.off('display-removed', this.recoverBounds);
      screen.off('display-metrics-changed', this.recoverBounds);
    }
  }
}
