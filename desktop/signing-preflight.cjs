const platform=process.argv[2];
const required=platform==='win'?['CSC_LINK','CSC_KEY_PASSWORD']:platform==='mac'?['CSC_LINK','CSC_KEY_PASSWORD','APPLE_ID','APPLE_APP_SPECIFIC_PASSWORD','APPLE_TEAM_ID']:null;
if(!required)throw new Error('Choose win or mac');
const missing=required.filter(name=>!process.env[name]);
if(missing.length){console.error('Production signing is not configured. Missing input names: '+missing.join(', '));process.exit(1);}
console.log('Required signing inputs are present. The builder must still sign and verify the output.');
