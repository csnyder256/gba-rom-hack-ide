const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('GbaDesktop',Object.freeze({
 status:()=>ipcRenderer.invoke('desktop:status'),
 check:()=>ipcRenderer.invoke('desktop:check'),
 download:()=>ipcRenderer.invoke('desktop:download'),
 install:()=>ipcRenderer.invoke('desktop:install'),
 onStatus:callback=>{
  if(typeof callback!=='function')return()=>{};
  const handler=(_event,status)=>callback(status);
  ipcRenderer.on('desktop:status-changed',handler);
  return()=>ipcRenderer.removeListener('desktop:status-changed',handler);
 },
}));
