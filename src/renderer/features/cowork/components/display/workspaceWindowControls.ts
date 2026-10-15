import {
  type WorkspaceNativeWindowState,
  WorkspaceWindowControl,
} from '@shared/cowork/workspaceWindow';

type WorkspaceWindowApi = Pick<
  Window['electron']['workspaceWindow'],
  'control' | 'getWindowState' | 'onStateChanged'
>;

export const createWorkspaceWindowControls = (
  api: WorkspaceWindowApi,
  generation: string,
): Window['electron']['window'] => ({
  minimize: () => api.control(generation, WorkspaceWindowControl.Minimize),
  toggleMaximize: () => api.control(generation, WorkspaceWindowControl.ToggleMaximize),
  close: () => api.control(generation, WorkspaceWindowControl.Close),
  showSystemMenu: position =>
    api.control(generation, WorkspaceWindowControl.ShowSystemMenu, position),
  isMaximized: async () => (await api.getWindowState(generation))?.isMaximized ?? false,
  onStateChanged: (callback: (state: WorkspaceNativeWindowState) => void) =>
    api.onStateChanged(state => {
      if (state.generation !== generation) return;
      if (state.windowState) {
        callback(state.windowState);
      } else if (!state.detached) {
        callback({ isMaximized: false, isFullscreen: false, isFocused: false });
      }
    }),
});
