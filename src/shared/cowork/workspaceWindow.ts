export const WorkspaceWindowIpc = {
  Prepare: 'cowork:workspaceWindow:prepare',
  Update: 'cowork:workspaceWindow:update',
  SetDetached: 'cowork:workspaceWindow:setDetached',
  FocusMain: 'cowork:workspaceWindow:focusMain',
  Focus: 'cowork:workspaceWindow:focus',
  StateChanged: 'cowork:workspaceWindow:stateChanged',
  Invalidated: 'cowork:workspaceWindow:invalidated',
} as const;

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
}

export interface WorkspaceWindowUpdate extends WorkspaceWindowBounds {
  generation: string;
  visible: boolean;
  occluded: boolean;
}

export type WorkspaceWindowResult =
  { success: true; state: WorkspaceWindowState } | { success: false };
