const test=require('node:test'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process'),path=require('node:path');
for(const platform of ['win','mac'])test(platform+' production signing fails without inputs',()=>{
 const env={...process.env};for(const key of ['CSC_LINK','CSC_KEY_PASSWORD','APPLE_ID','APPLE_APP_SPECIFIC_PASSWORD','APPLE_TEAM_ID'])delete env[key];
 const r=spawnSync(process.execPath,[path.join(__dirname,'../signing-preflight.cjs'),platform],{env,encoding:'utf8'});assert.equal(r.status,1);assert.match(r.stderr,/Missing input names/);
});
