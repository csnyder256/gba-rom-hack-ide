const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const platform=process.argv[2],bundle=process.argv[3],out=path.join(__dirname,'release-assets');
if(!['linux','win','mac'].includes(platform)||!bundle||!fs.existsSync(bundle))throw new Error('Attestation bundle required');
fs.copyFileSync(bundle,path.join(out,'desktop-attestation-'+platform+'.jsonl'));
const checksum='desktop-checksums-'+platform+'.txt';
const files=fs.readdirSync(out).filter(name=>name!==checksum).sort();
fs.writeFileSync(path.join(out,checksum),files.map(name=>crypto.createHash('sha256').update(fs.readFileSync(path.join(out,name))).digest('hex')+'  '+name+'\n').join(''));
console.log('Finalized signed-provenance desktop assets',platform,files.length);
