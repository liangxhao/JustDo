export const WorkspaceWindowIpc = {
  Prepare: 'cowork:workspaceWindow:prepare',
  Update: 'cowork:workspaceWindow:update',
  SetDetached: 'cowork:workspaceWindow:setDetached',
  FocusMain: 'cowork:workspaceWindow:focusMain',
  Focus: 'cowork:workspaceWindow:focus',
  StateChanged: 'cowork:workspaceWindow:stateChanged',
  Invalidated: 'cowork:workspaceWindow:invalidated',
  GetWindowState: 'cowork:workspaceWindow:getWindowState',
  Control: 'cowork:workspaceWindow:control',
} as const;

export const WorkspaceWindowControl = {
  Minimize: 'minimize',
  ToggleMaximize: 'toggleMaximize',
  Close: 'close',
  ShowSystemMenu: 'showSystemMenu',
} as const;

export type WorkspaceWindowControl =
  (typeof WorkspaceWindowControl)[keyof typeof WorkspaceWindowControl];

export interface WorkspaceNativeWindowState {
  isMaximized: boolean;
  isFullscreen: boolean;
  isFocused: boolean;
}

export const WORKSPACE_WINDOW_FRAME_NAME = 'justdo-workspace';
export const WORKSPACE_WINDOW_BOUNDS_KEY = 'workspace_window_bounds';

export interface WorkspaceWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WorkspaceWindowGrant {
  generation: string;
  url: string;
  frameName: string;
  detached: boolean;
  existing: boolean;
}

export interface WorkspaceWindowState {
  generation: string;
  detached: boolean;
  windowState?: WorkspaceNativeWindowState;
}

export interface WorkspaceWindowUpdate extends WorkspaceWindowBounds {
  generation: string;
  visible: boolean;
  occluded: boolean;
}

export type WorkspaceWindowResult =
  { success: true; state: WorkspaceWindowState } | { success: false };
