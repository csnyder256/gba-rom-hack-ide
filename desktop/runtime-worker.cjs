const path=require('node:path');
const fs=require('node:fs/promises');
const {pathToFileURL}=require('node:url');
let server,origin='',initializing=false,nextPick=0;
const pending=new Map();
const parent=process.parentPort;
function post(data){parent?.postMessage(data);}
function pick(kind){
 return new Promise(resolve=>{
  const id=++nextPick;
  const timer=setTimeout(()=>{pending.delete(id);resolve({kind,path:null,error:'picker_failed',message:'File selection timed out. Try again.'});},120000);
  pending.set(id,{resolve,timer,kind});post({type:'pick',id,kind});
 });
}
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.wasm':'application/wasm','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon','.woff2':'font/woff2','.map':'application/json'};
async function start(data){
 if(initializing)return;initializing=true;
 if(!path.isAbsolute(data.runtimeRoot)||!path.isAbsolute(data.managedRoot)||!/^[0-9a-f]{64}$/.test(data.token))throw new Error('Invalid runtime configuration');
 await fs.mkdir(data.managedRoot,{recursive:true});process.env.ROM_EDITOR_MANAGED_ROOT=data.managedRoot;
 const runtime=path.resolve(data.runtimeRoot),frontend=path.join(runtime,'app/frontend/dist');
 const {createServer}=await import(pathToFileURL(path.join(runtime,'app/backend/dist/server.js')).href);
 server=await createServer({logger:false,desktopSession:{token:data.token,origin:()=>origin,nativePicker:pick}});
 server.get('/*',async(req,reply)=>{
  let pathname;
  try{pathname=decodeURIComponent(new URL(req.raw.url,'http://localhost').pathname);}catch{return reply.code(400).send('Invalid path');}
  let file=path.resolve(frontend,'.'+pathname);
  if(file!==frontend&&!file.startsWith(frontend+path.sep))return reply.code(403).send('Invalid path');
  if(file===frontend||pathname.endsWith('/'))file=path.join(file,'index.html');
  let stat=await fs.stat(file).catch(()=>null);
  if(!stat?.isFile()&&!path.extname(pathname)){file=path.join(frontend,'index.html');stat=await fs.stat(file);}
  if(!stat?.isFile())return reply.code(404).send('Not found');
  reply.header('Cross-Origin-Opener-Policy','same-origin').header('Cross-Origin-Embedder-Policy','require-corp');
  reply.header('X-Content-Type-Options','nosniff');reply.header('Cache-Control',path.extname(file)==='.html'?'no-store':'public, max-age=3600');
  reply.header('Content-Security-Policy',"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self' "+origin.replace('http:','ws:')+"; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'self'");
  return reply.type(mime[path.extname(file)]||'application/octet-stream').send(await fs.readFile(file));
 });
 const preferredPort=Number.isInteger(data.preferredPort)&&data.preferredPort>1024&&data.preferredPort<65536?data.preferredPort:0;
 try{await server.listen({host:'127.0.0.1',port:preferredPort});}catch(error){if(error.code!=='EADDRINUSE'||!preferredPort)throw error;await server.listen({host:'127.0.0.1',port:0});}
 const address=server.server.address();origin='http://127.0.0.1:'+address.port;
 post({type:'ready',origin});
}
parent?.on('message',async e=>{
 const data=e.data;
 if(data?.type==='pick-result'){
  const request=pending.get(data.id);if(request){pending.delete(data.id);clearTimeout(request.timer);request.resolve({kind:request.kind,path:typeof data.path==='string'?data.path:null});}
 }else if(data?.type==='init'){
  try{await start(data);}catch{post({type:'startup-error',message:'The packaged backend could not start. Reinstall this release or use the source deployment.'});}
 }else if(data?.type==='shutdown'){
  for(const {resolve,timer,kind} of pending.values()){clearTimeout(timer);resolve({kind,path:null});}pending.clear();
  await server?.close().catch(()=>undefined);post({type:'stopped'});process.exit(0);
 }
});
