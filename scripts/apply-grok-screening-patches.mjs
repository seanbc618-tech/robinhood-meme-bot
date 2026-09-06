#!/usr/bin/env node
/** Apply GROK_SCREENING_V1 patches to abc.mjs / abc-collect.mjs (pure JS, no patch(1)). */
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inflateSync} from 'node:zlib';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
function inflateB64(name){
  const p=resolve(root,'patches',name+'.zlib.b64');
  if(!existsSync(p)) throw new Error('missing '+p);
  return inflateSync(Buffer.from(readFileSync(p,'utf8'),'base64')).toString('utf8');
}
for(const f of ['abc.mjs','abc-collect.mjs']){
  const body=inflateB64(f);
  writeFileSync(resolve(root,f),body);
  console.log('wrote',f,body.length);
}
console.log('GROK_SCREENING_V1 patches applied');
