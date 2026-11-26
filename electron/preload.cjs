// Bridge between the editor and the Mac app: the menus follow the language picked in Orion.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('orionApp', {
  setLanguage: (lang) => ipcRenderer.send('orion:lang', String(lang)),
});
