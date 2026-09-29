const {_electron,chromium}=require('playwright');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
(async()=>{
 const qa=path.resolve(process.env.DESKTOP_QA_DIR||await fs.mkdtemp(path.join(os.tmpdir(),'gba-desktop-qa-')));
 await fs.mkdir(qa,{recursive:true});
 const userData=path.join(qa,'profile'),fixture=path.join(qa,'fictional-project');await fs.mkdir(fixture,{recursive:true});
 await fs.writeFile(path.join(fixture,'README.md'),'Fictional desktop acceptance project. No ROM or copyrighted assets.');
 const app=await _electron.launch({executablePath:process.env.DESKTOP_APP||require('electron'),cwd:__dirname,args:process.env.DESKTOP_APP?['--no-sandbox','--use-angle=swiftshader']:['--no-sandbox','--use-angle=swiftshader','.'],env:{...process.env,GBA_DISABLE_UPDATE_CHECKS:'1',GBA_SMOKE_USER_DATA:userData}});
 let origin;
 try{
  const page=await app.firstWindow();await page.waitForLoadState('domcontentloaded');if(process.env.DESKTOP_CORE_DIAGNOSTIC)page.on('console',m=>console.log(m.text().slice(0,600)));
  await page.getByRole('button',{name:'Desktop updates',exact:true}).waitFor({timeout:60000});origin=new URL(page.url()).origin;
  const runtime=await page.evaluate(()=>({node:typeof require,process:typeof process,isolated:crossOriginIsolated,shared:typeof SharedArrayBuffer,bridge:Object.keys(window.GbaDesktop).sort()}));
  assert.equal(runtime.node,'undefined');assert.equal(runtime.process,'undefined');assert.equal(runtime.isolated,true);assert.equal(runtime.shared,'function');assert.deepEqual(runtime.bridge,['check','download','install','onStatus','status']);
  const prefs=await app.evaluate(({BrowserWindow})=>{const p=BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();return{sandbox:p.sandbox,contextIsolation:p.contextIsolation,nodeIntegration:p.nodeIntegration,webSecurity:p.webSecurity};});
  assert.deepEqual(prefs,{sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true});
  const denied=await fetch(origin+'/api/health');assert.equal(denied.status,401);
  const rejected=await app.evaluate(async({BrowserWindow})=>{
   const other=new BrowserWindow({show:false,webPreferences:{nodeIntegration:true,contextIsolation:false}});
   try{await other.loadURL('data:text/html,<title>controlled IPC sender probe</title>');return await other.webContents.executeJavaScript("require('electron').ipcRenderer.invoke('desktop:status').then(()=>false).catch(e=>e.message.includes('Untrusted desktop request'))");}finally{other.destroy();}
  });assert.equal(rejected,true);

  const health=await page.evaluate(async()=>{const r=await fetch('/api/health');return{status:r.status,body:await r.json()};});assert.equal(health.status,200);assert.equal(health.body.version,'0.3.0');
  // Run an original homebrew through the real core and verify its frame output.
  await page.getByRole('button',{name:'Desktop updates',exact:true}).click();await page.keyboard.press('Escape');
  const wasm=await page.evaluate(async(bytes)=>{
   const {default:factory}=await import('/api/emulator-engine/mgba.js');
   const canvas=document.createElement('canvas');canvas.width=240;canvas.height=160;canvas.id='desktop-acceptance-canvas';Object.assign(canvas.style,{position:'fixed',top:'20px',left:'20px',zIndex:'99999'});document.body.append(canvas);
   const emu=await factory({canvas,locateFile:(file,dir)=>file.endsWith('.wasm')?'/api/emulator-engine/mgba.wasm':dir+file});
   await emu.FSInit();emu.FS.writeFile('/data/games/owned-acceptance.gba',new Uint8Array(bytes));
   const loaded=emu.loadGame('/data/games/owned-acceptance.gba');let frames=0;emu.addCoreCallbacks({videoFrameEndedCallback:()=>{frames++;}});emu.resumeAudio();
   const until=Date.now()+15000;while(frames<30&&Date.now()<until)await new Promise(r=>setTimeout(r,50));
   const screenshot=emu.screenshot('owned-acceptance.png');const image=screenshot?Array.from(emu.FS.readFile('/data/screenshots/owned-acceptance.png')):[];
   const result={memory:emu.HEAPU8?.byteLength||0,loadGame:typeof emu.loadGame,buttonPress:typeof emu.buttonPress,loaded,frames,image};window.__desktopAcceptanceEmu=emu;return result;
  },Array.from(require('./test/homebrew.cjs').makeHomebrew()));assert.equal(wasm.loaded,true);assert.ok(wasm.frames>=30);assert.ok(wasm.image.length>0);
  await fs.writeFile(path.join(qa,'core.png'),Buffer.from(wasm.image));const rendered=await page.locator('#desktop-acceptance-canvas').screenshot();await fs.writeFile(path.join(qa,'rendered-frame.png'),rendered);const pixels=require('pngjs').PNG.sync.read(rendered).data;let green=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i+1]>180&&pixels[i]<30&&pixels[i+2]<30)green++;assert.ok(green>30000,'Original homebrew framebuffer did not render');delete wasm.image;wasm.greenPixels=green;await page.evaluate(()=>{window.__desktopAcceptanceEmu.quitGame();document.querySelector('#desktop-acceptance-canvas').remove();});
  assert.ok(wasm.memory>0);assert.equal(wasm.loadGame,'function');assert.equal(wasm.buttonPress,'function');
  const rootResponse=await page.request.get(origin+'/'); // browser API request context does not receive the Electron session token
  assert.equal(rootResponse.status(),401);
  await page.getByRole('button',{name:'Desktop updates',exact:true}).click();const panel=page.getByRole('dialog');
  await panel.getByText('Keep your workspace current.').waitFor();assert.match(await panel.textContent(),/Installed 0.3.0/);assert.equal(await panel.getByRole('button',{name:'Check for updates'}).isDisabled(),true);
  await page.keyboard.press('Escape');assert.equal(await panel.count(),0);assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'Desktop updates');
  await page.evaluate(()=>{window.location.href='https://example.com/';});await page.waitForTimeout(150);assert.equal(new URL(page.url()).origin,origin);
  const popup=await page.evaluate(()=>window.open('https://example.com/')===null);assert.equal(popup,true);
  // Exercise the real worker↔main picker exchange with a controlled choice,
  // then open its returned directory through the authenticated real API.
  await app.evaluate(({dialog},chosen)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[chosen]});},fixture);
  const opened=await page.evaluate(async()=>{const picked=await (await fetch('/api/dialogs/pick',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'folder'})})).json();const response=await fetch('/api/projects/open',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({projectRoot:picked.path})});return{picked,status:response.status,body:await response.json()};});
  assert.equal(opened.picked.path,fixture);assert.equal(opened.status,200);assert.equal(opened.body.session.projectRoot,fixture);
  await page.evaluate(()=>localStorage.setItem('__desktop_lifecycle_test__','kept'));
  await page.screenshot({path:path.join(qa,'desktop.png'),fullPage:true});
  await fs.writeFile(path.join(qa,'receipt.json'),JSON.stringify({runtime,prefs,health,wasm,untrustedIpcRejected:rejected,unauthenticatedStatus:denied.status,updatesDisabledForSmoke:true,navigationBlocked:true,popupBlocked:true,pickerExchange:'controlled native selection through actual worker/main messages',projectOpened:true,packaged:!!process.env.DESKTOP_APP},null,2));
  console.log('Desktop verified: real utility backend, authenticated loopback API, sandbox/Node isolation, SharedArrayBuffer, update UI, IPC origin checks, navigation/window guard and native picker exchange',qa);
 }finally{await app.close();}
 if(origin){
  await new Promise(r=>setTimeout(r,100));await assert.rejects(()=>fetch(origin+'/api/health'));console.log('Owned backend closed with desktop.');
  const next=await _electron.launch({executablePath:process.env.DESKTOP_APP||require('electron'),cwd:__dirname,args:process.env.DESKTOP_APP?['--no-sandbox','--use-angle=swiftshader']:['--no-sandbox','--use-angle=swiftshader','.'],env:{...process.env,GBA_DISABLE_UPDATE_CHECKS:'1',GBA_SMOKE_USER_DATA:userData}});
  try{const page=await next.firstWindow();await page.getByRole('button',{name:'Desktop updates',exact:true}).waitFor({timeout:60000});assert.equal(new URL(page.url()).origin,origin);assert.equal(await page.evaluate(()=>localStorage.getItem('__desktop_lifecycle_test__')),'kept');console.log('Workspace preferences survive restart on the stored local origin.');}finally{await next.close();}
 }
})().catch(e=>{console.error(e);process.exitCode=1});
