// Original acceptance program. Uses the standard GBA interoperability header:
// https://github.com/devkitPro/gba-tools/blob/master/src/gbafix.c
// No commercial game, external BIOS, or game artwork.
exports.makeHomebrew=()=>{
 const header=Buffer.alloc(192);header.writeUInt32LE(0xea00002e,0);
 header.set(Buffer.from('24ffae51699aa2213d84820a84e409ad11248b98c0817f21a352be199309ce2010464a4af82731ec58c7e83382e3cebf85f4df94ce4b09c194568ac01372a7fc9f844d73a3ca9a615897a327fc039876231dc7610304ae56bf38840040a70efdff52fe036f9530f197fbc08560d68025a963be03014e38e2f9a234ffbb3e0344780090cb88113a9465c07c6387f03cafd625e48b380aac7221d4f807','hex'),4);
 header.write('OWNED DEMO  ',160,'ascii');header.write('DEMO00',172,'ascii');header[178]=0x96;header[189]=(-header.subarray(160,189).reduce((a,b)=>a+b,0)-0x19)&255;
 const code=[],loads=[],literals=[];const ldr=(reg,value)=>{let index=literals.indexOf(value);if(index<0){index=literals.length;literals.push(value);}loads.push([code.length,reg,index]);code.push(0);};
 ldr(0,0x04000000);ldr(1,0x403);code.push(0xe1c010b0);ldr(0,0x04000020);code.push(0xe3a01c01,0xe1c010b0,0xe1c010b6);ldr(0,0x06000000);ldr(2,38400);ldr(3,0x03e0);const loop=code.length;code.push(0xe0c030b2,0xe2522001);code.push(0x1a000000|((loop-(code.length+2))&0xffffff));code.push(0xeafffffe);
 for(const [index,reg,literal]of loads)code[index]=0xe59f0000|(reg<<12)|((code.length+literal-index-2)*4);
 const program=Buffer.alloc((code.length+literals.length)*4);[...code,...literals].forEach((n,i)=>program.writeUInt32LE(n>>>0,i*4));return Buffer.concat([header,program,Buffer.alloc(1024)]);
};
