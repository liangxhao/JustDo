import { BrowserWindow, type Display, screen, session } from 'electron';

import { t } from '../../i18n';
import type { ComputerOverlayView } from './computerOverlayController';
import { computerOverlayDocument, type ComputerOverlayFrame } from './computerOverlayDocument';

type Surface = {
  window: BrowserWindow;
  display: Display;
  ready: boolean;
  updating: boolean;
  initialPulse: number;
  pending?: ComputerOverlayFrame;
};
const FRAME_MS = 33;

/** Windows capture exclusion is required before any surface becomes visible. */
export class ComputerOverlayWindow implements ComputerOverlayView {
  private surfaces: Surface[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private visible = false;
  private cursor = false;
  private pulse = 0;

  show(cursor: boolean, click: boolean): void {
    if (process.platform !== 'win32') return;
    this.cursor = cursor;
    if (click) ++this.pulse;
    if (!this.visible) {
      this.visible = true;
      screen.on('display-added', this.rebuild);
      screen.on('display-removed', this.rebuild);
      screen.on('display-metrics-changed', this.rebuild);
      this.rebuild();
    }
    this.syncPolling();
    this.draw();
  }

  hide(): void {
    this.visible = false;
    clearInterval(this.timer);
    this.timer = undefined;
    screen.removeListener('display-added', this.rebuild);
    screen.removeListener('display-removed', this.rebuild);
    screen.removeListener('display-metrics-changed', this.rebuild);
    this.destroySurfaces();
  }

  private destroySurfaces(): void {
    const previous = this.surfaces;
    this.surfaces = [];
    for (const { window } of previous) if (!window.isDestroyed()) window.destroy();
  }

  private rebuild = (): void => {
    this.destroySurfaces();
    if (!this.visible) return;
    try {
      const overlaySession = session.fromPartition('computer-control-overlay');
      overlaySession.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      overlaySession.setPermissionCheckHandler(() => false);
      const document =
        'data:text/html;charset=utf-8,' +
        encodeURIComponent(computerOverlayDocument(t('computerOverlayActive')));
      for (const display of screen.getAllDisplays()) {
        const window = new BrowserWindow({
          ...display.bounds,
          frame: false,
          transparent: true,
          backgroundColor: '#00000000',
          show: false,
          focusable: false,
          skipTaskbar: true,
          alwaysOnTop: true,
          hasShadow: false,
          resizable: false,
          movable: false,
          minimizable: false,
          maximizable: false,
          fullscreenable: false,
          thickFrame: false,
          roundedCorners: false,
          webPreferences: {
            session: overlaySession,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            devTools: false,
            backgroundThrottling: false,
          },
        });
        const surface: Surface = {
          window,
          display,
          ready: false,
          updating: false,
          initialPulse: this.pulse,
        };
        this.surfaces.push(surface);
        window.setContentProtection(true);
        window.setIgnoreMouseEvents(true);
        window.setAlwaysOnTop(true, 'screen-saver');
        // Windows may constrain constructor bounds to the work area (taskbar).
        window.setBounds(display.bounds);
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        window.webContents.on('will-navigate', event => event.preventDefault());
        window.webContents.on('will-frame-navigate', event => event.preventDefault());
        window.webContents.on('will-redirect', event => event.preventDefault());
        window.webContents.on('will-attach-webview', event => event.preventDefault());
        window.webContents.on('render-process-gone', () => this.hide());
        void window
          .loadURL(document)
          .then(() => {
            if (!this.visible || window.isDestroyed() || !this.surfaces.includes(surface)) return;
            surface.ready = true;
            this.draw();
            window.showInactive();
          })
          .catch(() => {
            if (this.surfaces.includes(surface)) {
              console.warn('[ComputerOverlay] Drawing surface could not load.');
              this.hide();
            }
          });
      }
    } catch {
      console.warn('[ComputerOverlay] Desktop presentation is unavailable.');
      this.hide();
    }
  };

  private syncPolling(): void {
    if (!this.visible || !this.cursor) {
      clearInterval(this.timer);
      this.timer = undefined;
    } else if (!this.timer) {
      this.timer = setInterval(() => this.draw(), FRAME_MS);
      this.timer.unref?.();
    }
  }

  private draw(): void {
    if (!this.visible) return;
    try {
      const point = this.cursor ? screen.getCursorScreenPoint() : { x: 0, y: 0 };
      const primary = screen.getPrimaryDisplay().id;
      for (const surface of this.surfaces) {
        const { window, display } = surface;
        if (!surface.ready || window.isDestroyed()) continue;
        const { x, y, width, height } = display.bounds;
        const frame: ComputerOverlayFrame = {
          x: point.x - x,
          y: point.y - y,
          cursor:
            this.cursor &&
            point.x >= x &&
            point.x < x + width &&
            point.y >= y &&
            point.y < y + height,
          badge: display.id === primary,
          pulse: this.pulse - surface.initialPulse,
        };
        this.sendFrame(surface, frame);
      }
    } catch {
      this.hide();
    }
  }

  private sendFrame(surface: Surface, frame: ComputerOverlayFrame): void {
    if (!this.visible || !this.surfaces.includes(surface) || surface.window.isDestroyed()) return;
    if (surface.updating) {
      surface.pending = frame;
      return;
    }
    surface.updating = true;
    void surface.window.webContents
      .executeJavaScript(`window.renderComputerOverlay(${JSON.stringify(frame)})`)
      .catch(() => {
        if (this.surfaces.includes(surface)) this.hide();
      })
      .finally(() => {
        surface.updating = false;
        const pending = surface.pending;
        surface.pending = undefined;
        if (pending) this.sendFrame(surface, pending);
      });
  }
}
