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
  PrepareSurface: 'cowork:workspaceWindow:prepareSurface',
  UpdateSurface: 'cowork:workspaceWindow:updateSurface',
  CloseSurface: 'cowork:workspaceWindow:closeSurface',
  SurfaceInvalidated: 'cowork:workspaceWindow:surfaceInvalidated',
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

export const WorkspaceSurfaceTarget = { Main: 'main', Workspace: 'workspace' } as const;
export type WorkspaceSurfaceTarget =
  (typeof WorkspaceSurfaceTarget)[keyof typeof WorkspaceSurfaceTarget];

export interface WorkspaceSurfaceGrant {
  id: string;
  url: string;
  frameName: string;
}

export interface WorkspaceSurfaceUpdate extends WorkspaceWindowBounds {
  id: string;
  target: WorkspaceSurfaceTarget;
  workspaceGeneration?: string;
  clip: WorkspaceWindowBounds;
  visible: boolean;
  occluded: boolean;
}

export interface WorkspaceSurfaceInvalidated {
  id: string;
}

export type WorkspaceWindowResult =
  { success: true; state: WorkspaceWindowState } | { success: false };
