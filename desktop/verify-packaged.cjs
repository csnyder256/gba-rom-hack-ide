const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
let binary;
if(process.platform==='linux')binary=path.join(__dirname,'dist/linux-unpacked/gba-rom-hack-ide');
else if(process.platform==='win32')binary=path.join(__dirname,'dist/win-unpacked/GBA ROM Hack IDE.exe');
else{
 const folder=fs.readdirSync(path.join(__dirname,'dist')).find(x=>x==='mac'||x.startsWith('mac-'));
 if(!folder)throw new Error('Packaged macOS app missing');
 binary=path.join(__dirname,'dist',folder,'GBA ROM Hack IDE.app/Contents/MacOS/GBA ROM Hack IDE');
}
if(!fs.existsSync(binary))throw new Error('Packaged executable missing: '+binary);
execFileSync(process.execPath,[path.join(__dirname,'with-display.cjs')],{stdio:'inherit',env:{...process.env,DESKTOP_APP:binary}});
