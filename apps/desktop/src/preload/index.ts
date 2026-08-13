import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { createLayupApi } from './api';

/**
 * Preload bridge. Everything the renderer can reach is enumerated in api.ts and
 * nowhere else. No Node, filesystem, shell or native handle crosses this line.
 */
contextBridge.exposeInMainWorld(
  'layup',
  createLayupApi(
    (channel, payload) => ipcRenderer.invoke(channel, payload),
    (channel, listener) => {
      const wrapped = (_event: IpcRendererEvent, payload: unknown) => listener(payload);
      ipcRenderer.on(channel, wrapped);
      return () => ipcRenderer.removeListener(channel, wrapped);
    },
  ),
);
