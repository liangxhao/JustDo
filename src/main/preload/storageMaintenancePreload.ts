import { contextBridge, ipcRenderer } from 'electron';

import {
  type StorageMaintenanceStatus,
  StorageRelocationIpc,
} from '../../shared/storage/storageRelocation';

contextBridge.exposeInMainWorld('storageMaintenance', {
  status: () => ipcRenderer.invoke(StorageRelocationIpc.MaintenanceStatus),
  retry: () => ipcRenderer.invoke(StorageRelocationIpc.MaintenanceRetry),
  cancel: () => ipcRenderer.invoke(StorageRelocationIpc.MaintenanceCancel),
  onChanged: (callback: (progress: StorageMaintenanceStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: StorageMaintenanceStatus) =>
      callback(progress);
    ipcRenderer.on(StorageRelocationIpc.MaintenanceChanged, handler);
    return () => ipcRenderer.removeListener(StorageRelocationIpc.MaintenanceChanged, handler);
  },
});
