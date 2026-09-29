const {EventEmitter}=require('node:events');
class UpdateController extends EventEmitter {
 constructor(updater,{version,enabled,reason,confirmInstall}){
  super();this.updater=updater;this.confirmInstall=confirmInstall;this.busy=false;
  this.state={phase:enabled?'idle':'disabled',currentVersion:version,message:enabled?'Updates are checked automatically. You choose when to download and restart.':reason};
  updater.autoDownload=false;updater.autoInstallOnAppQuit=false;updater.allowDowngrade=false;updater.allowPrerelease=false;updater.disableWebInstaller=true;
  updater.on('checking-for-update',()=>this.set({phase:'checking',message:'Checking the stable release channel…'}));
  updater.on('update-available',info=>this.set({phase:'available',nextVersion:info.version,message:'A new release is available. Save your work before installing.'}));
  updater.on('update-not-available',()=>this.set({phase:'idle',nextVersion:undefined,message:'You have the latest stable release.'}));
  updater.on('download-progress',info=>this.set({phase:'downloading',percent:Math.max(0,Math.min(100,Number(info.percent)||0)),message:'Downloading and verifying the update…'}));
  updater.on('update-downloaded',info=>this.set({phase:'downloaded',nextVersion:info.version,percent:100,message:'Update verified and ready. Save your work, then restart to install.'}));
  updater.on('error',()=>this.set({phase:'error',message:'The update could not be checked, downloaded or verified. Your current installation is unchanged.'}));
 }
 set(patch){this.state={currentVersion:this.state.currentVersion,...patch};this.emit('status',this.status());}
 status(){return {...this.state};}
 async check(){
  if(this.state.phase==='disabled'||this.busy||['downloading','downloaded','installing'].includes(this.state.phase))return this.status();
  this.busy=true;this.set({phase:'checking',message:'Checking the stable release channel…'});
  try{await this.updater.checkForUpdates();}catch{this.set({phase:'error',message:'Could not check updates. Check your connection and try again.'});}finally{this.busy=false;}
  return this.status();
 }
 async download(){
  if(this.state.phase!=='available'||this.busy)return this.status();
  this.busy=true;this.set({phase:'downloading',nextVersion:this.state.nextVersion,percent:0,message:'Downloading and verifying the update…'});
  try{await this.updater.downloadUpdate();}catch{this.set({phase:'error',message:'The update failed verification or download. Nothing was installed.'});}finally{this.busy=false;}
  return this.status();
 }
 async install(){
  if(this.state.phase!=='downloaded'||this.busy)return this.status();
  this.busy=true;
  try{if(await this.confirmInstall()){this.set({phase:'installing',message:'Restarting to install the verified release…'});this.updater.quitAndInstall(false,true);}}finally{this.busy=false;}
  return this.status();
 }
}
module.exports={UpdateController};
