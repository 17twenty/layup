import { contextBridge } from 'electron';

/**
 * Preload bridge. Everything the renderer can reach is enumerated here and
 * nowhere else. No Node, filesystem, shell or native handles cross this line.
 */
const api = {
  protocolVersion: 1,
} as const;

contextBridge.exposeInMainWorld('layup', api);
