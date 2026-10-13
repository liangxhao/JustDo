import { BrowserWindow, type Display, screen, session } from 'electron';

import { t } from '../../i18n';
import type { ComputerOverlayPresentation, ComputerOverlayView } from './computerOverlayController';
import { computerOverlayDocument, type ComputerOverlayFrame } from './computerOverlayDocument';

type Surface = {
  window: BrowserWindow;
  display: Display;
  ready: boolean;
  updating: boolean;
  initialPulse: number;
  presented: boolean;
  pending?: ComputerOverlayFrame;
};
const FRAME_MS = 33;

/** Capture exclusion is the default; remote preview explicitly allows capture. */
export class ComputerOverlayWindow implements ComputerOverlayView {
  private surfaces: Surface[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private visible = false;
  private cursor = false;
  private pulse = 0;
  private holding = false;
  private waiting = false;
  private point = { x: 0, y: 0 };
  private fading = false;
  private fadeTimer: ReturnType<typeof setTimeout> | undefined;
  private listening = false;
  private epoch = 0;
  private pulsePoint = { x: 0, y: 0 };
  private pulseEpoch = -1;
  private captureAllowed = false;

  constructor(private readonly remotePreview: () => boolean = () => false) {}

  /** Warm the protected surfaces without showing or polling the desktop. */
  prepare(): void {
    if (process.platform !== 'win32') return;
    if (!this.listening) {
      this.listening = true;
      screen.on('display-added', this.rebuild);
      screen.on('display-removed', this.rebuild);
      screen.on('display-metrics-changed', this.rebuild);
    }
    if (!this.surfaces.length) this.rebuild();
  }

  show(
    cursor: boolean,
    click: boolean,
    presentation: ComputerOverlayPresentation = {
      waiting: false,
      hold: false,
      capture: false,
    },
  ): void {
    if (process.platform !== 'win32') return;
    if (!this.visible || this.fading) ++this.epoch;
    clearTimeout(this.fadeTimer);
    this.fadeTimer = undefined;
    this.fading = false;
    if (presentation.capture || click) {
      try {
        this.point = screen.getCursorScreenPoint();
      } catch {
        this.dispose();
        return;
      }
    }
    this.cursor = cursor;
    this.holding = presentation.hold;
    this.waiting = presentation.waiting;
    this.prepare();
    const captureAllowed = this.remotePreview() === true;
    if (captureAllowed !== this.captureAllowed) {
      for (const { window } of this.surfaces) {
        if (!window.isDestroyed()) window.setContentProtection(!captureAllowed);
      }
      this.captureAllowed = captureAllowed;
    }
    if (click) {
      ++this.pulse;
      this.pulsePoint = { ...this.point };
      this.pulseEpoch = this.epoch;
    }
    this.visible = true;
    this.syncPolling();
    this.draw();
  }

  hide(animate = false): void {
    clearTimeout(this.fadeTimer);
    this.fadeTimer = undefined;
    if (animate && this.visible) {
      this.fading = true;
      this.cursor = false;
      this.syncPolling();
      this.draw();
      this.fadeTimer = setTimeout(() => this.hide(), 180);
      return;
    }
    this.visible = false;
    ++this.epoch;
    clearInterval(this.timer);
    this.timer = undefined;
    for (const surface of this.surfaces) {
      surface.pending = undefined;
      surface.presented = false;
      if (!surface.window.isDestroyed()) surface.window.hide();
    }
  }

  dispose(): void {
    this.hide();
    screen.removeListener('display-added', this.rebuild);
    screen.removeListener('display-removed', this.rebuild);
    screen.removeListener('display-metrics-changed', this.rebuild);
    this.listening = false;
    this.destroySurfaces();
  }

  private destroySurfaces(): void {
    const previous = this.surfaces;
    this.surfaces = [];
    for (const { window } of previous) if (!window.isDestroyed()) window.destroy();
  }

  private rebuild = (): void => {
    this.destroySurfaces();
    try {
      const overlaySession = session.fromPartition('computer-control-overlay');
      overlaySession.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      overlaySession.setPermissionCheckHandler(() => false);
      const document =
        'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          computerOverlayDocument(t('computerOverlayActive'), t('computerOverlayWaiting')),
        );
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
          presented: false,
        };
        this.surfaces.push(surface);
        window.setContentProtection(!this.captureAllowed);
        window.setIgnoreMouseEvents(true);
        window.setAlwaysOnTop(true, 'screen-saver');
        // Windows may constrain constructor bounds to the work area (taskbar).
        window.setBounds(display.bounds);
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        window.webContents.on('will-navigate', event => event.preventDefault());
        window.webContents.on('will-frame-navigate', event => event.preventDefault());
        window.webContents.on('will-redirect', event => event.preventDefault());
        window.webContents.on('will-attach-webview', event => event.preventDefault());
        window.webContents.on('render-process-gone', () => {
          console.warn('[ComputerOverlay] Drawing process exited.');
          this.dispose();
        });
        void window
          .loadURL(document)
          .then(() => {
            if (window.isDestroyed() || !this.surfaces.includes(surface)) return;
            surface.ready = true;
            console.info('[ComputerOverlay] Drawing surface ready.');
            this.draw();
          })
          .catch(() => {
            if (this.surfaces.includes(surface)) {
              console.warn('[ComputerOverlay] Drawing surface could not load.');
              this.dispose();
            }
          });
      }
    } catch {
      console.warn('[ComputerOverlay] Desktop presentation is unavailable.');
      this.dispose();
    }
  };

  private syncPolling(): void {
    if (!this.visible || !this.cursor || this.holding) {
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
      if (this.cursor && !this.holding) this.point = screen.getCursorScreenPoint();
      const point = this.point;
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
          visible: !this.fading,
          waiting: this.waiting,
          epoch: this.epoch,
          pulseX: this.pulsePoint.x - x,
          pulseY: this.pulsePoint.y - y,
          pulseHere:
            this.pulseEpoch === this.epoch &&
            this.pulsePoint.x >= x &&
            this.pulsePoint.x < x + width &&
            this.pulsePoint.y >= y &&
            this.pulsePoint.y < y + height,
        };
        this.sendFrame(surface, frame);
      }
    } catch {
      console.warn('[ComputerOverlay] Frame preparation failed.');
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
      .then(() => {
        if (
          this.visible &&
          !this.fading &&
          !surface.presented &&
          frame.epoch === this.epoch &&
          this.surfaces.includes(surface) &&
          !surface.window.isDestroyed()
        ) {
          surface.presented = true;
          surface.window.showInactive();
          console.info('[ComputerOverlay] Drawing surface shown.');
        }
      })
      .catch(() => {
        if (this.surfaces.includes(surface)) {
          console.warn('[ComputerOverlay] Frame rendering failed.');
          this.dispose();
        }
      })
      .finally(() => {
        surface.updating = false;
        const pending = surface.pending;
        surface.pending = undefined;
        if (pending) this.sendFrame(surface, pending);
      });
  }
}
