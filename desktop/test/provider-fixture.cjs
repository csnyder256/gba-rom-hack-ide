const {app}=require('electron');const assert=require('node:assert/strict'),http=require('node:http'),crypto=require('node:crypto'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {AppImageUpdater}=require('electron-updater');const {ElectronHttpExecutor}=require('electron-updater/out/electronHttpExecutor');const {UpdateController}=require('../update-controller.cjs');
app.whenReady().then(async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'gba-update-integrity-'));const oldAppImage=process.env.APPIMAGE;
 const bytes=Buffer.from('Controlled update fixture. Not executable.');let version='0.2.0',digest=crypto.createHash('sha512').update(bytes).digest('base64');
 const server=http.createServer((req,res)=>{
  if(req.url.includes('.yml'))res.end(`version: ${version}\nfiles:\n  - url: fixture.AppImage\n    sha512: ${digest}\n    size: ${bytes.length}\npath: fixture.AppImage\nsha512: ${digest}\nreleaseDate: '2026-09-29T00:00:00.000Z'\n`);
  else res.end(bytes);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const oldFile=path.join(dir,'old.AppImage');await fs.writeFile(oldFile,'old controlled fixture');process.env.APPIMAGE=oldFile;
  const config=path.join(dir,'app-update.yml');await fs.writeFile(config,'updaterCacheDirName: controlled-cache\n');
  const adapter={version:'0.3.0',name:'controlled-gba',isPackaged:true,appUpdateConfigPath:config,userDataPath:dir,baseCachePath:dir,whenReady:async()=>{},relaunch(){},quit(){throw new Error('No fixture can install')},onQuit(){}};
  const updater=new AppImageUpdater(undefined,adapter);updater.httpExecutor=new ElectronHttpExecutor(()=>{});updater.logger=null;updater.disableDifferentialDownload=true;const errors=[];updater.on('error',e=>errors.push(e.code+': '+e.message));
  updater.setFeedURL({provider:'generic',url:'http://127.0.0.1:'+server.address().port+'/'});
  let installs=0;updater.quitAndInstall=()=>{installs++;};
  const controller=new UpdateController(updater,{version:'0.3.0',enabled:true,confirmInstall:async()=>false});
  await controller.check();assert.equal(controller.status().phase,'idle'); // older release is refused
  version='0.3.1';digest=crypto.createHash('sha512').update('wrong bytes').digest('base64');
  await controller.check();assert.equal(controller.status().phase,'available');await controller.download();assert.equal(controller.status().phase,'error');await controller.install();assert.equal(installs,0);
  digest=crypto.createHash('sha512').update(bytes).digest('base64');
  await controller.check();await controller.download();assert.equal(controller.status().phase,'downloaded',errors.join('\n')); await controller.install();assert.equal(installs,0);
 }finally{
  if(oldAppImage===undefined)delete process.env.APPIMAGE;else process.env.APPIMAGE=oldAppImage;
  await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});
 }
 console.log('Actual Electron update provider: downgrade refused, corrupt SHA-512 rejected, matching bytes downloaded, no fixture installed.');
}).then(()=>app.quit()).catch(e=>{console.error(e);app.exit(1);});
