import {cp,rm,mkdir,readFile,readdir,lstat,realpath} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const desktop=path.dirname(fileURLToPath(import.meta.url)),root=path.dirname(desktop),stage=path.join(desktop,'stage/runtime');
const version=(await readFile(path.join(root,'VERSION'),'utf8')).trim();
if(JSON.parse(await readFile(path.join(desktop,'package.json'))).version!==version)throw new Error('Desktop version differs');
await rm(path.dirname(stage),{recursive:true,force:true});await mkdir(stage,{recursive:true});
for(const folder of ['engine/dist','app/shared/dist','app/backend/dist','app/frontend/dist','app/backend/src/assets','signatures','symbols']){
 await cp(path.join(root,folder),path.join(stage,folder),{recursive:true,dereference:true});
}
for(const file of ['LICENSE','VERSION','engine/package.json','engine/package-lock.json','app/package.json','app/package-lock.json','app/backend/package.json','app/frontend/package.json','app/shared/package.json']){
 const dst=path.join(stage,file);await mkdir(path.dirname(dst),{recursive:true});await cp(path.join(root,file),dst);
}
for(const folder of ['engine','app']){
 const options={cwd:path.join(stage,folder),stdio:'inherit'};
 // Windows batch entrypoints require cmd.exe; keep the command fixed and
 // pass the working directory separately so no path enters shell text.
 if(process.platform==='win32')execFileSync(process.env.ComSpec||'cmd.exe',['/d','/s','/c','npm ci --omit=dev --ignore-scripts --no-audit --no-fund'],options);
 else execFileSync('npm',['ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],options);
}
for(const folder of ['engine','app/backend'])execFileSync(process.execPath,[path.join(root,'engine/scripts/preserve-mgba-memory.mjs'),path.join(stage,folder)],{stdio:'inherit'});
// Resources live outside asar; materialize npm workspace/file links so every
// release contains the same self-contained runtime layout on all platforms.
async function materialize(dir){
 for(const entry of await readdir(dir,{withFileTypes:true})){
  const file=path.join(dir,entry.name);
  if(entry.isSymbolicLink()){
   const target=await realpath(file);if(!target.startsWith(stage+path.sep))throw new Error('Runtime link escapes stage');
   const tmp=file+'.materialized';await cp(target,tmp,{recursive:true,dereference:true});await rm(file);await cp(tmp,file,{recursive:true});await rm(tmp,{recursive:true});
  }else if(entry.isDirectory())await materialize(file);
 }
}
await materialize(stage);
console.log('Staged self-contained desktop runtime',version);
