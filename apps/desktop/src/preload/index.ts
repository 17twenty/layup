import { contextBridge, ipcRenderer } from 'electron';
import { createLayupApi } from './api';

/**
 * Preload bridge. Everything the renderer can reach is enumerated in api.ts and
 * nowhere else. No Node, filesystem, shell or native handle crosses this line.
 */
contextBridge.exposeInMainWorld(
  'layup',
  createLayupApi((channel, payload) => ipcRenderer.invoke(channel, payload)),
);
