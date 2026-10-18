import { ipcRenderer } from 'electron';

import { type McpAppHostApi, McpAppIpc } from '../../shared/plugins/mcpApps';

export function createMcpAppPreloadApi(): McpAppHostApi {
  return {
    downloadFile: input => ipcRenderer.invoke(McpAppIpc.DownloadFile, input),
    createSession: input => ipcRenderer.invoke(McpAppIpc.CreateSession, input),
    prepare: sessionId => ipcRenderer.invoke(McpAppIpc.Prepare, sessionId),
    prepareWorkspace: input => ipcRenderer.invoke(McpAppIpc.PrepareWorkspace, input),
    releaseWorkspace: requestId => ipcRenderer.invoke(McpAppIpc.ReleaseWorkspace, requestId),
    questions: sessionId => ipcRenderer.invoke(McpAppIpc.Questions, sessionId),
    resolveQuestion: input => ipcRenderer.invoke(McpAppIpc.ResolveQuestion, input),
    previewQuestion: input => ipcRenderer.invoke(McpAppIpc.PreviewQuestion, input),
    uploadQuestion: input => ipcRenderer.invoke(McpAppIpc.UploadQuestion, input),
    onQuestionsChanged: listener => {
      const notify = () => listener();
      ipcRenderer.on(McpAppIpc.QuestionsChanged, notify);
      return () => ipcRenderer.removeListener(McpAppIpc.QuestionsChanged, notify);
    },
  };
}
