const {spawn}=require('node:child_process');const path=require('node:path');
(async()=>{
 let display;
 try{
  let env={...process.env};
  if(process.platform==='linux'){
   display=spawn('Xvfb',['-displayfd','3','-screen','0','1600x1200x24','-nolisten','tcp'],{stdio:['ignore','ignore','pipe','pipe']});
   const number=await new Promise((resolve,reject)=>{let data='';const timeout=setTimeout(()=>reject(new Error('Xvfb did not become ready')),10000);display.once('error',reject);display.once('exit',()=>reject(new Error('Xvfb stopped')));display.stdio[3].on('data',chunk=>{data+=chunk;if(data.includes('\n')){clearTimeout(timeout);resolve(data.trim());}});});
   env.DISPLAY=':'+number;
  }
  const fixture=process.argv[2]==='--provider-fixture';
  const child=spawn(fixture?require('electron'):process.execPath,fixture?['--no-sandbox',path.join(__dirname,'test/provider-fixture.cjs')]:[path.join(__dirname,'verify.cjs')],{stdio:'inherit',env});
  process.exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code??1));});
 }finally{display?.kill('SIGTERM');}
})().catch(e=>{console.error(e);process.exitCode=1});
