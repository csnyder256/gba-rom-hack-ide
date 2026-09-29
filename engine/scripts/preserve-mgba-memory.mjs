// mGBA 2.5.1 stopped exporting HEAPU8 from its Emscripten glue. The editor
// and headless memory readers need that existing surface. Backport only the
// export assignment to the exact verified upstream bytes; do not alter WASM.
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const workspace=path.resolve(process.argv[2]||process.cwd());
const require=createRequire(path.join(workspace,'package.json'));
const pkg=require.resolve('@thenick775/mgba-wasm/package.json');
if(JSON.parse(await readFile(pkg)).version!=='2.5.1')throw new Error('Review the mGBA memory adapter for the new dependency version');
const file=path.join(path.dirname(pkg),'dist/mgba.js'),bytes=await readFile(file),text=bytes.toString();
const expected='98e6f460fa2f95846bf79c3b1c42ecf3acca0ce11937ba0d4aa693438402a473';
const before='HEAPU8=new Uint8Array(b);',after='Module["HEAPU8"]=HEAPU8=new Uint8Array(b);';
const hash=b=>createHash('sha256').update(b).digest('hex');
if(text.includes(after)){
 if(hash(Buffer.from(text.replace(after,before)))!==expected)throw new Error('Unexpected adapted mGBA glue');
}else{
 if(hash(bytes)!==expected||text.split(before).length!==2)throw new Error('Unexpected upstream mGBA glue');
 await writeFile(file,text.replace(before,after));
}
console.log('Preserved mGBA 2.5.1 shared HEAPU8 export without changing the compiled core');
