import { contextBridge, ipcRenderer } from 'electron';

import { type ImagePreviewDocument, ImagePreviewIpc } from '../shared/imagePreview';

contextBridge.exposeInMainWorld('imagePreviewWindow', {
  getCurrent: (): Promise<ImagePreviewDocument | null> =>
    ipcRenderer.invoke(ImagePreviewIpc.GetCurrent),
  onSourceChanged: (callback: (document: ImagePreviewDocument) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, document: ImagePreviewDocument): void =>
      callback(document);
    ipcRenderer.on(ImagePreviewIpc.SourceChanged, handler);
    return () => ipcRenderer.removeListener(ImagePreviewIpc.SourceChanged, handler);
  },
  showImageContextMenu: (imageUrl: string) =>
    ipcRenderer.invoke('shell:showImageContextMenu', imageUrl),
});
