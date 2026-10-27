import { contextBridge, ipcRenderer } from 'electron';

import {
  type MediaPlaybackBridge,
  OpenClawAssistantMediaIpc,
} from '../shared/openclaw/assistantMedia';

const playback: MediaPlaybackBridge = {
  prepareAssistantMediaPlayback: request =>
    ipcRenderer.invoke(OpenClawAssistantMediaIpc.PreparePlayback, request),
  releaseAssistantMediaPlayback: request =>
    ipcRenderer.invoke(OpenClawAssistantMediaIpc.ReleasePlayback, request),
};

contextBridge.exposeInMainWorld('mediaPlayback', playback);
