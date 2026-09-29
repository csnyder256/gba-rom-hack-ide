const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),{UpdateController}=require('../update-controller.cjs');
class Updater extends EventEmitter{async checkForUpdates(){this.checks=(this.checks||0)+1;this.emit('update-available',{version:'0.3.1'});}async downloadUpdate(){this.downloads=(this.downloads||0)+1;this.emit('update-downloaded',{version:'0.3.1'});}quitAndInstall(){this.installs=(this.installs||0)+1;}}
test('check never downloads; only downloaded and confirmed updates install',async()=>{
 const u=new Updater();let confirm=false;const c=new UpdateController(u,{version:'0.3.0',enabled:true,confirmInstall:async()=>confirm});
 assert.equal(u.autoDownload,false);assert.equal(u.autoInstallOnAppQuit,false);assert.equal(u.allowDowngrade,false);assert.equal(u.allowPrerelease,false);
 await c.install();assert.equal(u.installs,undefined);await c.check();assert.equal(c.status().phase,'available');assert.equal(u.downloads,undefined);
 await c.download();assert.equal(c.status().phase,'downloaded');await c.install();assert.equal(u.installs,undefined);confirm=true;await c.install();assert.equal(u.installs,1);
});
test('failed signature/download cannot reach install and retry checks recover',async()=>{
 const u=new Updater();u.downloadUpdate=async()=>{throw new Error('checksum mismatch')};const c=new UpdateController(u,{version:'0.3.0',enabled:true,confirmInstall:async()=>true});await c.check();await c.download();assert.equal(c.status().phase,'error');await c.install();assert.equal(u.installs,undefined);await c.check();assert.equal(c.status().phase,'available');
});
test('disabled/source sessions never call provider',async()=>{
 const u=new Updater();const c=new UpdateController(u,{version:'0.3.0',enabled:false,reason:'Source build',confirmInstall:async()=>true});await c.check();await c.download();await c.install();assert.equal(u.checks,undefined);assert.equal(u.downloads,undefined);assert.equal(u.installs,undefined);
});
test('concurrent checks are single-flight and state copies cannot mutate controller',async()=>{
 let done;const u=new Updater();u.checkForUpdates=()=>new Promise(r=>{done=r});const c=new UpdateController(u,{version:'0.3.0',enabled:true,confirmInstall:async()=>false});const first=c.check();const state=await c.check();assert.equal(state.phase,'checking');state.currentVersion='bad';assert.equal(c.status().currentVersion,'0.3.0');done();await first;
});
