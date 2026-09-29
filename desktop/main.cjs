const {app,BrowserWindow,utilityProcess,ipcMain,dialog,Menu,session}=require('electron');
const {autoUpdater}=require('electron-updater');
const {randomBytes}=require('node:crypto');
const path=require('node:path');
const fs=require('node:fs/promises');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {UpdateController}=require('./update-controller.cjs');
let window,child,origin='',updates,stopping=false,stopped=false,checkTimer;
const lock=app.requestSingleInstanceLock();
if(!lock)app.quit();
app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.focus();}});
app.on('window-all-closed',()=>app.quit());
function trusted(event){return window&&!window.isDestroyed()&&event.sender===window.webContents&&event.senderFrame===window.webContents.mainFrame&&new URL(event.senderFrame.url).origin===origin;}
async function killOwnedTree(pid){
 if(!Number.isSafeInteger(pid)||pid<=1)return;
 if(process.platform==='win32'){await promisify(execFile)('taskkill',['/pid',String(pid),'/T','/F']).catch(()=>{});return;}
 const result=await promisify(execFile)('ps',['-axo','pid=,ppid=']).catch(()=>null);
 if(!result)return;
 const pairs=result.stdout.trim().split('\n').map(l=>l.trim().split(/\s+/).map(Number));
 const owned=new Set([pid]);let more=true;
 while(more){more=false;for(const [p,pp]of pairs)if(owned.has(pp)&&!owned.has(p)){owned.add(p);more=true;}}
 for(const p of [...owned].reverse())if(p!==pid){try{process.kill(p,'SIGTERM');}catch{}}
}
app.on('before-quit',event=>{
 if(stopped)return;event.preventDefault();if(stopping)return;stopping=true;
 clearInterval(checkTimer);
 (async()=>{const pid=child?.pid;await killOwnedTree(pid);child?.postMessage({type:'shutdown'});
  await new Promise(resolve=>{if(!child?.pid)return resolve();const timeout=setTimeout(resolve,2000);child.once('exit',()=>{clearTimeout(timeout);resolve();});});
  child?.kill();stopped=true;app.quit();})();
});
async function ready(){
 const smoke=process.env.GBA_DISABLE_UPDATE_CHECKS==='1';
 if(smoke&&process.env.GBA_SMOKE_USER_DATA)app.setPath('userData',path.resolve(process.env.GBA_SMOKE_USER_DATA));
 const base=app.isPackaged?process.resourcesPath:__dirname;
 const runtimeRoot=app.isPackaged?path.join(base,'runtime'):path.join(__dirname,'stage/runtime');
 const portFile=path.join(app.getPath('userData'),'runtime-port.json');
 let preferredPort=0;
 try{const stored=JSON.parse(await fs.readFile(portFile,'utf8'));if(Number.isInteger(stored.port)&&stored.port>1024&&stored.port<65536)preferredPort=stored.port;}catch{}
 const managedRoot=path.join(app.getPath('userData'),'projects');await fs.mkdir(managedRoot,{recursive:true});
 const token=randomBytes(32).toString('hex');
 child=utilityProcess.fork(path.join(__dirname,'runtime-worker.cjs'),[],{cwd:runtimeRoot,env:{...process.env,ROM_EDITOR_MANAGED_ROOT:managedRoot},stdio:'ignore',serviceName:'GBA IDE local backend'});
 const start=new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('The local backend did not become ready.')),30000);
  child.on('message',m=>{
   if(m?.type==='ready'&&/^http:\/\/127\.0\.0\.1:\d+$/.test(m.origin)){origin=m.origin;clearTimeout(timer);resolve();}
   if(m?.type==='startup-error'){clearTimeout(timer);reject(new Error(m.message));}
  });
  child.once('exit',()=>{clearTimeout(timer);reject(new Error('The local backend stopped.'));if(window&&!stopping){dialog.showErrorBox('GBA IDE backend stopped','Save your work and restart the application.');app.quit();}});
 });
 child.once('spawn',()=>child.postMessage({type:'init',runtimeRoot,managedRoot,token,preferredPort}));
 await start;
 await fs.writeFile(portFile,JSON.stringify({port:Number(new URL(origin).port)})+'\n');
 const ses=session.fromPartition('persist:gba-workspace');
 ses.setPermissionRequestHandler((contents,permission,callback)=>callback(permission==='clipboard-sanitized-write'&&contents===window?.webContents&&new URL(contents.getURL()).origin===origin));ses.setPermissionCheckHandler((contents,permission,requestingOrigin)=>permission==='clipboard-sanitized-write'&&contents===window?.webContents&&requestingOrigin===origin);
 ses.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(details,callback)=>{let url;try{url=new URL(details.url);}catch{return callback({cancel:true});}callback({cancel:!(url.origin===origin||(url.protocol==='ws:'&&url.host===new URL(origin).host))});});
 ses.webRequest.onBeforeSendHeaders({urls:[origin+'/*',origin.replace('http:','ws:')+'/*']},(details,callback)=>callback({requestHeaders:{...details.requestHeaders,'X-Gba-Session':token}}));
 window=new BrowserWindow({width:1500,height:960,minWidth:1050,minHeight:680,show:false,title:'GBA ROM Hack IDE',backgroundColor:'#0a111c',icon:path.join(__dirname,'icon.png'),webPreferences:{session:ses,preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false,nodeIntegrationInWorker:false,webviewTag:false,webSecurity:true}});
 window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 window.webContents.on('will-navigate',(event,url)=>{try{if(new URL(url??event.url).origin!==origin)event.preventDefault();}catch{event.preventDefault();}});
 window.webContents.on('will-frame-navigate',(event,details)=>{const frame=details??event;try{if(!frame.isMainFrame||new URL(frame.url).origin!==origin)event.preventDefault();}catch{event.preventDefault();}});
 window.webContents.on('will-attach-webview',event=>event.preventDefault());
 child.on('message',async m=>{
  if(m?.type!=='pick'||!['folder','rom-or-archive'].includes(m.kind)||!Number.isSafeInteger(m.id)||stopping)return;
  const result=await dialog.showOpenDialog(window,{title:m.kind==='folder'?'Open project folder':'Open your GBA ROM or archive',properties:[m.kind==='folder'?'openDirectory':'openFile'],...(m.kind==='folder'?{}:{filters:[{name:'GBA ROM or ZIP',extensions:['gba','zip']}]} )}).catch(()=>({canceled:true,filePaths:[]}));
  child?.postMessage({type:'pick-result',id:m.id,path:result.canceled?null:result.filePaths[0]});
 });
 autoUpdater.logger=null;
 const enabled=app.isPackaged&&!smoke&&(process.platform!=='linux'||!!process.env.APPIMAGE);
 updates=new UpdateController(autoUpdater,{version:app.getVersion(),enabled,reason:smoke?'Automatic checks are disabled for this session.':app.isPackaged?'Use the AppImage for automatic updates, or install the next package manually.':'Source preview. Updates are enabled in supported release packages.',confirmInstall:async()=>{
  const result=await dialog.showMessageBox(window,{type:'question',buttons:['Cancel','Restart and install'],defaultId:0,cancelId:0,title:'Install update',message:'Save your work before restarting.',detail:'The editor and its local backend will close. Project files are kept. Unsaved editor changes must be saved first.'});return result.response===1;
 }});
 updates.on('status',status=>{if(window&&!window.isDestroyed())window.webContents.send('desktop:status-changed',status);});
 for(const [name,fn]of [['status',()=>updates.status()],['check',()=>updates.check()],['download',()=>updates.download()],['install',()=>updates.install()]])ipcMain.handle('desktop:'+name,event=>{if(!trusted(event))throw new Error('Untrusted desktop request');return fn();});
 Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'GBA IDE',submenu:[{label:'Check for updates',click:()=>updates.check()},{type:'separator'},{role:'quit'}]},{label:'Edit',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},{label:'View',submenu:[{role:'reload'},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{role:'togglefullscreen'}]}]));
 await window.loadURL(origin+'/');window.show();
 if(enabled){setTimeout(()=>updates.check(),5000).unref();checkTimer=setInterval(()=>updates.check(),6*60*60*1000);checkTimer.unref();}
}
if(lock)app.whenReady().then(ready).catch(error=>{dialog.showErrorBox('GBA IDE could not start',String(error.message));app.quit();});
