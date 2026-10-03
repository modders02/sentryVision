/**
 * MSDS Electron preload — secure bridge (contextIsolation: true).
 * Exposes a tiny, explicit API. No Node APIs and no credentials reach the renderer.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('msds', {
  /** Marker so the React app can branch on desktop vs browser. */
  isElectron: true,
  /** { isElectron, isDev, platform, appVersion, localServiceUrl, cameraServerUrl } */
  getEnv: () => ipcRenderer.invoke('msds:env'),
  /** { managed, running, error } for the Electron-managed Python bridge. */
  getLocalServerStatus: () => ipcRenderer.invoke('msds:localServerStatus'),
  openExternal: (url) => ipcRenderer.invoke('msds:openExternal', url),
  chooseClipFolder: () => ipcRenderer.invoke('msds:chooseClipFolder'),
  getClipFolder: () => ipcRenderer.invoke('msds:getClipFolder'),
  forgetClipFolder: () => ipcRenderer.invoke('msds:forgetClipFolder'),
  saveClip: (data, filename) => ipcRenderer.invoke('msds:saveClip', data, filename),
});
