// Minimal, typed bridge between the page and the main process.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (fn) => {
  const h = (_e, ...args) => fn(...args); // never expose the IPC event object
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.off(channel, h);
};

contextBridge.exposeInMainWorld('brain', {
  scan: () => ipcRenderer.invoke('scan'),
  profile: () => ipcRenderer.invoke('profile'),
  setName: (name) => ipcRenderer.invoke('set-name', name),
  setLang: (lang) => ipcRenderer.invoke('set-lang', lang),
  setIgnore: (list) => ipcRenderer.invoke('set-ignore', list),
  toggleFullscreen: () => ipcRenderer.invoke('toggle-fullscreen'),
  shotMode: () => ipcRenderer.invoke('shot-mode'),
  readNote: (vaultPath, rel) => ipcRenderer.invoke('read-note', vaultPath, rel),
  resolveAttachment: (vaultPath, noteRel, target) => ipcRenderer.invoke('resolve-attachment', vaultPath, noteRel, target),
  openInObsidian: (vaultPath, rel) => ipcRenderer.invoke('open-in-obsidian', vaultPath, rel),
  revealNote: (vaultPath, rel) => ipcRenderer.invoke('reveal-note', vaultPath, rel),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openFolder: (p) => ipcRenderer.invoke('open-folder', p),
  vaults: () => ipcRenderer.invoke('vaults'),
  detectVaults: () => ipcRenderer.invoke('detect-vaults'),
  addVault: (p) => ipcRenderer.invoke('add-vault', p),
  removeVault: (p) => ipcRenderer.invoke('remove-vault', p),
  addDemo: () => ipcRenderer.invoke('add-demo'),
  saveImage: (dataUrl) => ipcRenderer.invoke('save-image', dataUrl),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  onChange: on('vaults-changed'),
  onWatchLost: on('watch-lost'),
});
